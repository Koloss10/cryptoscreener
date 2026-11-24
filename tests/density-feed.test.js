// Тести опитувача книг ордерів із підробленим fetch: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Density = require('../density.js');
const { createDensityFeed } = require('../density-feed.js');

function depthBody(price, wallQty) {
    const bids = [], asks = [];
    for (let i = 0; i < 60; i++) { bids.push([(price - 0.1 - i * 0.1).toFixed(2), '10']); asks.push([(price + 0.1 + i * 0.1).toFixed(2), '10']); }
    if (wallQty) asks[20][1] = String(wallQty);                                  // стіна над ціною
    return { lastUpdateId: 1, T: 5, bids, asks };
}

function setup({ symbols, priority = null, active = true, respond } = {}) {
    const calls = [], statuses = [];
    let clock = 1000, updates = 0;
    const fetchImpl = async (url) => {
        calls.push(url);
        const sym = /symbol=(\w+)/.exec(url)[1];
        if (respond) { const r = respond(sym, url); if (r) return r; }
        return { ok: true, status: 200, json: async () => depthBody(100, 900) };
    };
    const syms = symbols || [{ symbol: 'AAAUSDT', vol1h: 6e6 }, { symbol: 'BBBUSDT', vol1h: 6e6 }, { symbol: 'CCCUSDT', vol1h: 6e6 }];
    const feed = createDensityFeed({
        Density, fetchImpl, now: () => clock, intervalMs: 1e9,
        getSymbols: () => syms, getPriority: () => priority, isActive: () => active,
        onUpdate: () => { updates++; }, onStatus: (s, d) => statuses.push([s, d]),
        opts: { minUsd: 10000, minRatio: 8, maxDistPct: 5, perSide: 3 }
    });
    return { feed, calls, statuses, advance: ms => { clock += ms; }, updates: () => updates };
}
const symOf = u => /symbol=(\w+)/.exec(u)[1];

test('polls symbols round-robin with the 1000-level depth limit', async () => {
    const { feed, calls } = setup();
    for (let i = 0; i < 4; i++) await feed.pollOnce();
    assert.deepEqual(calls.map(symOf), ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'AAAUSDT']);
    assert.ok(calls.every(u => u.includes('limit=1000') && u.includes('/fapi/v1/depth')));
});

test('priority symbol (current chart) is polled every third request', async () => {
    const { feed, calls } = setup({ priority: 'CCCUSDT' });
    for (let i = 0; i < 6; i++) await feed.pollOnce();
    const order = calls.map(symOf);
    assert.equal(order.filter(s => s === 'CCCUSDT').length >= 2, true);
    assert.equal(order[2], 'CCCUSDT');                                           // третій запит — пріоритетний
});

test('does nothing while inactive (tab hidden or screen not showing densities)', async () => {
    const { feed, calls, statuses } = setup({ active: false });
    await feed.pollOnce();
    assert.equal(calls.length, 0);
    assert.equal(statuses.at(-1)[0], 'idle');
});

test('detects a wall, tracks its age and computes minutes to eat it from 1h volume', async () => {
    const { feed, advance } = setup();
    await feed.pollOnce();
    advance(60000);
    for (let i = 0; i < 3; i++) await feed.pollOnce();                           // AAA опитано вдруге через 60 с
    const a = feed.getAll().find(w => w.symbol === 'AAAUSDT');
    assert.equal(a.side, 'ask');
    assert.equal(a.ageMs, 60000);
    // $102.1 × 900 ≈ 91 890; обсяг 6e6/год = 1e5/хв → ≈ 0.92 хв
    assert.ok(Math.abs(a.eatMin - a.usd / 1e5) < 1e-9);
    assert.ok(a.coverage.askPct > 5);
});

test('forSymbol returns only that symbol and nothing for unknown ones', async () => {
    const { feed } = setup();
    for (let i = 0; i < 3; i++) await feed.pollOnce();
    assert.ok(feed.forSymbol('BBBUSDT').length > 0);
    assert.deepEqual(feed.forSymbol('NOPEUSDT'), []);
});

test('HTTP 429 pauses polling and reports limited; polling resumes after the pause', async () => {
    let limited = true;
    const { feed, calls, statuses, advance } = setup({ respond: () => (limited ? { ok: false, status: 429, json: async () => ({}) } : null) });
    await feed.pollOnce();
    assert.equal(statuses.at(-1)[0], 'limited');
    await feed.pollOnce();                                                       // у паузі — запиту немає
    assert.equal(calls.length, 1);
    limited = false; advance(61000);
    await feed.pollOnce();
    assert.equal(calls.length, 2);
    assert.equal(statuses.at(-1)[0], 'live');
});

test('HTTP 418 (IP ban) is treated like a limit with a longer pause', async () => {
    const { feed, calls, advance } = setup({ respond: () => ({ ok: false, status: 418, json: async () => ({}) }) });
    await feed.pollOnce();
    advance(61000);
    await feed.pollOnce();
    assert.equal(calls.length, 1);                                               // 61 с недостатньо для бану
});

test('repeated failures surface an error with the reason, a good response clears it', async () => {
    let bad = true;
    const { feed, statuses } = setup({ respond: () => (bad ? { ok: false, status: 500, json: async () => ({}) } : null) });
    for (let i = 0; i < 3; i++) await feed.pollOnce();
    assert.deepEqual(statuses.at(-1), ['error', 'HTTP 500']);
    bad = false;
    await feed.pollOnce();
    assert.equal(statuses.at(-1)[0], 'live');
});

test('a malformed book does not create walls and counts as a failure', async () => {
    const { feed } = setup({ respond: () => ({ ok: true, status: 200, json: async () => ({ bids: [], asks: [] }) }) });
    await feed.pollOnce();
    assert.deepEqual(feed.getAll(), []);
});

test('walls of symbols that left the universe are pruned', async () => {
    const syms = [{ symbol: 'AAAUSDT', vol1h: 6e6 }, { symbol: 'BBBUSDT', vol1h: 6e6 }];
    const { feed } = setup({ symbols: syms });
    await feed.pollOnce(); await feed.pollOnce();
    assert.equal(new Set(feed.getAll().map(w => w.symbol)).size, 2);
    syms.pop();
    await feed.pollOnce();
    assert.deepEqual([...new Set(feed.getAll().map(w => w.symbol))], ['AAAUSDT']);
});
