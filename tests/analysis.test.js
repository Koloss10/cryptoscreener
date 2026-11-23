// Юніт-тести чистих функцій аналізу: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analysis.js');

const bar = (o, h, l, c) => ({ time: 0, open: o, high: h, low: l, close: c, vol: 1 });
const flat = (n, p = 100) => Array.from({ length: n }, () => bar(p, p + 1, p - 1, p));

test('rsi equals 100 for a strictly rising series and 0 for a falling one', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 200 - i);
    assert.equal(A.rsi(up), 100);
    assert.equal(A.rsi(down), 0);
});

test('rsi is 50 on a flat series and null when there is not enough data', () => {
    assert.equal(A.rsi(Array(40).fill(100)), 50);
    assert.equal(A.rsi([1, 2, 3]), null);
});

test('ema of a constant series is the constant', () => {
    assert.ok(Math.abs(A.ema(Array(60).fill(7), 20) - 7) < 1e-9);
});

test('breakout detects close above the prior 20-bar high', () => {
    const cs = flat(25); cs.push(bar(100, 106, 100, 105));
    assert.deepEqual(A.breakout(cs), { type: 'up', level: 101 });
});

test('breakout detects close below the prior 20-bar low and ignores in-range closes', () => {
    const down = flat(25); down.push(bar(100, 100, 94, 95));
    assert.equal(A.breakout(down).type, 'down');
    assert.equal(A.breakout(flat(25)), null);
});

test('bullish engulfing is recognised', () => {
    const cs = [bar(102, 103, 99, 100), bar(99, 104, 98, 103)];
    assert.equal(A.candlePattern(cs), 'Бичаче поглинання');
});

test('hammer is recognised (long lower wick, tiny upper wick)', () => {
    const cs = [bar(100, 101, 99, 100), bar(100, 100.5, 95, 100.5)];
    assert.equal(A.candlePattern(cs), 'Молот (пін-бар)');
});

test('bullish FVG is found and reported with its age', () => {
    const cs = flat(10);
    cs.push(bar(100, 101, 99, 100), bar(101, 106, 101, 105), bar(105, 108, 103, 107));   // low(107 bar)=103 > high(first)=101
    cs.push(bar(107, 109, 106, 108));
    const g = A.lastFvg(cs);
    assert.equal(g.type, 'bull');
    assert.equal(g.age, 1);
});

test('FVG that price later traded back through is treated as filled', () => {
    const cs = flat(10);
    cs.push(bar(100, 101, 99, 100), bar(101, 106, 101, 105), bar(105, 108, 103, 107));
    cs.push(bar(107, 107, 98, 99));   // закрила гепа
    assert.equal(A.lastFvg(cs), null);
});

test('analyze returns null for short histories', () => {
    assert.equal(A.analyze(flat(10)), null);
});
