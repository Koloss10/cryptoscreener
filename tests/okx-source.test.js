const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSnapshot, createOkxFeed } = require('../okx-source.js');

const SNAP = {
    ts: 1_000_000, ex: 'okx',
    coins: [
        { s: 'BTCUSDT', last: 60000, chg24h: -2.5, volUsd: 8e9, oiUsd: 1.8e9, fund: 0.0001 },
        { s: 'XYZUSDT', last: 1, chg24h: 0, volUsd: 1e6, oiUsd: null, fund: null }
    ],
    walls: { BTCUSDT: { mid: 60000, bids: [{ px: 59900, usd: 500000, dist: -0.17 }], asks: [{ px: 60100, usd: 900000, dist: 0.17 }] } }
};

test('parseSnapshot maps coins and picks the biggest wall of both sides', () => {
    const rows = parseSnapshot(SNAP);
    assert.deepEqual(rows[0], { symbol: 'BTCUSDT', price: 60000, chg24: -2.5, vol24: 8e9, oi: 1.8e9, funding: 0.0001, wallUsd: 900000, wallDist: 0.17 });
    assert.deepEqual(rows[1], { symbol: 'XYZUSDT', price: 1, chg24: 0, vol24: 1e6, oi: null, funding: null, wallUsd: null, wallDist: null });
});

test('parseSnapshot rejects foreign or broken data', () => {
    assert.throws(() => parseSnapshot(null), /формат/);
    assert.throws(() => parseSnapshot({ ex: 'bybit', coins: [], ts: 1 }), /формат/);
    assert.throws(() => parseSnapshot({ ex: 'okx', coins: 'x', ts: 1 }), /формат/);
    assert.throws(() => parseSnapshot({ ex: 'okx', coins: [] }), /формат/);
});

const run = async (fetchImpl, now) => {
    const log = { rows: null, statuses: [] };
    const feed = createOkxFeed({ fetchImpl, now: () => now, onRows: (r, age) => { log.rows = r; log.age = age; }, onStatus: (s, d) => log.statuses.push([s, d]) });
    await feed.poll();
    return log;
};

test('a fresh snapshot is live', async () => {
    const log = await run(async () => ({ ok: true, json: async () => SNAP }), SNAP.ts + 60_000);
    assert.equal(log.rows.length, 2);
    assert.deepEqual(log.statuses, [['live', '']]);
});

test('an old snapshot still shows rows but is flagged as stale with the age', async () => {
    const log = await run(async () => ({ ok: true, json: async () => SNAP }), SNAP.ts + 40 * 60000);
    assert.equal(log.rows.length, 2);
    assert.equal(log.statuses[0][0], 'reconnecting');
    assert.match(log.statuses[0][1], /застаріли на 40 хв/);
});

test('HTTP and network errors become an error status, no rows', async () => {
    let log = await run(async () => ({ ok: false, status: 404 }), SNAP.ts);
    assert.equal(log.rows, null);
    assert.match(log.statuses[0][1], /HTTP 404/);
    log = await run(async () => { throw new Error('offline'); }, SNAP.ts);
    assert.match(log.statuses[0][1], /offline/);
});

test('a result that arrives after stop() is ignored', async () => {
    const log = { rows: null, statuses: [] };
    let release;
    const feed = createOkxFeed({ fetchImpl: () => new Promise(r => { release = () => r({ ok: true, json: async () => SNAP }); }), now: () => SNAP.ts, onRows: r => { log.rows = r; }, onStatus: s => log.statuses.push(s) });
    const p = feed.poll();
    feed.stop();
    release();
    await p;
    assert.equal(log.rows, null);
    assert.deepEqual(log.statuses, []);
});
