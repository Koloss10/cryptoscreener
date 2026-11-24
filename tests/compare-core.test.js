const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, commonSymbols, median } = require('../compare-core.js');

const row = (symbol, price, extra = {}) => ({ symbol, price, chg24: 0, vol24: 1e9, oi: null, funding: null, wallUsd: null, wallDist: null, ...extra });
const src = (ex, rows, ageMs = 60000, extra = {}) => ({ ex, name: ex.toUpperCase(), rows, ageMs, ...extra });

test('median works for odd, even and empty lists', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
});

test('deviation is relative to the median of fresh prices, spread names the cheapest and the dearest', () => {
    const r = compare('BTCUSDT', [
        src('binance', [row('BTCUSDT', 60000)], 0), src('okx', [row('BTCUSDT', 60030)]), src('gate', [row('BTCUSDT', 59970)]), src('mexc', [row('BTCUSDT', 60300)])
    ]);
    assert.equal(r.median, 60015);
    assert.deepEqual(r.items.map(i => i.dev), [-0.02, 0.02, -0.07, 0.47]);
    assert.deepEqual(r.priceSpread, { pct: 0.55, lo: 'GATE', hi: 'MEXC' });
    assert.equal(r.freshCount, 4);
});

test('a stale snapshot is shown but excluded from the median and the spread', () => {
    const r = compare('BTCUSDT', [src('okx', [row('BTCUSDT', 60000)]), src('gate', [row('BTCUSDT', 61000)], 40 * 60000), src('mexc', [row('BTCUSDT', 60100)])]);
    const gate = r.items.find(i => i.ex === 'gate');
    assert.equal(gate.stale, true); assert.equal(gate.dev, null); assert.ok(gate.row);
    assert.equal(r.freshCount, 2);
    assert.equal(r.priceSpread.pct, 0.17);
});

test('a missing coin, a not yet loaded source and an error are told apart; one fresh exchange gives no spread', () => {
    const r = compare('XYZUSDT', [src('okx', [row('XYZUSDT', 1)]), src('gate', [row('OTHERUSDT', 2)]), src('mexc', null, null, { error: 'HTTP 404' })]);
    assert.equal(r.items[0].row.price, 1);
    assert.deepEqual([r.items[1].row, r.items[1].loaded], [null, true]);
    assert.deepEqual([r.items[2].loaded, r.items[2].error], [false, 'HTTP 404']);
    assert.equal(r.priceSpread, null); assert.equal(r.fundingSpread, null); assert.equal(r.freshCount, 1);
});

test('funding spread uses only fresh sources that report funding', () => {
    const r = compare('BTCUSDT', [
        src('okx', [row('BTCUSDT', 1, { funding: 0.0001 })]), src('gate', [row('BTCUSDT', 1, { funding: -0.0002 })]),
        src('mexc', [row('BTCUSDT', 1, { funding: null })]), src('bitget', [row('BTCUSDT', 1, { funding: 0.0009 })], 99 * 60000)
    ]);
    assert.equal(r.fundingSpread.lo, 'GATE'); assert.equal(r.fundingSpread.hi, 'OKX');
    assert.ok(Math.abs(r.fundingSpread.diff - 0.0003) < 1e-12);
});

test('commonSymbols keeps coins present on at least two exchanges, biggest first', () => {
    const list = commonSymbols([
        src('a', [row('AAAUSDT', 1, { vol24: 5 }), row('BBBUSDT', 1, { vol24: 100 }), row('SOLOUSDT', 1, { vol24: 1e12 })]),
        src('b', [row('AAAUSDT', 1, { vol24: 50 }), row('BBBUSDT', 1, { vol24: 1 })]),
        src('c', null)
    ]);
    assert.deepEqual(list, ['BBBUSDT', 'AAAUSDT']);
});
