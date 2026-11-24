// Юніт-тести формацій: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../formations.js');

const MIN = 60000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % MIN);
// 1m-свічка: i — номер хвилини від T0
const bar = (i, { o, h, l, c, q = 1000 }) => ({ time: T0 + i * MIN, open: o, high: h, low: l, close: c, vol: q / c, quote: q });
const flat = (n, from = 0, price = 100) => Array.from({ length: n }, (_, k) => bar(from + k, { o: price, h: price + 0.2, l: price - 0.2, c: price }));
// «формується» свічка в кінці масиву — детектор її не бачить
const forming = i => bar(i, { o: 100, h: 100.1, l: 99.9, c: 100 });
const types = sigs => sigs.map(s => s.type + ':' + s.side);

test('breakout above the 60-candle high with volume gives a long with stop under the level and 2R take', () => {
    const cs = [...flat(70), bar(70, { o: 100, h: 101.1, l: 100, c: 101, q: 5000 }), forming(71)];
    const s = F.detect('AAAUSDT', cs, { walls: [] }).find(x => x.type === 'breakout');
    assert.equal(s.side, 'long');
    assert.equal(s.entry, 101);
    assert.ok(s.stop < 100.2 && s.stop > 99.5, 'stop sits just under the broken level 100.2: ' + s.stop);
    assert.ok(Math.abs((s.take - s.entry) - 2 * (s.entry - s.stop)) < 1e-9);
    assert.equal(s.time, T0 + 70 * MIN);
    assert.equal(s.id, `AAAUSDT|breakout|long|${T0 + 70 * MIN}`);
});

test('breakout needs volume confirmation', () => {
    const cs = [...flat(70), bar(70, { o: 100, h: 101.1, l: 100, c: 101, q: 1000 }), forming(71)];
    assert.ok(!types(F.detect('AAAUSDT', cs, { walls: [] })).includes('breakout:long'));
});

test('breakout below the 60-candle low is a short (mirror)', () => {
    const cs = [...flat(70), bar(70, { o: 100, h: 100, l: 98.9, c: 99, q: 5000 }), forming(71)];
    const s = F.detect('AAAUSDT', cs, { walls: [] }).find(x => x.type === 'breakout');
    assert.equal(s.side, 'short');
    assert.ok(s.stop > 99.8 && s.stop < 100.5);
    assert.ok(s.take < s.entry);
});

test('only closed candles are analysed: the forming candle never produces a signal', () => {
    const cs = [...flat(70), bar(70, { o: 100, h: 101.1, l: 100, c: 101, q: 5000 })];    // пробій — остання, ще не закрита
    assert.deepEqual(F.detect('AAAUSDT', cs, { walls: [] }), []);
});

test('too little history gives no signals', () => {
    assert.deepEqual(F.detect('AAAUSDT', flat(30), { walls: [] }), []);
});

test('retest of a broken level that holds and bounces gives a long', () => {
    const cs = [...flat(62),
        bar(62, { o: 100, h: 101.1, l: 100, c: 101, q: 5000 }),                              // пробій рівня 100.2
        bar(63, { o: 101, h: 101.6, l: 100.7, c: 101.4 }), bar(64, { o: 101.4, h: 101.7, l: 100.9, c: 101.2 }),
        bar(65, { o: 101.2, h: 101.4, l: 100.6, c: 100.9 }),
        bar(66, { o: 100.3, h: 100.9, l: 100.19, c: 100.8 }),                                 // повернення до рівня й відскок
        forming(67)];
    const s = F.detect('AAAUSDT', cs, { walls: [] }).find(x => x.type === 'retest');
    assert.equal(s.side, 'long');
    assert.equal(s.entry, 100.8);
    assert.ok(s.stop < 100.19);
});

test('no retest signal when the breakout failed (price closed back under the level)', () => {
    const cs = [...flat(62),
        bar(62, { o: 100, h: 101.1, l: 100, c: 101, q: 5000 }),
        bar(63, { o: 101, h: 101, l: 99.4, c: 99.5 }),                                       // провал під рівень
        bar(64, { o: 99.5, h: 100.4, l: 99.5, c: 100.3 }),
        bar(65, { o: 100.3, h: 100.9, l: 100.19, c: 100.8 }),
        forming(66)];
    assert.ok(!F.detect('AAAUSDT', cs, { walls: [] }).some(x => x.type === 'retest'));
});

test('volume surge with a strong move continues in the direction of the move', () => {
    const up = [100.25, 100.5, 100.75, 101, 101.25];
    const cs = [...flat(70), ...up.map((c, k) => bar(70 + k, { o: c - 0.25, h: c + 0.05, l: c - 0.3, c, q: 5000 })), forming(75)];
    const s = F.detect('AAAUSDT', cs, { walls: [] }).find(x => x.type === 'surge');
    assert.equal(s.side, 'long');
    assert.ok(s.take > s.entry && s.stop < s.entry);
});

test('density bounce: a candle touches a standing bid wall and closes back up', () => {
    const cs = [...flat(70), bar(70, { o: 99.6, h: 100, l: 99.45, c: 99.9 }), forming(71)];
    const wall = { side: 'bid', price: 99.5, usd: 5e5, ageMs: 120000 };
    const s = F.detect('AAAUSDT', cs, { walls: [wall] }).find(x => x.type === 'bounce');
    assert.equal(s.side, 'long');
    assert.ok(s.stop < 99.5);
    assert.equal(s.level, 99.5);
});

test('density bounce ignores young walls and walls far from the price', () => {
    const cs = [...flat(70), bar(70, { o: 99.6, h: 100, l: 99.45, c: 99.9 }), forming(71)];
    const young = { side: 'bid', price: 99.5, usd: 5e5, ageMs: 10000 };
    const far = { side: 'bid', price: 97, usd: 5e5, ageMs: 120000 };
    assert.ok(!F.detect('AAAUSDT', cs, { walls: [young, far] }).some(x => x.type === 'bounce'));
});

test('update adds new signals, dedupes by id and applies a per-type cooldown', () => {
    const sig = (i, side = 'long') => ({ id: `AAAUSDT|breakout|${side}|${T0 + i * MIN}`, symbol: 'AAAUSDT', type: 'breakout', side, time: T0 + i * MIN, entry: 100, stop: 99, take: 102, status: 'open' });
    let s = F.addSignals({ signals: [] }, [sig(70)]);
    assert.equal(s.signals.length, 1);
    assert.equal(F.addSignals(s, [sig(70)]).signals.length, 1);                              // той самий id
    assert.equal(F.addSignals(s, [sig(75)]).signals.length, 1);                              // у межах cooldown
    assert.equal(F.addSignals(s, [sig(75, 'short')]).signals.length, 2);                     // інший бік
    assert.equal(F.addSignals(s, [sig(70 + 31)]).signals.length, 2);                         // після cooldown
    assert.equal(s.signals.length, 1);                                                       // вхідний стан не змінено
});

const open = (side = 'long') => ({ id: 'x', symbol: 'AAAUSDT', type: 'breakout', side, time: T0, entry: 100, stop: 99, take: 102, status: 'open' });
const after = (...cs) => cs.map((c, k) => bar(1 + k, c));

test('evaluate: take hit first is a win worth +2R', () => {
    const r = F.evaluate(open(), after({ o: 100, h: 100.5, l: 99.8, c: 100.3 }, { o: 100.3, h: 102.2, l: 100.2, c: 102 }), T0 + 5 * MIN);
    assert.equal(r.status, 'win'); assert.equal(r.r, 2);
});

test('evaluate: stop hit is a loss of -1R; short side mirrors', () => {
    assert.deepEqual(F.evaluate(open(), after({ o: 100, h: 100.2, l: 98.9, c: 99 }), T0 + 5 * MIN).r, -1);
    const sh = { ...open('short'), stop: 101, take: 98 };
    assert.equal(F.evaluate(sh, after({ o: 100, h: 100.4, l: 97.9, c: 98 }), T0 + 5 * MIN).status, 'win');
});

test('evaluate: a candle that touches both stop and take counts as a loss (conservative)', () => {
    const r = F.evaluate(open(), after({ o: 100, h: 102.5, l: 98.5, c: 100 }), T0 + 5 * MIN);
    assert.equal(r.status, 'loss');
});

test('evaluate: stays open until the time limit, then expires with the signed result', () => {
    const calm = after({ o: 100, h: 100.4, l: 99.7, c: 100.2 });
    assert.equal(F.evaluate(open(), calm, T0 + 30 * MIN).status, 'open');
    const r = F.evaluate(open(), [...calm, ...Array.from({ length: 70 }, (_, k) => bar(2 + k, { o: 100.5, h: 100.8, l: 100.1, c: 100.5 }))], T0 + 80 * MIN);
    assert.equal(r.status, 'expired');
    assert.ok(Math.abs(r.r - 0.5) < 1e-9);                                                   // (100.5−100)/1
});

test('evaluate: when candles no longer cover the signal the result is unknown, not invented', () => {
    const late = [bar(200, { o: 100, h: 100.2, l: 99.9, c: 100 })];
    assert.equal(F.evaluate(open(), late, T0 + 300 * MIN).status, 'unknown');
    assert.equal(F.evaluate(open(), late, T0 + 10 * MIN).status, 'open');                    // ще в межах часу — просто чекаємо
});

test('stats: winrate and average R per type within a time window; unknown and open are excluded from winrate', () => {
    const mk = (type, status, r, ageMin) => ({ type, status, r, time: T0 - ageMin * MIN });
    const all = [mk('breakout', 'win', 2, 10), mk('breakout', 'loss', -1, 20), mk('breakout', 'loss', -1, 30),
        mk('breakout', 'open', null, 1), mk('breakout', 'unknown', null, 50), mk('surge', 'win', 2, 3000)];
    const day = F.stats(all, 24 * 60 * MIN, T0);
    assert.equal(day.breakout.wins, 1); assert.equal(day.breakout.losses, 2); assert.equal(day.breakout.open, 1);
    assert.ok(Math.abs(day.breakout.winrate - 100 / 3) < 1e-9);
    assert.ok(Math.abs(day.breakout.avgR - 0) < 1e-9);                                        // (2−1−1)/3
    assert.equal(day.surge, undefined);                                                       // 3000 хв > 24 год
    assert.equal(F.stats(all, Infinity, T0).surge.wins, 1);
});
