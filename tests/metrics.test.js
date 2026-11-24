// Юніт-тести метрик скрінера: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../metrics.js');

const MIN = 60000;
// 1-хвилинна свічка: час у хвилинах від епохи, закриття, діапазон ±range, обсяг у $ (quote)
const c = (min, close, { range = 0, quote = 100 } = {}) =>
    ({ time: min * MIN, open: close, high: close + range, low: close - range, close, vol: quote / close, quote });
const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('aggregate groups 1m candles into aligned n-minute candles', () => {
    const cs = series(10, i => c(i, 100 + i, { range: 1, quote: 10 }));   // хвилини 0..9
    const five = M.aggregate(cs, 5);
    assert.equal(five.length, 2);
    assert.equal(five[0].open, 100);
    assert.equal(five[0].close, 104);
    assert.equal(five[0].high, 105);
    assert.equal(five[0].low, 99);
    assert.equal(five[0].quote, 50);
    assert.equal(five[1].time, 5 * MIN);
});

test('aggregate drops a leading partial bucket but keeps the live trailing one', () => {
    const cs = series(8, i => c(i + 3, 100, { quote: 10 }));              // хвилини 3..10
    const five = M.aggregate(cs, 5);
    assert.deepEqual(five.map(x => x.time / MIN), [5, 10]);                // бакет 0..4 неповний — відкинуто
    assert.equal(five[1].quote, 10);                                       // поточний бакет (лише хв. 10)
});

test('natr is ATR / close in percent (constant range of 2 on price 100 gives 2%)', () => {
    const cs = series(30, i => ({ time: i, open: 100, high: 101, low: 99, close: 100, vol: 1, quote: 100 }));
    assert.ok(Math.abs(M.natr(cs, 14) - 2) < 1e-9);
});

test('natr returns null when fewer than period+1 candles', () => {
    assert.equal(M.natr(series(10, i => c(i, 100, { range: 1 })), 14), null);
});

test('pctChange compares the last close with the close N minutes ago', () => {
    const cs = series(70, i => c(i, 100 + i));                             // 100..169
    assert.ok(Math.abs(M.pctChange(cs, 5) - ((169 / 164) - 1) * 100) < 1e-9);
    assert.equal(M.pctChange(cs, 200), null);
});

test('quoteVolume sums the last N one-minute candles', () => {
    const cs = series(70, i => c(i, 100, { quote: i + 1 }));               // 1..70
    assert.equal(M.quoteVolume(cs, 3), 70 + 69 + 68);
    assert.equal(M.quoteVolume(cs, 500), null);
});

test('volumeSpike is last window volume over the mean of the previous windows', () => {
    const cs = [...series(60, i => c(i, 100, { quote: 10 })), ...series(5, i => c(60 + i, 100, { quote: 60 }))];
    // останнє 5-хв вікно = 300, попередні 12 вікон по 50 → ×6
    assert.ok(Math.abs(M.volumeSpike(cs, 5, 12) - 6) < 1e-9);
});

test('volumeSpike is null without enough history or with a zero baseline', () => {
    assert.equal(M.volumeSpike(series(20, i => c(i, 100)), 5, 12), null);
    assert.equal(M.volumeSpike(series(70, i => c(i, 100, { quote: 0 })), 5, 12), null);
});

test('buildRow assembles all columns from candles and ticker', () => {
    const cs = series(130, i => c(i, 100 + i * 0.1, { range: 0.5, quote: 1000 }));
    const row = M.buildRow('BTCUSDT', cs, { priceChangePercent: '1.5', quoteVolume: '9e8' }, 0.0001);
    assert.equal(row.symbol, 'BTCUSDT');
    assert.equal(row.chg24, 1.5);
    assert.equal(row.vol24, 9e8);
    assert.equal(row.vol1h, 60000);
    assert.equal(row.funding, 0.0001);
    assert.ok(row.natr5 > 0);
    assert.ok(Math.abs(row.price - cs[129].close) < 1e-9);
});

test('buildRow tolerates short history (metrics become null, no throw)', () => {
    const row = M.buildRow('NEWUSDT', series(3, i => c(i, 1, {})), {}, null);
    assert.equal(row.natr5, null);
    assert.equal(row.vol1h, null);
    assert.equal(row.spike, null);
});

test('filterRows applies min volume, NATR, spike and search together', () => {
    const rows = [
        { symbol: 'AAAUSDT', vol1h: 5e6, natr5: 3, spike: 4 },
        { symbol: 'BBBUSDT', vol1h: 1e5, natr5: 3, spike: 4 },
        { symbol: 'CCCUSDT', vol1h: 5e6, natr5: 0.2, spike: 4 },
        { symbol: 'AABUSDT', vol1h: 5e6, natr5: 3, spike: null }
    ];
    const out = M.filterRows(rows, { minVol1h: 1e6, minNatr: 1, minSpike: 2, search: 'aa' });
    assert.deepEqual(out.map(r => r.symbol), ['AAAUSDT']);
});

test('sortRows sorts by key and always puts null values last', () => {
    const rows = [{ symbol: 'A', natr5: 1 }, { symbol: 'B', natr5: null }, { symbol: 'C', natr5: 3 }];
    assert.deepEqual(M.sortRows(rows, 'natr5', 'desc').map(r => r.symbol), ['C', 'A', 'B']);
    assert.deepEqual(M.sortRows(rows, 'natr5', 'asc').map(r => r.symbol), ['A', 'C', 'B']);
    assert.equal(rows[0].symbol, 'A');   // вхідний масив не змінюється
});

test('applyKline updates the current minute in place and appends a new one, keeping the cap', () => {
    const base = [c(0, 100), c(1, 101)];
    const upd = M.applyKline(base, c(1, 105), 3);
    assert.equal(upd.length, 2);
    assert.equal(upd[1].close, 105);
    const added = M.applyKline(upd, c(2, 106), 3);
    assert.equal(added.length, 3);
    const capped = M.applyKline(added, c(3, 107), 3);
    assert.equal(capped.length, 3);
    assert.equal(capped[0].time, 1 * MIN);
    assert.equal(base[1].close, 101);    // оригінал не мутується
});

test('parseKline converts a Binance futures kline event to a candle', () => {
    const msg = { k: { t: 60000, o: '1', h: '2', l: '0.5', c: '1.5', v: '10', q: '15' } };
    assert.deepEqual(M.parseKline(msg), { time: 60000, open: 1, high: 2, low: 0.5, close: 1.5, vol: 10, quote: 15 });
});

test('normalizeRules keeps only valid unique rules (known column, >= or <=, finite number) up to the cap', () => {
    const keys = ['natr5', 'vol24'];
    const rules = M.normalizeRules([
        { key: 'natr5', op: '>=', value: '2' }, { key: 'natr5', op: '>=', value: 2 },          // дубль
        { key: 'nope', op: '>=', value: 1 }, { key: 'vol24', op: '==', value: 1 },              // невідома колонка, невідома умова
        { key: 'vol24', op: '<=', value: 'abc' }, null, { key: 'vol24', op: '<=', value: -5 }
    ], keys);
    assert.deepEqual(rules, [{ key: 'natr5', op: '>=', value: 2 }, { key: 'vol24', op: '<=', value: -5 }]);
    assert.deepEqual(M.normalizeRules('x', keys), []);
    const many = Array.from({ length: 30 }, (_, i) => ({ key: 'natr5', op: '>=', value: i }));
    assert.equal(M.normalizeRules(many, keys).length, M.MAX_RULES);
});

test('ruleHit applies rules only to their own column and never to missing values', () => {
    const rules = [{ key: 'natr5', op: '>=', value: 2 }, { key: 'chg24', op: '<=', value: -5 }];
    assert.equal(M.ruleHit(rules, 'natr5', 2), true);
    assert.equal(M.ruleHit(rules, 'natr5', 1.99), false);
    assert.equal(M.ruleHit(rules, 'chg24', -5.1), true);
    assert.equal(M.ruleHit(rules, 'chg24', 3), false);
    assert.equal(M.ruleHit(rules, 'spike', 100), false);
    assert.equal(M.ruleHit(rules, 'natr5', null), false);
    assert.equal(M.ruleHit(rules, 'natr5', NaN), false);
});

test('RULE_UNITS gives every ruleable column a positive unit and a hint', () => {
    for (const [key, u] of Object.entries(M.RULE_UNITS)) { assert.ok(u.unit > 0, key); assert.ok(u.hint, key); }
    assert.equal(M.RULE_UNITS.funding.unit, 0.01);          // фандинг зберігається часткою, у полі — у %
});
