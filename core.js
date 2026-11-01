export const ORIGIN = 'https://src.sjtu.edu.cn';
export const MAX_ID = 100000;

/** Accept a plain ID or an exact public detail URL, never another origin. */
export function parseId(input) {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input > 0 && input <= MAX_ID ? input : null;
  }
  if (typeof input !== 'string') return null;
  const value = input.trim();
  const match = value.match(/^\d+$/u) || value.match(/^https:\/\/src\.sjtu\.edu\.cn\/gift\/(\d+)\/?$/u);
  if (!match) return null;
  const id = Number(match[1] ?? match[0]);
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_ID ? id : null;
}

export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

const knownAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Return a new array; preserve genuine zero stock throughout filtering. */
export function queryGifts(gifts, { query = '', stock = 'all', certOnly = true, sort = 'id-desc' } = {}) {
  const text = String(query ?? '').trim();
  const directId = text.startsWith('https://') ? parseId(text) : null;
  const terms = directId === null ? text.split(/\s+/u).filter(Boolean).map(normalize) : [String(directId)];
  const result = gifts.filter(gift => {
    if (certOnly && gift.certificate !== true) return false;
    if (stock === 'available' && !(knownAmount(gift.stock) && gift.stock > 0)) return false;
    if (stock === 'empty' && gift.stock !== 0) return false;
    if (stock === 'unknown' && knownAmount(gift.stock)) return false;
    if (directId !== null && gift.id !== directId) return false;
    const haystack = normalize(`${gift.id} ${gift.name ?? ''} ${gift.source ?? ''} ${gift.description ?? ''}`);
    return terms.every(term => haystack.includes(term));
  });
  const byId = (a, b) => b.id - a.id;
  const byAmount = (key, descending) => (a, b) => {
    const aKnown = knownAmount(a[key]);
    const bKnown = knownAmount(b[key]);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (!aKnown) return byId(a, b);
    return (descending ? b[key] - a[key] : a[key] - b[key]) || byId(a, b);
  };
  const comparators = {
    'id-desc': byId,
    name: (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN', { numeric: true }) || byId(a, b),
    'stock-desc': byAmount('stock', true),
    'price-asc': byAmount('price', false),
  };
  return result.sort(comparators[sort] ?? byId);
}

/** Guard numeric scan boundaries separately from accepting pasted detail URLs. */
export function validateRange(start, end) {
  const plainInteger = value => typeof value === 'number' || (typeof value === 'string' && /^\d+$/u.test(value.trim()));
  if (!plainInteger(start) || !plainInteger(end)) throw new Error('起止 ID 必须是正整数。');
  const first = Number(start);
  const last = Number(end);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < 1) {
    throw new Error('起止 ID 必须是大于 0 的整数。');
  }
  if (first > MAX_ID || last > MAX_ID) throw new Error(`ID 不能超过 ${MAX_ID}。`);
  if (first > last) throw new Error('起始 ID 不能大于结束 ID。');
  if (last - first + 1 > 5000) throw new Error('单次最多扫描 5000 个 ID，请缩小范围。');
  return { start: first, end: last };
}

function csvCell(value) {
  let text = String(value ?? '');
  // Quoting alone does not stop spreadsheets from evaluating a formula.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

export function csv(gifts) {
  const rows = [['ID', '名称', '剩余数量', '金币', '类型', '详情链接', '检查时间']];
  for (const gift of gifts) {
    rows.push([
      gift.id,
      gift.name,
      knownAmount(gift.stock) ? gift.stock : '未知',
      knownAmount(gift.price) ? gift.price : '未知',
      gift.certificate === true ? '证书' : '其他礼品',
      `${ORIGIN}/gift/${parseId(gift.id) ?? ''}/`,
      gift.checkedAt ?? '',
    ]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
