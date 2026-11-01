import { ORIGIN, MAX_ID, parseId, validateRange, queryGifts, csv } from './core.js';
import { giftUrl, parseDetail, parseListing } from './parser.js';
import { requestPage, runScan } from './scanner.js';

const KEY = 'edusrc-gift-index-v1';
const $ = id => document.getElementById(id);
const INTERVALS = [10, 50, 100, 250, 500, 1000, 2000, 3000];
const CONCURRENCY = [1, 2, 4, 8, 16, 32];
const fresh = () => ({ version: 1, gifts: {}, job: null, settings: { start: 1, end: 500, interval: 10, concurrency: 8, schedulerVersion: 2 }, updatedAt: null, retryAt: null });
let state = fresh();
let busy = false;
let scanning = false;
let controller = null;
let limit = 40;
let filtered = [];
let renderTimer = null;

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}

function date(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

async function readState() {
  const data = (await chrome.storage.local.get(KEY))[KEY];
  if (!(data?.version === 1 && data.gifts && typeof data.gifts === 'object')) return fresh();
  data.settings ??= {};
  // Existing installations adopt the faster defaults once, while retaining their index.
  if (data.settings.schedulerVersion !== 2) {
    data.settings = { ...fresh().settings, ...data.settings, interval: 10, concurrency: 8, schedulerVersion: 2 };
  }
  if (!INTERVALS.includes(data.settings.interval)) data.settings.interval = 10;
  if (!CONCURRENCY.includes(data.settings.concurrency)) data.settings.concurrency = 8;
  if (data.job) {
    data.job.completedIds = [...new Set(data.job.completedIds ?? [])].filter(id => Number.isSafeInteger(id) && id >= data.job.nextId && id <= data.job.end);
    data.job.checked = Math.min(data.job.end - data.job.start + 1, Math.max(0, data.job.nextId - data.job.start) + data.job.completedIds.length);
  }
  return data;
}

async function persist() {
  state.updatedAt = new Date().toISOString();
  if (state.job) state.job.updatedAt = state.updatedAt;
  try {
    await chrome.storage.local.set({ [KEY]: state });
  } catch (cause) {
    throw new Error(`保存本地索引失败，已停止操作。${cause.message || ''}`);
  }
}

function checkCooldown() {
  const until = Math.max(Date.parse(state.retryAt) || 0, Date.parse(state.job?.retryAt) || 0);
  if (until > Date.now()) throw new Error(`网站要求暂缓请求，请在 ${date(until)} 后继续。`);
}

// One writer across all extension tabs; acquiring a lock also reloads the latest snapshot.
async function operation(fn) {
  if (busy) return;
  busy = true;
  controller = new AbortController();
  notice('');
  renderControls();
  try {
    await navigator.locks.request('edusrc-public-gift-index', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个搜索标签页正在更新索引，请在该标签页操作，或等待其暂停。');
      state = await readState();
      checkCooldown();
      try {
        await fn(controller.signal);
      } catch (error) {
        if (error.retryAt) { state.retryAt = error.retryAt; await persist(); }
        throw error;
      }
    });
  } catch (error) {
    notice(error.name === 'AbortError' ? '操作已暂停，已保存完成的项目。' : error.message, error.name !== 'AbortError');
  } finally {
    busy = false;
    scanning = false;
    controller = null;
    render();
  }
}

async function scan(ids, signal) {
  scanning = true;
  state.job.status = 'running';
  await persist();
  render();
  try {
    await runScan({ state, ids, parseDetail, persist, signal,
      intervalMs: state.settings.interval,
      concurrency: state.settings.concurrency,
      onProgress: scheduleRender,
    });
    state.job.status = state.job.nextId > state.job.end ? 'complete' : 'paused';
    const failures = Object.keys(state.job.errors).length;
    notice(failures ? `本轮读取已结束；还有 ${failures} 个失败项未确认，请点击「重试失败项」。` : '本轮读取已完成。零库存礼品已包含在搜索结果中。', failures > 0);
  } catch (error) {
    state.job.status = 'paused';
    notice(error.name === 'AbortError' ? '已暂停。已完成的项目已保存，可随时继续。' : error.message, error.name !== 'AbortError');
  } finally {
    await persist();
  }
}

function remainingIds(job) {
  const completed = new Set(job.completedIds ?? []);
  return Array.from({ length: Math.max(0, job.end - job.nextId + 1) }, (_, offset) => job.nextId + offset).filter(id => !completed.has(id));
}

function readSpeedSettings() {
  const interval = Number($('interval').value);
  const concurrency = Number($('concurrency').value);
  if (!INTERVALS.includes(interval)) throw new Error('请选择有效的请求间隔。');
  if (!CONCURRENCY.includes(concurrency)) throw new Error('请选择有效的并发数。');
  return { interval, concurrency, schedulerVersion: 2 };
}

function readSettings() {
  const { start, end } = validateRange($('start-id').value, $('end-id').value);
  return { start, end, ...readSpeedSettings() };
}

$('start').addEventListener('click', () => {
  let settings;
  try { settings = readSettings(); } catch (error) { notice(error.message, true); return; }
  operation(async signal => {
    state.settings = settings;
    const { start, end } = settings;
    state.job = { start, end, nextId: start, completedIds: [], checked: 0, errors: {}, processed: 0, found: 0, missing: 0,
      status: 'running', startedAt: new Date().toISOString(), retryAt: null };
    await scan(remainingIds(state.job), signal);
  });
});

$('resume').addEventListener('click', () => operation(async signal => {
  if (!state.job || state.job.nextId > state.job.end) return;
  Object.assign(state.settings, readSpeedSettings());
  await scan(remainingIds(state.job), signal);
}));

$('retry').addEventListener('click', () => operation(async signal => {
  if (!state.job) return;
  Object.assign(state.settings, readSpeedSettings());
  const ids = Object.keys(state.job.errors).map(Number).sort((a, b) => a - b);
  if (ids.length) await scan(ids, signal);
}));

$('pause').addEventListener('click', () => controller?.abort());

async function wait(ms, signal) {
  if (signal.aborted) throw new DOMException('已暂停', 'AbortError');
  await new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException('已暂停', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

$('discover').addEventListener('click', () => operation(async signal => {
  const speed = readSpeedSettings();
  const first = `${ORIGIN}/gift/?page=1&gift_type=certificate`;
  const queue = [first];
  const seen = new Set();
  let max = 0;
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    if (seen.size >= 100) throw new Error('证书列表超过 100 页，请手动设置扫描范围。');
    if (seen.size) await wait(speed.interval, signal);
    seen.add(url);
    notice(`正在读取证书列表第 ${seen.size} 页…`);
    const result = await requestPage(url, { signal });
    if (result.missing) throw new Error('礼品列表暂不可访问，请手动设置 ID 范围。');
    const parsed = parseListing(result.html, result.url);
    max = Math.max(max, parsed.maxId);
    // A list record cannot replace richer, previously collected detail text.
    for (const gift of parsed.gifts) {
      state.gifts[gift.id] = { ...state.gifts[gift.id], ...gift,
        description: state.gifts[gift.id]?.description ?? '', source: state.gifts[gift.id]?.source ?? '' };
    }
    for (const next of parsed.pages) if (!seen.has(next) && !queue.includes(next)) queue.push(next);
    await persist();
    render();
  }
  if (!max) throw new Error('列表没有有效礼品 ID，请手动指定范围。');
  const end = Math.min(MAX_ID, max + 50);
  state.settings = { start: 1, end, ...speed };
  state.discovery = { maxId: max, pages: seen.size, checkedAt: new Date().toISOString() };
  await persist();
  $('start-id').value = 1;
  $('end-id').value = end;
  notice(`已读取 ${seen.size} 页证书列表，最大已知 ID 为 ${max}，建议范围 1–${end}。点击「建立 / 更新索引」继续，零库存详情需要逐个读取。`);
}));

$('lookup-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = parseId($('lookup-id').value);
  if (id === null) { notice('请输入有效的礼品 ID，或 https://src.sjtu.edu.cn/gift/<id>/ 详情链接。', true); return; }
  operation(async signal => {
    const result = await requestPage(giftUrl(id), { signal });
    if (result.missing) throw new Error(`ID ${id} 的公开详情不存在（404/410），无法收录。`);
    const gift = parseDetail(result.html, id);
    state.gifts[id] = gift;
    await persist();
    $('query').value = giftUrl(id);
    $('stock').value = 'all';
    if (!gift.certificate) $('cert-only').checked = false;
    limit = 40;
    notice(`已收录 #${id}「${gift.name}」，剩余数量 ${gift.stock}。`);
  });
});

$('toggle-index').addEventListener('click', () => {
  const expanded = $('toggle-index').getAttribute('aria-expanded') === 'true';
  $('toggle-index').setAttribute('aria-expanded', String(!expanded));
  $('index-controls').hidden = expanded;
  $('toggle-index').textContent = expanded ? '展开设置 ↓' : '收起设置 ↑';
});

for (const id of ['query', 'stock', 'cert-only', 'sort']) {
  $(id).addEventListener(id === 'query' ? 'input' : 'change', () => { limit = 40; renderResults(); });
}
$('load-more').addEventListener('click', () => { limit += 40; renderResults(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault(); $('query').focus();
  }
});

$('export').addEventListener('click', () => {
  if (!filtered.length) return;
  const url = URL.createObjectURL(new Blob([csv(filtered)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `edusrc-gifts-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function externalLink(id, className, text) {
  const node = element('a', className, text);
  node.href = giftUrl(id);
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}

function giftCard(gift) {
  const card = element('article', 'gift');
  const top = element('div', 'gift-top');
  const stock = gift.stock === 0 ? '零库存 · 已兑完' : gift.stock === null ? '库存未知' : `剩余 ${gift.stock}`;
  top.append(element('span', 'gift-id', `GIFT / ${gift.id}`), element('span', `badge${gift.stock === 0 ? ' zero' : gift.stock === null ? ' unknown' : ''}`, stock));
  const name = element('h3'); name.append(externalLink(gift.id, '', gift.name));
  card.append(top, name);
  if (gift.source) card.append(element('p', 'gift-source', `来源 / ${gift.source}`));
  if (gift.description) {
    const details = element('details');
    details.append(element('summary', '', '查看描述与兑换限制'), element('p', 'description', gift.description));
    card.append(details);
  }
  const bottom = element('div', 'gift-bottom');
  const meta = element('div');
  const price = element('span', 'price', gift.price ?? '—');
  price.append(element('small', '', '金币'));
  meta.append(price, element('p', 'checked', `检查于 ${date(gift.checkedAt)}`));
  bottom.append(meta, externalLink(gift.id, 'gift-link', '打开官网详情 ↗'));
  card.append(bottom);
  return card;
}

function renderResults() {
  const gifts = Object.values(state.gifts);
  filtered = queryGifts(gifts, { query: $('query').value, stock: $('stock').value,
    certOnly: $('cert-only').checked, sort: $('sort').value });
  $('result-count').textContent = `${filtered.length} 个结果${filtered.length > limit ? ` · 已显示 ${limit} 个` : ''}`;
  $('results').replaceChildren(...filtered.slice(0, limit).map(giftCard));
  $('export').disabled = !filtered.length;
  $('load-more').hidden = filtered.length <= limit;
  $('empty-state').hidden = filtered.length > 0;
  if (!filtered.length) {
    $('empty-state').querySelector('h3').textContent = gifts.length ? '没有匹配的已收录礼品' : '先建立索引，再找到证书';
    $('empty-state').querySelector('p').textContent = gifts.length ? '试试其他关键词或放宽筛选；也可扩大扫描范围，并重试失败项。' : '点击「建立 / 更新索引」。零库存礼品同样会被收录。';
  }
}

function renderControls() {
  for (const id of ['start', 'discover', 'lookup', 'start-id', 'end-id', 'interval', 'concurrency', 'lookup-id']) $(id).disabled = busy;
  $('pause').hidden = !busy;
  $('pause').textContent = scanning ? '暂停扫描' : '停止读取';
  $('resume').hidden = busy || !state.job || state.job.nextId > state.job.end;
  $('retry').hidden = busy || !state.job || !Object.keys(state.job.errors).length;
}

function scheduleRender() {
  if (renderTimer === null) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 100);
}

function render() {
  if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
  const gifts = Object.values(state.gifts);
  $('total-count').textContent = gifts.length;
  $('cert-count').textContent = gifts.filter(gift => gift.certificate).length;
  $('empty-count').textContent = gifts.filter(gift => gift.certificate && gift.stock === 0).length;
  $('index-updated').textContent = state.updatedAt ? `更新于 ${date(state.updatedAt)}` : '从下方建立索引开始';
  const job = state.job;
  $('index-status').textContent = scanning ? '正在建立索引' : job ? (job.nextId > job.end ? (Object.keys(job.errors).length ? '范围已读 · 有失败项' : '指定范围检查完成') : '已有断点 · 可继续') : gifts.length ? '已有本地索引' : '尚未建立索引';
  $('progress-area').hidden = !job;
  if (job) {
    const total = job.end - job.start + 1;
    const done = Math.max(0, Math.min(total, job.checked ?? job.nextId - job.start));
    const percent = Math.floor(done / total * 100);
    const failures = Object.keys(job.errors).length;
    $('progress').value = percent;
    $('progress-percent').textContent = `${done} / ${total} · ${percent}%`;
    $('progress-text').textContent = `范围 ${job.start}–${job.end}${scanning ? ` · ${state.settings.concurrency} 并发 · 启动间隔 ${state.settings.interval / 1000} 秒` : ''}`;
    $('progress-detail').textContent = `成功读取 ${job.found} 次 · 不存在 ${job.missing} 次 · 待重试 ${failures} 项`;
    $('error-details').hidden = !failures;
    $('error-summary').textContent = `查看 ${failures} 个失败项`;
    $('error-list').replaceChildren(...Object.entries(job.errors).slice(0, 100).map(([id, message]) => element('li', '', `#${id}：${message}`)));
  } else $('error-details').hidden = true;
  renderControls();
  renderResults();
}

try {
  state = await readState();
  $('start-id').value = state.settings.start;
  $('end-id').value = state.settings.end;
  $('interval').value = state.settings.interval;
  $('concurrency').value = state.settings.concurrency;
  if (state.job && state.job.nextId <= state.job.end) notice('已恢复上次索引。点击「继续扫描」从保存的断点继续。');
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]?.newValue && !busy) { state = changes[KEY].newValue; render(); }
  });
  render();
} catch (error) {
  busy = true;
  renderControls();
  $('pause').hidden = true;
  notice(`无法读取扩展存储，请从浏览器扩展图标打开此页面。${error.message || ''}`, true);
}
