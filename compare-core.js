// Порівняння однієї монети на кількох біржах: чиста логіка без DOM і мережі (tests/compare-core.test.js).
// Ціни зі знімків бірж знято в різний час (до кількох хвилин різниці), тому відхилення — орієнтир, а не арбітражна можливість.
(function (root) {
    'use strict';

    const STALE_MS = 15 * 60000;

    const pct = (a, b) => (a / b - 1) * 100;
    const round2 = v => Math.round(v * 100) / 100;
    function median(values) {
        const s = values.slice().sort((a, b) => a - b), m = s.length >> 1;
        return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
    }

    // sources: [{ ex, name, rows | null, ageMs | null, error? }]; rows — рядки таблиці скринера (symbol, price, chg24, vol24, oi, funding, wallUsd, wallDist)
    function compare(symbol, sources, staleMs = STALE_MS) {
        const items = sources.map(src => {
            const row = src.rows ? src.rows.find(r => r.symbol === symbol) || null : null;
            const stale = row !== null && src.ageMs !== null && src.ageMs > staleMs;
            return { ex: src.ex, name: src.name, row, ageMs: src.ageMs, stale, loaded: !!src.rows, error: src.error || '' };
        });
        const fresh = items.filter(i => i.row && !i.stale && i.row.price > 0);
        const med = median(fresh.map(i => i.row.price));
        for (const i of items) i.dev = i.row && !i.stale && med ? round2(pct(i.row.price, med)) : null;

        let priceSpread = null;
        if (fresh.length >= 2) {
            const sorted = fresh.slice().sort((a, b) => a.row.price - b.row.price);
            const lo = sorted[0], hi = sorted[sorted.length - 1];
            priceSpread = { pct: round2(pct(hi.row.price, lo.row.price)), lo: lo.name, hi: hi.name };
        }
        const withFunding = fresh.filter(i => i.row.funding !== null && i.row.funding !== undefined);
        let fundingSpread = null;
        if (withFunding.length >= 2) {
            const sorted = withFunding.slice().sort((a, b) => a.row.funding - b.row.funding);
            const lo = sorted[0], hi = sorted[sorted.length - 1];
            fundingSpread = { diff: hi.row.funding - lo.row.funding, lo: lo.name, hi: hi.name };
        }
        return { symbol, items, median: med, freshCount: fresh.length, priceSpread, fundingSpread };
    }

    // Список монет для підказок: монети, що є хоча б на двох біржах, за сумарним обсягом
    function commonSymbols(sources, limit = 200) {
        const total = new Map(), count = new Map();
        for (const src of sources) {
            if (!src.rows) continue;
            for (const r of src.rows) {
                total.set(r.symbol, (total.get(r.symbol) || 0) + (r.vol24 || 0));
                count.set(r.symbol, (count.get(r.symbol) || 0) + 1);
            }
        }
        return [...total.keys()].filter(s => count.get(s) >= 2).sort((a, b) => total.get(b) - total.get(a)).slice(0, limit);
    }

    const api = { STALE_MS, compare, commonSymbols, median };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CompareCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
