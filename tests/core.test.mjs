import test from 'node:test';
import assert from 'node:assert/strict';
import { parseId, normalize, queryGifts, validateRange, csv } from '../core.js';

const gifts = [
  { id: 1, name: '上海交通大学证书', stock: 0, price: 20, certificate: true, description: '漏洞报送 2025' },
  { id: 2, name: '北京大学证书', stock: 3, price: 0, certificate: true, description: '漏洞报送 2026' },
  { id: 3, name: '纪念礼品', stock: 0, price: 10, certificate: false, description: '限量' },
  { id: 4, name: '上海大学证书', stock: null, price: null, certificate: true, description: '漏洞报送 2026' },
];

test('accepts IDs and exact public URLs, rejects ambiguous or off-origin URLs', () => {
  for (const value of [1, '1', '001', ' https://src.sjtu.edu.cn/gift/1/ ', 'https://src.sjtu.edu.cn/gift/1']) assert.equal(parseId(value), 1);
  for (const value of [0, -1, 1.5, '1e2', '1.0', '', null, {}, 'https://src.sjtu.edu.cn.evil.test/gift/1/', 'http://src.sjtu.edu.cn/gift/1/', 'https://src.sjtu.edu.cn/gift/1/?x=1', 'https://src.sjtu.edu.cn/gift/1/#x', 'https://user@src.sjtu.edu.cn/gift/1/', 'https://src.sjtu.edu.cn:443/gift/1/', 'https://src.sjtu.edu.cn/gift/0/', '100001']) assert.equal(parseId(value), null, String(value));
});

test('normalizes full width text and whitespace', () => {
  assert.equal(normalize('  ＡＢＣ　上 海\n'), 'abc上海');
});

test('default search includes zero stock and excludes noncertificates without mutating input', () => {
  assert.deepEqual(queryGifts(gifts).map(g => g.id), [4, 2, 1]);
  assert.equal(gifts[0].id, 1);
  assert.deepEqual(queryGifts(gifts, { stock: 'empty' }).map(g => g.id), [1]);
  assert.deepEqual(queryGifts(gifts, { stock: 'empty', certOnly: false }).map(g => g.id), [3, 1]);
  assert.deepEqual(queryGifts(gifts, { stock: 'available' }).map(g => g.id), [2]);
  assert.deepEqual(queryGifts(gifts, { stock: 'unknown' }).map(g => g.id), [4]);
});

test('AND search covers names, details, IDs, and pasted URLs', () => {
  assert.deepEqual(queryGifts(gifts, { query: '上海 2025' }).map(g => g.id), [1]);
  assert.deepEqual(queryGifts(gifts, { query: '上海 2026' }).map(g => g.id), [4]);
  assert.deepEqual(queryGifts(gifts, { query: '１' }).map(g => g.id), [1]);
  assert.deepEqual(queryGifts(gifts, { query: 'https://src.sjtu.edu.cn/gift/1/' }).map(g => g.id), [1]);
  assert.deepEqual(queryGifts(gifts, { query: '北京 2025' }), []);
});

test('sorts numerical values with genuine zero first for price and unknown last', () => {
  assert.deepEqual(queryGifts(gifts, { sort: 'price-asc' }).map(g => g.id), [2, 1, 4]);
  assert.deepEqual(queryGifts(gifts, { sort: 'stock-desc' }).map(g => g.id), [2, 1, 4]);
  assert.deepEqual(queryGifts(gifts, { sort: 'name' }).map(g => g.name), gifts.filter(g => g.certificate).map(g => g.name).sort((a,b) => a.localeCompare(b, 'zh-CN', { numeric: true })));
});

test('validates bounded inclusive scan ranges', () => {
  assert.deepEqual(validateRange('1', '5000'), { start: 1, end: 5000 });
  assert.deepEqual(validateRange(100000, 100000), { start: 100000, end: 100000 });
  for (const [a,b] of [[0,1],[1,0],[-1,1],[1.5,2],[2,1],[1,5001],[1,100001],['1e2',200],['',2],[Infinity,Infinity],[NaN,3],['https://src.sjtu.edu.cn/gift/1/',2]]) assert.throws(() => validateRange(a,b), Error);
});

test('CSV preserves zero and unknown, escapes multiline names and protects spreadsheet formulas', () => {
  const output = csv([
    { ...gifts[0], name: '=HYPERLINK("https://evil.test","x")', checkedAt: '2026-11-01T08:00:00Z' },
    { ...gifts[3], name: '名,称"\n下一行' },
    { ...gifts[2], name: ' \t+1+1' },
    { ...gifts[2], name: '\tcommand' },
  ]);
  assert.equal(output[0], '\uFEFF');
  assert.match(output, /"ID","名称","剩余数量","金币","类型","详情链接","检查时间"\r\n/u);
  assert.ok(output.includes('"\'=HYPERLINK(""https://evil.test"",""x"")"'));
  assert.ok(output.includes('"0","20","证书"'));
  assert.ok(output.includes('"未知","未知"'));
  assert.ok(output.includes('"名,称""\n下一行"'));
  assert.ok(output.includes('"\' \t+1+1"'));
  assert.ok(output.includes('"\'\tcommand"'));
  assert.ok(output.includes('https://src.sjtu.edu.cn/gift/1/'));
});
