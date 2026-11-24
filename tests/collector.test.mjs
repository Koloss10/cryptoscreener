import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruments, parseTickers, parseOpenInterest, findWalls, parseBook, collect, toSymbol, getJson } from '../collector/okx.mjs';

const INST = [
    { instId: 'BTC-USDT-SWAP', state: 'live', ctVal: '0.01' },
    { instId: 'BTC-USD-SWAP', state: 'live', ctVal: '100' },          // інверсний — ігноруємо
    { instId: 'OLD-USDT-SWAP', state: 'suspend', ctVal: '1' }
];

test('only live USDT-margined swaps are kept, with contract size', () => {
    assert.deepEqual(parseInstruments(INST), { 'BTC-USDT-SWAP': { ctVal: 0.01 } });
    assert.equal(toSymbol('1000PEPE-USDT-SWAP'), '1000PEPEUSDT');
});

test('tickers: volume in USDT = coins * last, 24h change in percent, sorted by volume, unknown/broken skipped', () => {
    const ins = parseInstruments(INST);
    const rows = parseTickers([
        { instId: 'BTC-USDT-SWAP', last: '60000', open24h: '57000', volCcy24h: '1000' },
        { instId: 'ETH-USDT-SWAP', last: '3000', open24h: '3000', volCcy24h: '5' },        // немає в instruments
        { instId: 'BTC-USDT-SWAP', last: 'x', open24h: '1', volCcy24h: '1' }
    ], ins);
    assert.deepEqual(rows, [{ id: 'BTC-USDT-SWAP', s: 'BTCUSDT', last: 60000, chg24h: 5.26, volUsd: 60000000 }]);
});

test('open interest keeps only USDT swaps', () => {
    assert.deepEqual(parseOpenInterest([{ instId: 'BTC-USDT-SWAP', oiUsd: '123456.7' }, { instId: 'BTC-USD-SWAP', oiUsd: '5' }]), { 'BTC-USDT-SWAP': 123457 });
});

test('findWalls picks only outsized orders inside ±3% and converts contracts to USD', () => {
    const levels = [];
    for (let i = 0; i < 40; i++) levels.push([String(60000 + i * 10), '1']);              // ≈ $600 кожна — фон
    levels.push(['60100', '2000']);                                                        // 2000 * 0.01 * 60100 = $1.2M
    levels.push(['70000', '99999']);                                                       // далеко (>3%) — ігнорується
    const walls = findWalls(levels, 60000, 0.01);
    assert.deepEqual(walls, [{ px: 60100, usd: 1202000, dist: 0.17 }]);
});

test('findWalls: a flat book without outliers has no walls; empty input is fine', () => {
    const flat = Array.from({ length: 50 }, (_, i) => [String(100 + i * 0.01), '1000']);
    assert.deepEqual(findWalls(flat, 100, 1), []);
    assert.deepEqual(findWalls([], 100, 1), []);
});

test('parseBook returns null when the book is empty', () => {
    assert.equal(parseBook([{ bids: [], asks: [] }], 0.01), null);
    assert.equal(parseBook([], 0.01), null);
});

const okxFake = (over = {}) => async url => {
    const u = new URL(url), p = u.pathname;
    const ok = data => ({ ok: true, json: async () => ({ code: '0', data }) });
    if (over[p]) return over[p](u);
    if (p.endsWith('/instruments')) return ok(INST);
    if (p.endsWith('/tickers')) return ok([{ instId: 'BTC-USDT-SWAP', last: '60000', open24h: '60000', volCcy24h: '10' }]);
    if (p.endsWith('/open-interest')) return ok([{ instId: 'BTC-USDT-SWAP', oiUsd: '1000000' }]);
    if (p.endsWith('/funding-rate')) return ok([{ fundingRate: '0.0001' }]);
    if (p.endsWith('/books')) {
        const bg = (from, step) => Array.from({ length: 30 }, (_, i) => [String(from + step * i), '1']);
        return ok([{ bids: [...bg(59990, -10), ['59000', '5000']], asks: [...bg(60010, 10), ['61000', '5000']] }]);
    }
    throw new Error('unexpected ' + url);
};

test('collect builds a snapshot from fake OKX responses', async () => {
    const snap = await collect({ fetchFn: okxFake(), now: () => 123 });
    assert.equal(snap.ts, 123); assert.equal(snap.ex, 'okx'); assert.equal(snap.errors, 0);
    assert.deepEqual(snap.coins, [{ s: 'BTCUSDT', last: 60000, chg24h: 0, volUsd: 600000, oiUsd: 1000000, fund: 0.0001 }]);
    assert.equal(snap.walls.BTCUSDT.bids[0].px, 59000);
    assert.equal(snap.walls.BTCUSDT.asks[0].px, 61000);
});

test('collect survives a failing book for one coin and counts the error', async () => {
    const snap = await collect({ fetchFn: okxFake({ '/api/v5/market/books': async () => ({ ok: false, status: 500 }) }) });
    assert.equal(snap.errors, 1);
    assert.deepEqual(snap.walls, {});
    assert.equal(snap.coins.length, 1);
});

test('collect fails loudly when the essential list endpoints fail', async () => {
    await assert.rejects(collect({ fetchFn: okxFake({ '/api/v5/market/tickers': async () => ({ ok: false, status: 503 }) }) }), /HTTP 503/);
});

test('getJson rejects OKX error codes', async () => {
    await assert.rejects(getJson('/x', async () => ({ ok: true, json: async () => ({ code: '50011', msg: 'rate limit' }) })), /rate limit/);
});
