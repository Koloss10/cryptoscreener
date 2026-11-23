// Тести шару даних з підробленими fetch і WebSocket: node --test tests/
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Metrics = require('../metrics.js');
const { createFeed } = require('../feed.js');

class FakeWS {
    constructor(url) { this.url = url; this.closed = false; FakeWS.all.push(this); }
    close() { this.closed = true; }
    open() { this.onopen && this.onopen(); }
    emit(stream, data) { this.onmessage({ data: JSON.stringify({ stream, data }) }); }
    drop() { this.onclose && this.onclose(); }
}
FakeWS.all = [];

const T = (symbol, q, chg = '1') => ({ symbol, lastPrice: '10', priceChangePercent: chg, quoteVolume: String(q) });
const klines = n => Array.from({ length: n }, (_, i) => [i * 60000, '10', '11', '9', '10', '1', 0, '100']);
const flush = () => new Promise(r => setImmediate(r));

const feeds = [];
afterEach(() => { feeds.splice(0).forEach(f => f.stop()); });   // навіть якщо тест впав — таймери не тримають процес

function setup(extra = {}) {
    FakeWS.all = [];
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (extra.fail && extra.fail(url)) return { ok: false, status: 500, json: async () => ({}) };
        if (url.includes('/ticker/24hr')) return { ok: true, json: async () => [T('AAAUSDT', 300), T('BBBUSDT', 200), T('CCCUSDT', 100), T('DEAD_250101', 999), T('XYZBTC', 50)] };
        return { ok: true, json: async () => klines(130) };
    };
    const rows = [], statuses = [];
    let clock = 0;
    const feed = createFeed({
        Metrics, fetchImpl, WebSocketImpl: FakeWS, topN: 2, refreshMs: 1e9, staleMs: 15000,
        reconnectMinMs: 1, reconnectMaxMs: 4, now: () => clock,
        onRows: r => rows.push(r), onStatus: s => statuses.push(s)
    });
    feeds.push(feed);
    return { feed, calls, rows, statuses, setClock: v => { clock = v; } };
}

test('picks top-N USDT perpetuals by 24h volume, ignoring delivery contracts and non-USDT pairs', async () => {
    const { feed, calls } = setup();
    feed.start(); await flush(); await flush(); await flush();
    const klineSyms = calls.filter(u => u.includes('/klines')).map(u => /symbol=(\w+)/.exec(u)[1]).sort();
    assert.deepEqual(klineSyms, ['AAAUSDT', 'BBBUSDT']);
    feed.stop();
});

test('subscribes to kline streams for the universe plus miniTicker and markPrice arrays', async () => {
    const { feed } = setup();
    feed.start(); await flush(); await flush(); await flush();
    const url = FakeWS.all[0].url;
    assert.match(url, /aaausdt@kline_1m/);
    assert.match(url, /bbbusdt@kline_1m/);
    assert.match(url, /!miniTicker@arr/);
    assert.match(url, /!markPrice@arr@1s/);
    feed.stop();
});

test('applies kline, miniTicker and funding messages to rows on tick', async () => {
    const { feed, rows, statuses } = setup();
    feed.start(); await flush(); await flush(); await flush();
    const ws = FakeWS.all[0]; ws.open();
    assert.equal(statuses.at(-1), 'live');
    ws.emit('aaausdt@kline_1m', { s: 'AAAUSDT', k: { t: 129 * 60000, o: '10', h: '30', l: '9', c: '25', v: '1', q: '500' } });
    ws.emit('!miniTicker@arr', [{ s: 'AAAUSDT', c: '25', o: '20', q: '777' }]);
    ws.emit('!markPrice@arr@1s', [{ s: 'AAAUSDT', r: '0.0003' }]);
    feed.tick();
    const a = rows.at(-1).find(r => r.symbol === 'AAAUSDT');
    assert.equal(a.price, 25);
    assert.equal(a.chg24, 25);        // (25-20)/20
    assert.equal(a.vol24, 777);
    assert.equal(a.funding, 0.0003);
    feed.stop();
});

test('ignores malformed messages and unknown symbols without throwing', async () => {
    const { feed } = setup();
    feed.start(); await flush(); await flush(); await flush();
    const ws = FakeWS.all[0]; ws.open();
    ws.onmessage({ data: 'not json' });
    ws.emit('zzzusdt@kline_1m', { s: 'ZZZUSDT', k: { t: 1, o: '1', h: '1', l: '1', c: '1', v: '1', q: '1' } });
    assert.doesNotThrow(() => feed.tick());
    feed.stop();
});

test('a failing history request for one symbol does not stop the feed', async () => {
    const { feed, statuses } = setup({ fail: u => u.includes('symbol=BBBUSDT') });
    feed.start(); await flush(); await flush(); await flush();
    FakeWS.all[0].open();
    assert.equal(statuses.at(-1), 'live');
    const syms = feed.getRows().map(r => r.symbol);
    assert.deepEqual(syms.sort(), ['AAAUSDT', 'BBBUSDT']);
    assert.equal(feed.getRows().find(r => r.symbol === 'BBBUSDT').natr5, null);
    feed.stop();
});

test('socket close triggers reconnect with a fresh socket and history reload', async () => {
    const { feed, calls, statuses } = setup();
    feed.start(); await flush(); await flush(); await flush();
    const first = FakeWS.all[0]; first.open();
    const before = calls.filter(u => u.includes('/ticker/24hr')).length;
    first.drop();
    assert.equal(statuses.at(-1), 'reconnecting');
    await new Promise(r => setTimeout(r, 20)); await flush(); await flush(); await flush();
    assert.equal(FakeWS.all.length, 2);
    assert.equal(calls.filter(u => u.includes('/ticker/24hr')).length, before + 1);
    feed.stop();
});

test('silence longer than staleMs forces a reconnect', async () => {
    const { feed, statuses, setClock } = setup();
    feed.start(); await flush(); await flush(); await flush();
    FakeWS.all[0].open();
    setClock(16000);
    feed.tick();
    assert.equal(statuses.at(-1), 'reconnecting');
    feed.stop();
});

test('stop closes the socket and prevents later reconnects', async () => {
    const { feed } = setup();
    feed.start(); await flush(); await flush(); await flush();
    const ws = FakeWS.all[0]; ws.open();
    feed.stop();
    assert.equal(ws.closed, true);
    ws.drop();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(FakeWS.all.length, 1);
});

test('ticker request failure reports error and retries', async () => {
    const { feed, statuses } = setup({ fail: u => u.includes('/ticker/24hr') });
    feed.start(); await flush(); await flush();
    assert.ok(statuses.includes('error'));
    assert.equal(statuses.at(-1), 'reconnecting');
    feed.stop();
});
