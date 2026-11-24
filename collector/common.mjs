// Спільна основа збирачів публічних даних бірж: розбір стакана на «стіни» і загальний цикл збору.
// Ключі й акаунти не потрібні. Тести: tests/collector.test.mjs, tests/collector-exchanges.test.mjs.

export const TOP_N = 30;                 // для скількох монет знімаємо стакан
export const WALL_RANGE = 0.03;          // дивимось ±3% від ціни
export const WALL_MIN_USD = 50_000;      // стіна не менша за це...
export const WALL_REL = 8;               // ...і не менша за 8 медіан рівня в діапазоні
export const WALLS_PER_SIDE = 5;
export const FETCH_TIMEOUT_MS = 10_000;
const PAUSE_MS = 120;                    // пауза між стаканами: ліміти бірж

export const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

// Читання JSON за базою адреси; validate(json) повертає корисні дані або кидає помилку біржі
export function makeGet(base, validate, fetchFn = fetch) {
    return async path => {
        const where = base.replace(/^https:\/\//, '') + path.split('?')[0];
        const r = await fetchFn(base + path, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`${where}: HTTP ${r.status}`);
        try { return validate(await r.json()); } catch (e) { throw new Error(`${where}: ${e.message}`); }
    };
}

// levels: [[price, size, ...], ...]; mult — скільки USD-монет у одиниці розміру (розмір контракту). Найбільші заявки в ±3%.
export function findWalls(levels, mid, mult) {
    const near = [];
    for (const l of levels) {
        const px = num(l[0]), sz = num(l[1]);
        if (!(px > 0) || !(sz > 0) || Math.abs(px / mid - 1) > WALL_RANGE) continue;
        near.push({ px, usd: px * sz * mult });
    }
    if (!near.length) return [];
    const floor = Math.max(WALL_MIN_USD, WALL_REL * median(near.map(l => l.usd)));
    return near.filter(l => l.usd >= floor).sort((a, b) => b.usd - a.usd).slice(0, WALLS_PER_SIDE)
        .map(l => ({ px: l.px, usd: Math.round(l.usd), dist: Math.round((l.px / mid - 1) * 10000) / 100 }));
}

// bids/asks від найближчого до ціни; null, якщо стакан порожній
export function wallsFromBook(bids, asks, mult) {
    const bid = bids && bids[0] && num(bids[0][0]), ask = asks && asks[0] && num(asks[0][0]);
    if (!(bid > 0) || !(ask > 0)) return null;
    const mid = (bid + ask) / 2;
    return { mid, bids: findWalls(bids, mid, mult), asks: findWalls(asks, mid, mult) };
}

// Загальний збір: loadTickers() → рядки {s,last,chg24h,volUsd,oiUsd,fund,...} (від найбільшого обсягу);
// loadBook(row) → {bids, asks, mult}. Помилка по окремій монеті не валить збір.
export async function collectGeneric({ ex, loadTickers, loadBook, now = Date.now, topN = TOP_N, pauseMs = PAUSE_MS }) {
    const rows = await loadTickers();
    if (!rows.length) throw new Error(`${ex}: порожній список монет`);
    const walls = {};
    let errors = 0;
    for (const row of rows.slice(0, topN)) {
        try {
            const b = await loadBook(row);
            const w = wallsFromBook(b.bids, b.asks, b.mult);
            if (w) walls[row.s] = w; else errors++;
        } catch (e) { errors++; console.error(`${ex} skip`, row.s, e.message); }
        if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }
    const coins = rows.map(r => ({ s: r.s, last: r.last, chg24h: r.chg24h, volUsd: r.volUsd, oiUsd: r.oiUsd ?? null, fund: r.fund ?? null }));
    return { ts: now(), ex, coins, walls, errors };
}
