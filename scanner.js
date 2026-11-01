import { ORIGIN, MAX_ID } from './core.js';

function abortError() {
  return new DOMException('扫描已暂停。', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function checkedUrl(input) {
  const url = new URL(input);
  if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('只允许访问 EDUSRC 的 HTTPS 公开礼品页面。');
  }
  if (url.pathname === '/gift/') {
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
      if (seen.has(key)) throw new Error('列表参数不能重复。');
      seen.add(key);
      const valid = (key === 'page' && /^[1-9]\d*$/u.test(value) && Number(value) <= MAX_ID)
        || (key === 'gift_type' && ['certificate', 'tangible_gift'].includes(value))
        || (key === 'order' && ['0', '1', '2'].includes(value));
      if (!valid) throw new Error('礼品列表包含不支持的查询参数。');
    }
  } else {
    const match = url.pathname.match(/^\/gift\/([1-9]\d*)\/?$/u);
    if (!match || Number(match[1]) > MAX_ID || url.search) throw new Error('不是有效的公开礼品详情地址。');
  }
  return url.href;
}

function httpError(status, retryAfter) {
  const messages = {
    401: '网站要求登录，扫描已暂停。请在官网检查访问状态后再继续。',
    403: '网站拒绝访问，扫描已暂停。请稍后检查官网能否正常访问。',
    429: '网站请求限流，扫描已暂停。请等待冷却时间后再继续。',
  };
  const error = new Error(messages[status] ?? `请求失败（HTTP ${status}）。`);
  error.code = `HTTP_${status}`;
  error.status = status;
  if ([401, 403, 429].includes(status)) {
    error.pause = true;
    error.retryAt = null;
    if (status === 429) {
      const current = Date.now();
      let target = current + 60000;
      const raw = String(retryAfter ?? '').trim();
      if (/^\d+(?:\.\d+)?$/u.test(raw)) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds <= 31536000) target = current + seconds * 1000;
      } else if (raw && Number.isFinite(Date.parse(raw))) {
        target = Math.max(current, Date.parse(raw));
      }
      error.retryAt = new Date(target).toISOString();
    }
  }
  return error;
}

/** Fetch only public gift HTML, without sending browser login cookies. */
export async function requestPage(url, { signal, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const target = checkedUrl(url);
  throwIfAborted(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('请求超时必须是正数。');
  const controller = new AbortController();
  let timedOut = false;
  const externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(target, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: controller.signal,
    });
    throwIfAborted(signal);
    // Redirects are disabled above; this also guards unusual fetch adapters.
    if (response.redirected) throw new Error('礼品页面发生跳转，已停止读取该页面。');
    if ([404, 410].includes(response.status)) return { missing: true, url: target };
    if (!response.ok) throw httpError(response.status, response.headers.get('Retry-After'));
    if (!/^text\/html(?:\s*;|\s*$)/iu.test(response.headers.get('Content-Type') ?? '')) {
      throw new Error('网站返回的内容不是 HTML 页面，未写入礼品索引。');
    }
    const html = await response.text();
    throwIfAborted(signal);
    return { missing: false, html, url: target };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error('读取礼品页面超时，请稍后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', externalAbort);
  }
}

function waitInterval(milliseconds, signal) {
  throwIfAborted(signal);
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(abortError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

/** Bounded concurrency with one global dispatcher and a serialized commit chain. */
export async function runScan({
  state, ids, parseDetail, request = requestPage, persist,
  onProgress = () => {}, signal, intervalMs = 10, concurrency = 8,
  now = () => new Date().toISOString(),
}) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length
    || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > MAX_ID
      || id < state.job.start || id > state.job.end)) {
    throw new Error('扫描 ID 超出任务范围，或存在重复 ID。');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('扫描间隔必须是非负数。');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('并发数必须是 1 到 32 的整数。');
  }
  throwIfAborted(signal);
  const job = state.job;
  const completed = new Set((job.completedIds ?? []).filter(id => Number.isSafeInteger(id)
    && id >= job.nextId && id >= job.start && id <= job.end));
  // Old sequential checkpoints already completed every ID before nextId.
  while (completed.delete(job.nextId)) job.nextId++;
  job.completedIds = [...completed].sort((a, b) => a - b);
  job.checked = Math.max(0, Math.min(job.end + 1, job.nextId) - job.start) + completed.size;

  const controller = new AbortController();
  let fatalError = null;
  let consecutiveErrors = 0;
  let commitTail = Promise.resolve();
  let lastStart = -Infinity;
  const active = new Set();
  const halt = (error, force = false) => {
    if (!fatalError || force) fatalError = error && typeof error === 'object'
      ? error : new Error(String(error ?? '扫描失败。'));
    controller.abort();
  };
  const externalAbort = () => halt(abortError());
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();

  const markChecked = id => {
    if (id >= job.nextId) completed.add(id);
    while (completed.delete(job.nextId)) job.nextId++;
    job.completedIds = [...completed].sort((a, b) => a - b);
    // Derive from unique IDs instead of incrementing attempts on retries.
    job.checked = Math.max(0, Math.min(job.end + 1, job.nextId) - job.start) + completed.size;
  };
  const enqueueCommit = (id, outcome) => {
    commitTail = commitTail.then(async () => {
      if (outcome.pause) {
        job.retryAt = outcome.error.retryAt ?? null;
        job.errors[id] = outcome.error.message;
      } else {
        if (outcome.error) {
          job.errors[id] = outcome.error.message ?? String(outcome.error);
          consecutiveErrors++;
        } else {
          consecutiveErrors = 0;
          delete job.errors[id];
          if (outcome.missing) {
            delete state.gifts[id];
            job.missing++;
          } else {
            state.gifts[id] = outcome.record;
            job.found++;
          }
        }
        markChecked(id);
        job.processed++;
        if (!fatalError?.retryAt) job.retryAt = null;
        if (consecutiveErrors >= 3 && !fatalError) {
          const error = new Error('连续 3 个页面读取失败，扫描已暂停。请检查网络或页面结构后重试失败项。');
          error.pause = true;
          error.code = 'CONSECUTIVE_ERRORS';
          error.retryAt = null;
          halt(error);
        }
      }
      // No other task can mutate state while this asynchronous write is pending.
      await persist(state);
      await onProgress(state);
    });
    // Observe rejection immediately, while keeping the rejected chain intact.
    commitTail.catch(error => halt(error, true));
    return commitTail;
  };

  const execute = async id => {
    let outcome;
    try {
      const result = await request(`${ORIGIN}/gift/${id}/`, { signal: controller.signal });
      throwIfAborted(controller.signal);
      const record = result.missing ? null : await parseDetail(result.html, id, now());
      throwIfAborted(controller.signal);
      outcome = { missing: result.missing, record };
    } catch (error) {
      // A cancelled in-flight ID remains a gap and will be fetched on resume.
      if (controller.signal.aborted) return;
      if (error?.pause) {
        halt(error);
        outcome = { pause: true, error };
      } else if (error?.name === 'AbortError') {
        halt(abortError());
        return;
      } else {
        outcome = { error: error && typeof error === 'object' ? error : new Error(String(error ?? '页面读取失败。')) };
      }
    }
    try {
      await enqueueCommit(id, outcome);
    } catch (error) {
      // Persistence/progress failures take precedence over HTTP pause errors.
      halt(error, true);
    }
  };

  try {
    for (const id of ids) {
      while (!fatalError && active.size >= concurrency) await Promise.race(active);
      if (fatalError) break;
      // One dispatcher enforces the interval across all workers, not per worker.
      let remaining = lastStart + intervalMs - performance.now();
      while (!fatalError && remaining > 0) {
        await waitInterval(Math.ceil(remaining), controller.signal);
        remaining = lastStart + intervalMs - performance.now();
      }
      if (fatalError) break;
      const operation = execute(id);
      lastStart = performance.now();
      active.add(operation);
      operation.finally(() => active.delete(operation));
    }
  } catch (error) {
    if (!fatalError) halt(error);
  } finally {
    // Drain every worker and storage operation before exposing the final state.
    await Promise.allSettled([...active]);
    try {
      await commitTail;
    } catch (error) {
      halt(error, true);
    }
    signal?.removeEventListener('abort', externalAbort);
  }
  if (fatalError) throw fatalError;
  return state;
}
