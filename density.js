// Плотності (великі лімітні заявки) у книзі ордерів: чисті функції без DOM і мережі.
// Тести: tests/density.test.js. Книга: { bids: [[ціна, к-сть]…], asks: [[ціна, к-сть]…] } (числа).
(function (root) {
    'use strict';

    const DEFAULTS = {
        minUsd: 100000,       // мінімальний розмір плотності в $
        minRatio: 8,          // у скільки разів вона більша за медіанний рівень цього боку книги
        maxDistPct: 5,        // не далі за % від середньої ціни
        perSide: 3            // скільки найбільших плотностей лишати на кожному боці
    };

    function parseLevels(raw) {
        if (!Array.isArray(raw) || !raw.length) return null;
        const out = [];
        for (const l of raw) {
            const p = +l[0], q = +l[1];
            if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q < 0) return null;
            out.push([p, q]);
        }
        return out;
    }

    // Відповідь Binance /depth → числова книга; null, якщо дані зіпсовані або одна зі сторін порожня
    function parseBook(raw) {
        if (!raw) return null;
        const bids = parseLevels(raw.bids), asks = parseLevels(raw.asks);
        if (!bids || !asks) return null;
        return { bids, asks, T: raw.T };
    }

    const mid = book => (book.bids[0][0] + book.asks[0][0]) / 2;

    function median(values) {
        const s = values.filter(v => v > 0).sort((a, b) => a - b);
        if (!s.length) return 0;
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    // На яку відстань (у % від середньої ціни) книга сягає в обидва боки: далі плотності не видно
    function coverage(book) {
        const m = mid(book);
        return {
            bidPct: ((m - book.bids[book.bids.length - 1][0]) / m) * 100,
            askPct: ((book.asks[book.asks.length - 1][0] - m) / m) * 100
        };
    }

    function detectSide(levels, side, m, o) {
        const usd = levels.map(([p, q]) => p * q);
        const base = median(usd);
        if (!base) return [];
        const walls = [];
        levels.forEach(([price, qty], i) => {
            const distPct = (Math.abs(price - m) / m) * 100;
            if (usd[i] >= o.minUsd && usd[i] / base >= o.minRatio && distPct <= o.maxDistPct) {
                walls.push({ side, price, qty, usd: usd[i], ratio: usd[i] / base, distPct });
            }
        });
        return walls.sort((a, b) => b.usd - a.usd).slice(0, o.perSide);   // найбільші першими
    }

    function detect(book, opts) {
        const o = { ...DEFAULTS, ...opts };
        const m = mid(book);
        return [...detectSide(book.bids, 'bid', m, o), ...detectSide(book.asks, 'ask', m, o)];
    }

    // Стежить за життям плотностей: firstSeen зберігається, поки стіна стоїть; зниклі прибираються.
    // Змінює лише записи опитаного символу, повертає нову мапу.
    function track(prev, symbol, walls, now) {
        const next = new Map();
        for (const [k, v] of prev) if (v.symbol !== symbol) next.set(k, v);
        for (const w of walls) {
            const key = `${symbol}|${w.side}|${w.price}`;
            const old = prev.get(key);
            next.set(key, { ...w, symbol, firstSeen: old ? old.firstSeen : now, seenAt: now });
        }
        return next;
    }

    // Скільки хвилин потрібно, щоб «з'їсти» плотність при поточному обсязі торгів ($ за хвилину)
    function eatMinutes(usd, volPerMin) {
        return volPerMin > 0 ? usd / volPerMin : null;
    }

    const api = { DEFAULTS, parseBook, coverage, detect, track, eatMinutes };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Density = api;
})(typeof window !== 'undefined' ? window : globalThis);
