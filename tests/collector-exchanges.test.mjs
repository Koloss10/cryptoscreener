import test from 'node:test';
import assert from 'node:assert/strict';
import { collect as bitget, parseTickers as bgTickers } from '../collector/bitget.mjs';
import { collect as gate, parseTickers as gtTickers } from '../collector/gate.mjs';
import { collect as mexc, parseTickers as mxTickers, parseContractSizes } from '../collector/mexc.mjs';
import { collectGeneric } from '../collector/common.mjs';

const json = body => ({ ok: true, json: async () => body });
const bg = (px, n = 30) => Array.from({ length: n }, (_, i) => [px + i * 10 * (px > 59000 ? 1 : -1), 1]);   // фон ≈ $600 на рівень

// ---------- Bitget ----------
const BG_TICK = [
    { symbol: 'BTCUSDT', lastPr: '60000', change24h: '-0.0263', usdtVolume: '3179894326.6', holdingAmount: '35615.89', fundingRate: '0.000027', deliveryTime: null },
    { symbol: 'XYZUSDT', lastPr: '1', change24h: '0.01', usdtVolume: '5', holdingAmount: '1', fundingRate: '0', deliveryTime: '1800000000000' },   // квартальний — пропускаємо
    { symbol: 'BADUSDT', lastPr: 'x', change24h: '0', usdtVolume: '1', deliveryTime: null }
];

test('bitget tickers: percent from fraction, OI in USDT = coins * price, delivery contracts skipped', () => {
    assert.deepEqual(bgTickers(BG_TICK), [{ s: 'BTCUSDT', last: 60000, chg24h: -2.63, volUsd: 3179894327, oiUsd: 2136953400, fund: 0.000027 }]);
});

test('bitget collect: walls from merge-depth, sizes in coins', async () => {
    const fetchFn = async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/tickers')) return json({ code: '00000', data: BG_TICK });
        if (u.pathname.endsWith('/merge-depth')) {
            assert.equal(u.searchParams.get('symbol'), 'BTCUSDT');
            return json({ code: '00000', data: { bids: [...bg(59990, 30).map(([p, s]) => [p - 2 * (p - 59990), s]), [59000, 50]], asks: [...bg(60010, 30), [61000, 50]] } });
        }
        throw new Error('unexpected ' + url);
    };
    const snap = await bitget({ fetchFn, now: () => 5, pauseMs: 0 });
    assert.equal(snap.ex, 'bitget'); assert.equal(snap.errors, 0);
    assert.equal(snap.walls.BTCUSDT.asks[0].px, 61000);
    assert.equal(snap.walls.BTCUSDT.asks[0].usd, 3050000);                        // 50 BTC * 61000
});

test('bitget: an exchange error code is a failure, not empty data', async () => {
    await assert.rejects(bitget({ fetchFn: async () => json({ code: '40001', msg: 'bad' }), pauseMs: 0 }), /40001/);
});

// ---------- Gate ----------
const GT_TICK = [
    { contract: 'BTC_USDT', last: '60000', change_percentage: '-2.5', volume_24h_quote: '8000000000', funding_rate: '0.0001', total_size: '1000000', mark_price: '60010', quanto_multiplier: '0.0001' },
    { contract: 'BTC_USD', last: '60000', change_percentage: '1', volume_24h_quote: '1', quanto_multiplier: '1' },
    { contract: 'NOMULT_USDT', last: '1', change_percentage: '1', volume_24h_quote: '1' }
];

test('gate tickers: only USDT contracts with a multiplier; OI = size * multiplier * mark', () => {
    assert.deepEqual(gtTickers(GT_TICK), [{ s: 'BTCUSDT', contract: 'BTC_USDT', mult: 0.0001, last: 60000, chg24h: -2.5, volUsd: 8000000000, oiUsd: 6001000, fund: 0.0001 }]);
});

test('gate collect: order book objects {p,s} in contracts are converted with the multiplier', async () => {
    const lv = (from, step) => Array.from({ length: 30 }, (_, i) => ({ p: String(from + step * i), s: 1000 }));       // 1000*0.0001*60000 = $6000 фон
    const fetchFn = async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/tickers')) return json(GT_TICK);
        if (u.pathname.endsWith('/order_book')) return json({ asks: [...lv(60010, 10), { p: '61000', s: 100000 }], bids: [...lv(59990, -10), { p: '59000', s: 100000 }] });
        throw new Error('unexpected ' + url);
    };
    const snap = await gate({ fetchFn, pauseMs: 0 });
    assert.equal(snap.walls.BTCUSDT.asks[0].usd, 610000);                           // 100000 * 0.0001 * 61000
    assert.equal(snap.walls.BTCUSDT.bids[0].px, 59000);
});

test('gate: an API error object is a failure', async () => {
    await assert.rejects(gate({ fetchFn: async () => json({ label: 'TOO_MANY_REQUESTS', message: 'slow down' }), pauseMs: 0 }), /TOO_MANY_REQUESTS/);
});

// ---------- MEXC ----------
const MX_DETAIL = [{ symbol: 'BTC_USDT', state: 0, contractSize: 0.0001 }, { symbol: 'OLD_USDT', state: 1, contractSize: 1 }, { symbol: 'BTC_USD', state: 0, contractSize: 100 }];
const MX_TICK = [
    { symbol: 'BTC_USDT', lastPrice: 60000, riseFallRate: 0.0005, amount24: 3563392013, holdVol: 500000000, fundingRate: 0.00008 },
    { symbol: 'OLD_USDT', lastPrice: 1, riseFallRate: 0, amount24: 1, holdVol: 1 }
];

test('mexc: only live USDT contracts; percent from fraction; OI = contracts * size * price', () => {
    const sizes = parseContractSizes(MX_DETAIL);
    assert.deepEqual(sizes, { BTC_USDT: 0.0001 });
    assert.deepEqual(mxTickers(MX_TICK, sizes), [{ s: 'BTCUSDT', contract: 'BTC_USDT', mult: 0.0001, last: 60000, chg24h: 0.05, volUsd: 3563392013, oiUsd: 3000000000, fund: 0.00008 }]);
});

test('mexc collect: depth levels [price, contracts, orders] converted with contractSize', async () => {
    const lv = (from, step) => Array.from({ length: 30 }, (_, i) => [from + step * i, 10000, 1]);                     // 10000*0.0001*60000 = $60000 фон
    const fetchFn = async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/detail')) return json({ success: true, data: MX_DETAIL });
        if (u.pathname.endsWith('/ticker')) return json({ success: true, data: MX_TICK });
        if (u.pathname.includes('/depth/BTC_USDT')) return json({ success: true, data: { asks: [...lv(60010, 10), [61000, 10000000, 3]], bids: [...lv(59990, -10), [59000, 10000000, 3]] } });
        throw new Error('unexpected ' + url);
    };
    const snap = await mexc({ fetchFn, pauseMs: 0 });
    assert.equal(snap.walls.BTCUSDT.asks[0].usd, 61000000);                          // 1e7 * 0.0001 * 61000
});

test('mexc: success=false is a failure', async () => {
    await assert.rejects(mexc({ fetchFn: async () => json({ success: false, code: 600 }), pauseMs: 0 }), /code 600/);
});

// ---------- спільна частина ----------
test('collectGeneric counts failing and empty books, keeps the rest, and refuses an empty coin list', async () => {
    const rows = [{ s: 'AAAUSDT', last: 1, chg24h: 0, volUsd: 3 }, { s: 'BBBUSDT', last: 1, chg24h: 0, volUsd: 2 }, { s: 'CCCUSDT', last: 1, chg24h: 0, volUsd: 1 }];
    const loadBook = async r => { if (r.s === 'AAAUSDT') throw new Error('boom'); if (r.s === 'BBBUSDT') return { bids: [], asks: [], mult: 1 }; return { bids: [[1, 1]], asks: [[1.01, 1]], mult: 1 }; };
    const snap = await collectGeneric({ ex: 't', loadTickers: async () => rows, loadBook, pauseMs: 0 });
    assert.equal(snap.errors, 2);
    assert.deepEqual(Object.keys(snap.walls), ['CCCUSDT']);
    assert.equal(snap.coins.length, 3);
    await assert.rejects(collectGeneric({ ex: 't', loadTickers: async () => [], loadBook, pauseMs: 0 }), /порожній/);
});
