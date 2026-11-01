import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPage, runScan } from '../scanner.js';

const origin = 'https://src.sjtu.edu.cn';
const stateFor = (end = 5) => ({ gifts: {}, job: { start: 1, end, nextId: 1, errors: {}, processed: 0, found: 0, missing: 0, retryAt: null } });
const parseDetail = (html, id, checkedAt) => ({ id, name: html, stock: 0, price: 10, certificate: true, checkedAt });
const response = (status = 200, body = '<html>证书</html>', headers = { 'Content-Type': 'text/html; charset=utf-8' }) => new Response(body, { status, headers });

test('requestPage allows only intended public endpoints and omits credentials', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push([url, options]); return response(); };
  assert.equal((await requestPage(`${origin}/gift/1/`, { fetchImpl })).missing, false);
  await requestPage(`${origin}/gift/?page=2&gift_type=certificate&order=0`, { fetchImpl });
  assert.equal(seen[0][1].credentials, 'omit');
  assert.equal(seen[0][1].redirect, 'error');
  assert.equal(seen[0][1].cache, 'no-store');
  assert.ok(seen[0][1].signal instanceof AbortSignal);
  for (const url of [
    'https://evil.test/gift/1/', `${origin}/vuln/`, `${origin}/gift/0/`, `${origin}/gift/100001/`,
    `${origin}/gift/1/?page=2`, `${origin}/gift/?redirect=x`, `${origin}/gift/?page=1&page=2`,
    `${origin}/gift/?gift_type=evil`, `${origin}/gift/?order=8`, `${origin}/gift/?page=0`,
    'http://src.sjtu.edu.cn/gift/1/', 'https://u@src.sjtu.edu.cn/gift/1/',
  ]) await assert.rejects(requestPage(url, { fetchImpl }));
  assert.equal(seen.length, 2);
});

test('requestPage separates missing pages, HTTP failures, and unexpected content', async () => {
  for (const status of [404, 410]) {
    assert.equal((await requestPage(`${origin}/gift/1/`, { fetchImpl: async () => response(status) })).missing, true);
  }
  for (const status of [401, 403, 429]) {
    const start = Date.now();
    await assert.rejects(requestPage(`${origin}/gift/1/`, { fetchImpl: async () => response(status) }), error => {
      assert.equal(error.status, status);
      assert.equal(error.pause, true);
      if (status === 429) assert.ok(Date.parse(error.retryAt) >= start + 59000);
      return true;
    });
  }
  await assert.rejects(requestPage(`${origin}/gift/1/`, { fetchImpl: async () => response(503) }), error => error.status === 503 && !error.pause);
  await assert.rejects(requestPage(`${origin}/gift/1/`, { fetchImpl: async () => response(200, '{}', { 'Content-Type': 'application/json' }) }), /不是 HTML/u);
});

test('Retry-After seconds and dates are preserved', async () => {
  const start = Date.now();
  await assert.rejects(requestPage(`${origin}/gift/1/`, { fetchImpl: async () => response(429, '', { 'Retry-After': '120' }) }), error => Date.parse(error.retryAt) >= start + 119000);
  const date = new Date(Date.now() + 240000).toUTCString();
  await assert.rejects(requestPage(`${origin}/gift/1/`, { fetchImpl: async () => response(429, '', { 'Retry-After': date }) }), error => error.retryAt === new Date(date).toISOString());
});

test('timeouts and external aborts do not become missing records', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(requestPage(`${origin}/gift/1/`, { fetchImpl, timeoutMs: 5 }), /超时/u);
  const controller = new AbortController();
  const pending = requestPage(`${origin}/gift/1/`, { fetchImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('scan preserves zero stock, continues past 404, and persists before notifying', async () => {
  const state = stateFor(3);
  state.gifts[2] = { id: 2, stock: 3 };
  state.job.errors[1] = 'old failure';
  const checkpoints = [];
  const events = [];
  await runScan({ state, ids: [1, 2, 3], parseDetail, concurrency: 1, intervalMs: 0,
    request: async url => { const id = Number(url.match(/(\d+)\/$/u)[1]); events.push(`request:${id}`); return id === 2 ? { missing: true } : { missing: false, html: `礼品${id}` }; },
    persist: async value => { checkpoints.push(structuredClone(value)); events.push(`persist:${value.job.nextId}`); },
    onProgress: value => events.push(`notify:${value.job.nextId}`), now: () => '2026-11-01T00:00:00Z',
  });
  assert.equal(state.gifts[1].stock, 0);
  assert.equal(state.gifts[2], undefined);
  assert.equal(state.gifts[3].checkedAt, '2026-11-01T00:00:00Z');
  assert.deepEqual(state.job.errors, {});
  assert.equal(state.job.nextId, 4);
  assert.equal(state.job.processed, 3);
  assert.equal(state.job.found, 2);
  assert.equal(state.job.missing, 1);
  assert.deepEqual(checkpoints.map(value => value.job.nextId), [2, 3, 4]);
  assert.deepEqual(events, ['request:1','persist:2','notify:2','request:2','persist:3','notify:3','request:3','persist:4','notify:4']);
});

test('429 preserves cursor and stores cooldown before stopping', async () => {
  const state = stateFor();
  const error = Object.assign(new Error('限流'), { pause: true, status: 429, retryAt: '2026-11-01T01:00:00Z' });
  const checkpoints = [];
  await assert.rejects(runScan({ state, ids: [1,2], parseDetail, concurrency: 1, intervalMs: 0,
    request: async () => { throw error; }, persist: async value => checkpoints.push(structuredClone(value)),
  }), value => value === error);
  assert.equal(state.job.nextId, 1);
  assert.equal(state.job.processed, 0);
  assert.equal(state.job.retryAt, error.retryAt);
  assert.equal(checkpoints[0].job.errors[1], '限流');
});

test('three consecutive ordinary failures advance and persist their IDs before pausing', async () => {
  const state = stateFor();
  const visited = [];
  const checkpoints = [];
  await assert.rejects(runScan({ state, ids: [1,2,3,4], parseDetail, concurrency: 1, intervalMs: 0,
    request: async url => { visited.push(url); throw new Error('网络失败'); },
    persist: async value => checkpoints.push(structuredClone(value)),
  }), error => error.pause === true && error.code === 'CONSECUTIVE_ERRORS');
  assert.equal(visited.length, 3);
  assert.equal(state.job.nextId, 4);
  assert.equal(state.job.processed, 3);
  assert.equal(checkpoints.at(-1).job.nextId, 4);
  assert.deepEqual(Object.keys(state.job.errors), ['1','2','3']);
});

test('retrying an older failed ID does not rewind the existing cursor', async () => {
  const state = stateFor();
  state.job.nextId = 6;
  state.job.errors[2] = '网络失败';
  await runScan({ state, ids: [2], parseDetail, concurrency: 1, intervalMs: 0,
    request: async () => ({ missing: false, html: '补充证书' }), persist: async () => {},
  });
  assert.equal(state.job.nextId, 6);
  assert.equal(state.gifts[2].stock, 0);
  assert.deepEqual(state.job.errors, {});
});

test('abort during inter-request delay leaves next ID untouched', async () => {
  const state = stateFor();
  const controller = new AbortController();
  let requested = 0;
  const pending = runScan({ state, ids: [1,2], parseDetail, concurrency: 1, intervalMs: 10000, signal: controller.signal,
    request: async () => { requested++; return { missing: false, html: '证书' }; },
    persist: async () => {}, onProgress: () => { setTimeout(() => controller.abort(), 5); },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requested, 1);
  assert.equal(state.job.nextId, 2);
  assert.equal(state.job.processed, 1);
});

test('out-of-range IDs are rejected before any requests', async () => {
  const state = stateFor();
  let requested = false;
  await assert.rejects(runScan({ state, ids: [6], parseDetail,
    request: async () => { requested = true; }, persist: async () => {},
  }), /超出任务范围/u);
  assert.equal(requested, false);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const idFrom = url => Number(url.match(/(\d+)\/$/u)[1]);
const abortedRequest = (signal, onAbort = () => {}) => new Promise((_resolve, reject) => {
  const cancel = () => { onAbort(); reject(new DOMException('cancelled', 'AbortError')); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
});

test('bounded concurrency starts multiple requests and never exceeds its configured limit', async () => {
  const state = stateFor(9);
  let inFlight = 0;
  let maximum = 0;
  await runScan({ state, ids: [1,2,3,4,5,6,7,8,9], parseDetail, concurrency: 3, intervalMs: 0,
    request: async () => {
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      await delay(10);
      inFlight--;
      return { missing: false, html: '证书' };
    }, persist: async () => {},
  });
  assert.equal(maximum, 3);
  assert.equal(state.job.checked, 9);
  assert.equal(state.job.nextId, 10);
  assert.deepEqual(state.job.completedIds, []);
});

test('default 10ms dispatch spacing applies globally across all eight workers', async () => {
  const state = stateFor(5);
  const starts = [];
  let inFlight = 0;
  let maximum = 0;
  await runScan({ state, ids: [1,2,3,4,5], parseDetail,
    request: async () => {
      starts.push(performance.now());
      maximum = Math.max(maximum, ++inFlight);
      await delay(70);
      inFlight--;
      return { missing: false, html: '证书' };
    }, persist: async () => {},
  });
  assert.ok(maximum > 1, 'requests should overlap');
  for (let index = 1; index < starts.length; index++) {
    assert.ok(starts[index] - starts[index - 1] >= 9.9, `global start gap ${starts[index] - starts[index - 1]}ms`);
  }
});

test('out-of-order completion preserves a gap and resume fetches every remaining ID exactly once', async () => {
  const state = stateFor(5);
  const controller = new AbortController();
  const snapshots = [];
  await assert.rejects(runScan({ state, ids: [1,2,3], parseDetail, concurrency: 3, intervalMs: 0, signal: controller.signal,
    request: async (url, { signal }) => {
      const id = idFrom(url);
      if (id === 1) return abortedRequest(signal);
      await delay(id === 2 ? 10 : 5);
      return { missing: false, html: `证书${id}` };
    }, persist: async value => snapshots.push(structuredClone(value)),
    onProgress: value => { if (value.job.checked === 2) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(state.job.nextId, 1);
  assert.equal(state.job.checked, 2);
  assert.deepEqual(state.job.completedIds, [2,3]);
  assert.deepEqual(snapshots.at(-1).job.completedIds, [2,3]);
  const restored = structuredClone(snapshots.at(-1));
  const skip = new Set(restored.job.completedIds);
  const remaining = Array.from({ length: restored.job.end - restored.job.nextId + 1 }, (_, i) => restored.job.nextId + i).filter(id => !skip.has(id));
  const fetched = [];
  await runScan({ state: restored, ids: remaining, parseDetail, concurrency: 3, intervalMs: 0,
    request: async url => { fetched.push(idFrom(url)); return { missing: false, html: '恢复证书' }; }, persist: async () => {},
  });
  assert.deepEqual(fetched, [1,4,5]);
  assert.equal(restored.job.nextId, 6);
  assert.equal(restored.job.checked, 5);
  assert.deepEqual(restored.job.completedIds, []);
  assert.deepEqual(Object.keys(restored.gifts), ['1','2','3','4','5']);
});

test('429 immediately cancels other in-flight requests and waits for its cooldown checkpoint', async () => {
  const state = stateFor();
  const error = Object.assign(new Error('限流'), { pause: true, status: 429, retryAt: '2026-11-01T01:00:00Z' });
  const starts = [];
  const cancelled = [];
  let saved = false;
  await assert.rejects(runScan({ state, ids: [1,2,3,4,5], parseDetail, concurrency: 3, intervalMs: 0,
    request: async (url, { signal }) => {
      const id = idFrom(url);
      starts.push(id);
      if (id === 1) { await delay(5); throw error; }
      return abortedRequest(signal, () => cancelled.push(id));
    }, persist: async () => { await delay(10); saved = true; },
  }), value => value === error);
  assert.deepEqual(starts, [1,2,3]);
  assert.deepEqual(cancelled.sort(), [2,3]);
  assert.equal(saved, true);
  assert.equal(state.job.nextId, 1);
  assert.equal(state.job.checked, 0);
  assert.equal(state.job.processed, 0);
  assert.equal(state.job.retryAt, error.retryAt);
  assert.equal(state.job.errors[1], '限流');
});

test('external abort cancels every in-flight request without skipping unfinished IDs', async () => {
  const state = stateFor();
  const controller = new AbortController();
  const starts = [];
  const cancelled = [];
  const pending = runScan({ state, ids: [1,2,3,4,5], parseDetail, concurrency: 3, intervalMs: 0, signal: controller.signal,
    request: (url, { signal }) => {
      const id = idFrom(url);
      starts.push(id);
      return abortedRequest(signal, () => cancelled.push(id));
    }, persist: async () => assert.fail('aborted requests must not be committed'),
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(starts, [1,2,3]);
  assert.deepEqual(cancelled, [1,2,3]);
  assert.equal(state.job.nextId, 1);
  assert.equal(state.job.checked, 0);
  assert.deepEqual(state.job.completedIds, []);
});

test('all state mutations, writes, and progress notifications remain serialized', async () => {
  const state = stateFor(8);
  let writing = false;
  let writes = 0;
  let notified = 0;
  const checkpoints = [];
  await runScan({ state, ids: [1,2,3,4,5,6,7,8], parseDetail, concurrency: 6, intervalMs: 0,
    request: async url => { await delay(idFrom(url) === 1 ? 20 : 1); return { missing: false, html: '证书' }; },
    persist: async value => {
      assert.equal(writing, false, 'storage writes must not overlap');
      writing = true;
      const before = JSON.stringify(value);
      await delay(5);
      assert.equal(JSON.stringify(value), before, 'state must not mutate during a pending storage write');
      checkpoints.push(structuredClone(value));
      writes++;
      writing = false;
    }, onProgress: () => {
      assert.equal(writing, false);
      assert.equal(writes, notified + 1);
      notified++;
    },
  });
  assert.equal(writes, 8);
  assert.equal(notified, 8);
  assert.deepEqual(checkpoints.map(value => value.job.checked), [1,2,3,4,5,6,7,8]);
  assert.equal(checkpoints.at(-1).job.nextId, 9);
});

test('retries increment attempts while the unique checked count remains unchanged', async () => {
  const state = stateFor(2);
  await runScan({ state, ids: [1,2], parseDetail, concurrency: 1, intervalMs: 0,
    request: async url => { if (idFrom(url) === 1) throw new Error('失败'); return { missing: false, html: '证书' }; },
    persist: async () => {},
  });
  assert.equal(state.job.checked, 2);
  assert.equal(state.job.processed, 2);
  await runScan({ state, ids: [1], parseDetail, intervalMs: 0,
    request: async () => ({ missing: false, html: '已恢复' }), persist: async () => {},
  });
  assert.equal(state.job.checked, 2);
  assert.equal(state.job.processed, 3);
  assert.equal(state.job.nextId, 3);
  assert.deepEqual(state.job.errors, {});
});

test('three failures use completion order and preserve earlier unresolved gaps', async () => {
  const state = stateFor();
  const cancelled = [];
  await assert.rejects(runScan({ state, ids: [1,2,3,4,5], parseDetail, concurrency: 4, intervalMs: 0,
    request: async (url, { signal }) => {
      const id = idFrom(url);
      if (id === 1 || id === 5) return abortedRequest(signal, () => cancelled.push(id));
      await delay(({ 2: 10, 3: 15, 4: 5 })[id]);
      throw new Error(`失败${id}`);
    }, persist: async () => {},
  }), error => error.code === 'CONSECUTIVE_ERRORS');
  assert.ok(cancelled.includes(1));
  assert.equal(state.job.nextId, 1);
  assert.equal(state.job.checked, 3);
  assert.deepEqual(state.job.completedIds, [2,3,4]);
  assert.deepEqual(Object.keys(state.job.errors), ['2','3','4']);
});

test('storage failure cancels in-flight work and is not swallowed', async () => {
  const state = stateFor();
  const storageError = new Error('storage quota failure');
  const cancelled = [];
  await assert.rejects(runScan({ state, ids: [1,2,3,4], parseDetail, concurrency: 3, intervalMs: 0,
    request: async (url, { signal }) => {
      const id = idFrom(url);
      if (id === 1) { await delay(5); return { missing: false, html: '证书' }; }
      return abortedRequest(signal, () => cancelled.push(id));
    }, persist: async () => { throw storageError; },
  }), error => error === storageError);
  assert.deepEqual(cancelled, [2,3]);
});

test('duplicate IDs and invalid concurrency are rejected before dispatch', async () => {
  const options = { state: stateFor(), ids: [1,2], parseDetail,
    request: () => assert.fail('must not dispatch'), persist: async () => {},
  };
  for (const concurrency of [0,33,1.5,NaN]) await assert.rejects(runScan({ ...options, concurrency }), /并发数/u);
  await assert.rejects(runScan({ ...options, ids: [1,1] }), /重复 ID/u);
});
