// Збирач публічних даних OKX (USDT-перпетуали): тікери, відкритий інтерес, фандинг, великі заявки («стіни») стакана.
// Ключі й акаунт не потрібні: лише публічні адреси. Запускається з GitHub Actions (collect.yml) раз на 5 хв.
// Чисті функції (parse*, findWalls, buildSnapshot) тестуються без мережі: tests/collector.test.mjs.

export const OKX = 'https://www.okx.com';
export const TOP_N = 30;                 // для скількох монет знімаємо стакан і фандинг
export const BOOK_DEPTH = 400;           // рівнів стакана на сторону (максимум OKX)
export const WALL_RANGE = 0.03;          // дивимось ±3% від ціни
export const WALL_MIN_USD = 50_000;      // стіна не менша за це...
export const WALL_REL = 8;               // ...і не менша за 8 медіан рівня в діапазоні
export const WALLS_PER_SIDE = 5;
const FETCH_TIMEOUT_MS = 10_000;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
export const toSymbol = instId => String(instId).replace(/-USDT-SWAP$/, '') + 'USDT';
const isUsdtSwap = instId => /^[A-Z0-9]+-USDT-SWAP$/.test(instId);

export async function getJson(path, fetchFn = fetch) {
    const r = await fetchFn(OKX + path, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`OKX ${path.split('?')[0]}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== '0') throw new Error(`OKX ${path.split('?')[0]}: code ${j.code} ${j.msg || ''}`);
    return j.data;
}

// ctVal — розмір контракту в монетах (BTC-USDT-SWAP = 0.01 BTC)
export function parseInstruments(data) {
    const out = {};
    for (const x of data) if (isUsdtSwap(x.instId) && x.state === 'live' && num(x.ctVal) > 0) out[x.instId] = { ctVal: num(x.ctVal) };
    return out;
}

// Обсяг за добу в USDT = volCcy24h (монети) * last
export function parseTickers(data, instruments) {
    const rows = [];
    for (const t of data) {
        const meta = instruments[t.instId];
        const last = num(t.last), open = num(t.open24h), coins = num(t.volCcy24h);
        if (!meta || !(last > 0) || !(open > 0) || coins === null) continue;
        rows.push({ id: t.instId, s: toSymbol(t.instId), last, chg24h: Math.round((last / open - 1) * 10000) / 100, volUsd: Math.round(coins * last) });
    }
    return rows.sort((a, b) => b.volUsd - a.volUsd);
}

export function parseOpenInterest(data) {
    const out = {};
    for (const x of data) if (isUsdtSwap(x.instId) && num(x.oiUsd) !== null) out[x.instId] = Math.round(num(x.oiUsd));
    return out;
}

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

// levels: [[price, contracts, ...], ...] від найближчого до ціни; повертає найбільші заявки в діапазоні ±WALL_RANGE
export function findWalls(levels, mid, ctVal) {
    const near = [];
    for (const l of levels) {
        const px = num(l[0]), sz = num(l[1]);
        if (!(px > 0) || !(sz > 0) || Math.abs(px / mid - 1) > WALL_RANGE) continue;
        near.push({ px, usd: px * sz * ctVal });
    }
    if (!near.length) return [];
    const floor = Math.max(WALL_MIN_USD, WALL_REL * median(near.map(l => l.usd)));
    return near.filter(l => l.usd >= floor).sort((a, b) => b.usd - a.usd).slice(0, WALLS_PER_SIDE)
        .map(l => ({ px: l.px, usd: Math.round(l.usd), dist: Math.round((l.px / mid - 1) * 10000) / 100 }));
}

export function parseBook(data, ctVal) {
    const b = data && data[0];
    const bid = b && b.bids && b.bids[0] && num(b.bids[0][0]), ask = b && b.asks && b.asks[0] && num(b.asks[0][0]);
    if (!(bid > 0) || !(ask > 0)) return null;
    const mid = (bid + ask) / 2;
    return { mid, bids: findWalls(b.bids, mid, ctVal), asks: findWalls(b.asks, mid, ctVal) };
}

export function buildSnapshot({ ts, tickers, oi, funding, books }) {
    return {
        ts, ex: 'okx',
        coins: tickers.map(t => ({ s: t.s, last: t.last, chg24h: t.chg24h, volUsd: t.volUsd, oiUsd: oi[t.id] ?? null, fund: funding[t.id] ?? null })),
        walls: books
    };
}

// Один збір. Окремі помилки по монетах не валять збір: пропущене лишається null/відсутнє, а лічильник errors показує масштаб.
export async function collect({ fetchFn = fetch, now = Date.now, topN = TOP_N } = {}) {
    const get = p => getJson(p, fetchFn);
    const [instData, tickData, oiData] = await Promise.all([
        get('/api/v5/public/instruments?instType=SWAP'), get('/api/v5/market/tickers?instType=SWAP'), get('/api/v5/public/open-interest?instType=SWAP')
    ]);
    const instruments = parseInstruments(instData);
    const tickers = parseTickers(tickData, instruments);
    const oi = parseOpenInterest(oiData);
    const funding = {}, books = {};
    let errors = 0;
    for (const t of tickers.slice(0, topN)) {           // послідовно: ліміти OKX (≈20 запитів / 2 с на адресу)
        try {
            const f = await get(`/api/v5/public/funding-rate?instId=${t.id}`);
            funding[t.id] = num(f[0] && f[0].fundingRate);
            const book = parseBook(await get(`/api/v5/market/books?instId=${t.id}&sz=${BOOK_DEPTH}`), instruments[t.id].ctVal);
            if (book) books[t.s] = book; else errors++;
        } catch (e) { errors++; console.error('skip', t.id, e.message); }
        await new Promise(r => setTimeout(r, 120));
    }
    return { ...buildSnapshot({ ts: now(), tickers, oi, funding, books }), errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const snap = await collect();
    if (!snap.coins.length) { console.error('no data'); process.exit(1); }
    process.stdout.write(JSON.stringify(snap) + '\n');
    console.error(`okx: ${snap.coins.length} coins, ${Object.keys(snap.walls).length} books, errors ${snap.errors}`);
}
