// Юніт-тести детектора плотностей: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../density.js');

// книга: ціна 100, по 50 рівнів з кроком 0.1; базовий обсяг рівня = 10 монет ($1000)
function book({ walls = [] } = {}) {
    const bids = [], asks = [];
    for (let i = 0; i < 50; i++) { bids.push([+(99.9 - i * 0.1).toFixed(2), 10]); asks.push([+(100.1 + i * 0.1).toFixed(2), 10]); }
    for (const w of walls) {
        const side = w.side === 'bid' ? bids : asks;
        const lvl = side.find(l => l[0] === w.price);
        assert.ok(lvl, 'wall must sit on an existing level: ' + w.price);
        lvl[1] = w.qty;
    }
    return { bids, asks };
}
const OPTS = { minUsd: 10000, minRatio: 8, maxDistPct: 5, perSide: 3 };

test('parseBook converts string levels to numbers and rejects malformed data', () => {
    const b = D.parseBook({ bids: [['99.9', '2']], asks: [['100.1', '3']], T: 5 });
    assert.deepEqual(b, { bids: [[99.9, 2]], asks: [[100.1, 3]], T: 5 });
    assert.equal(D.parseBook(null), null);
    assert.equal(D.parseBook({ bids: [], asks: [['1', '1']] }), null);       // порожня сторона — книги немає
    assert.equal(D.parseBook({ bids: [['x', '1']], asks: [['1', '1']] }), null);
});

test('detect finds a big level on each side and reports size, ratio and distance', () => {
    const b = book({ walls: [{ side: 'bid', price: 99.5, qty: 500 }, { side: 'ask', price: 101.0, qty: 800 }] });
    const w = D.detect(b, OPTS);
    const bid = w.find(x => x.side === 'bid'), ask = w.find(x => x.side === 'ask');
    assert.equal(bid.price, 99.5);
    assert.ok(Math.abs(bid.usd - 99.5 * 500) < 1e-6);
    assert.ok(bid.ratio >= 40);
    assert.ok(Math.abs(bid.distPct - 0.5) < 1e-9);                           // mid = 100
    assert.equal(ask.price, 101);
    assert.ok(Math.abs(ask.distPct - 1) < 1e-9);
});

test('detect ignores ordinary levels, small walls (minUsd) and far walls (maxDistPct)', () => {
    assert.deepEqual(D.detect(book(), OPTS), []);
    const small = book({ walls: [{ side: 'bid', price: 99.5, qty: 50 }] });                 // $4975 < minUsd
    assert.deepEqual(D.detect(small, OPTS), []);
    const far = book({ walls: [{ side: 'ask', price: 104.9, qty: 900 }] });                 // 4.9% — ще в межах
    assert.equal(D.detect(far, OPTS).length, 1);
    assert.deepEqual(D.detect(far, { ...OPTS, maxDistPct: 3 }), []);
});

test('detect needs the level to stand out from the side median (minRatio)', () => {
    const b = book({ walls: [{ side: 'bid', price: 99.5, qty: 60 }] });                      // 6× медіани
    assert.equal(D.detect(b, { ...OPTS, minUsd: 1000, minRatio: 8 }).length, 0);
    assert.equal(D.detect(b, { ...OPTS, minUsd: 1000, minRatio: 5 }).length, 1);
});

test('detect keeps only the biggest perSide walls per side, sorted by size', () => {
    const b = book({ walls: [99.8, 99.7, 99.6, 99.5].map((p, i) => ({ side: 'bid', price: p, qty: 400 + i * 100 })) });
    const bids = D.detect(b, OPTS).filter(x => x.side === 'bid');
    assert.equal(bids.length, 3);
    assert.deepEqual(bids.map(x => x.price), [99.5, 99.6, 99.7]);
});

test('coverage reports how far from the mid price the book reaches on each side', () => {
    const c = D.coverage(book());
    assert.ok(Math.abs(c.bidPct - 4.9) < 0.11);                                              // 50 рівнів по 0.1 від 100
    assert.ok(Math.abs(c.askPct - 4.9) < 0.11);
});

test('track keeps firstSeen for a continuing wall and drops walls that disappeared', () => {
    const w1 = [{ side: 'bid', price: 99.5, usd: 5e4 }, { side: 'ask', price: 101, usd: 6e4 }];
    const m1 = D.track(new Map(), 'AAAUSDT', w1, 1000);
    const m2 = D.track(m1, 'AAAUSDT', [{ side: 'bid', price: 99.5, usd: 7e4 }], 61000);
    const list = [...m2.values()];
    assert.equal(list.length, 1);
    assert.equal(list[0].firstSeen, 1000);                                                   // стіна жива з 1000
    assert.equal(list[0].usd, 7e4);                                                          // розмір оновлено
    assert.equal(m1.size, 2);                                                                // попередня мапа не мутується
});

test('track only touches the polled symbol', () => {
    const a = D.track(new Map(), 'AAAUSDT', [{ side: 'bid', price: 1, usd: 1e5 }], 0);
    const b = D.track(a, 'BBBUSDT', [{ side: 'ask', price: 2, usd: 1e5 }], 10);
    assert.equal(b.size, 2);
    const c = D.track(b, 'AAAUSDT', [], 20);
    assert.deepEqual([...c.values()].map(x => x.symbol), ['BBBUSDT']);
});

test('eatMinutes is wall size over traded volume per minute', () => {
    assert.equal(D.eatMinutes(600000, 100000), 6);
    assert.equal(D.eatMinutes(1, 0), null);
    assert.equal(D.eatMinutes(1, null), null);
});
