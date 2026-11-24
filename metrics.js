// Чисті функції метрик скрінера (без DOM і мережі). Тести: tests/metrics.test.js.
// Свічка: { time (мс, початок), open, high, low, close, vol (база), quote (обсяг у $) }.
(function (root) {
    'use strict';

    const MINUTE_MS = 60000;

    // Склеює 1-хвилинні свічки в n-хвилинні (вирівняні за UTC). Початковий неповний бакет відкидається,
    // останній (поточний) лишається.
    function aggregate(candles, n) {
        if (!candles.length) return [];
        const span = n * MINUTE_MS;
        const buckets = new Map();
        for (const c of candles) {
            const key = Math.floor(c.time / span) * span;
            const b = buckets.get(key);
            if (!b) {
                buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol, quote: c.quote, count: 1 });
            } else {
                b.high = Math.max(b.high, c.high);
                b.low = Math.min(b.low, c.low);
                b.close = c.close;
                b.vol += c.vol;
                b.quote += c.quote;
                b.count++;
            }
        }
        const out = [...buckets.values()];
        if (out.length > 1 && out[0].count < n) out.shift();
        return out.map(({ count, ...c }) => c);
    }

    // NATR = ATR(period) за Вайлдером / остання ціна закриття × 100
    function natr(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const tr = [];
        for (let i = 1; i < candles.length; i++) {
            const c = candles[i], pc = candles[i - 1].close;
            tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
        }
        let atr = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
        for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
        const last = candles[candles.length - 1].close;
        return last > 0 ? (atr / last) * 100 : null;
    }

    function pctChange(candles, minutes) {
        if (candles.length <= minutes) return null;
        const past = candles[candles.length - 1 - minutes].close;
        return past > 0 ? (candles[candles.length - 1].close / past - 1) * 100 : null;
    }

    function quoteVolume(candles, minutes) {
        if (candles.length < minutes) return null;
        let sum = 0;
        for (let i = candles.length - minutes; i < candles.length; i++) sum += candles[i].quote;
        return sum;
    }

    // Обсяг останнього вікна проти середнього обсягу попередніх вікон такої ж довжини
    function volumeSpike(candles, windowMin = 5, baselineWindows = 12) {
        const need = windowMin * (baselineWindows + 1);
        if (candles.length < need) return null;
        const last = quoteVolume(candles, windowMin);
        const before = candles.slice(candles.length - need, candles.length - windowMin);
        const baseline = before.reduce((s, c) => s + c.quote, 0) / baselineWindows;
        return baseline > 0 ? last / baseline : null;
    }

    function buildRow(symbol, candles1m, ticker, funding) {
        const last = candles1m.length ? candles1m[candles1m.length - 1] : null;
        const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? null : +v);
        return {
            symbol,
            price: last ? last.close : num(ticker && ticker.lastPrice),
            chg24: num(ticker && ticker.priceChangePercent),
            chg5: pctChange(candles1m, 5),
            chg15: pctChange(candles1m, 15),
            chg60: pctChange(candles1m, 60),
            vol24: num(ticker && ticker.quoteVolume),
            vol1h: quoteVolume(candles1m, 60),
            spike: volumeSpike(candles1m, 5, 12),
            natr5: natr(aggregate(candles1m, 5), 14),
            funding: funding === undefined ? null : funding
        };
    }

    // Фільтри скрінера: відсутнє значення метрики не проходить активний поріг
    function filterRows(rows, f) {
        const search = (f.search || '').trim().toLowerCase();
        return rows.filter(r => {
            if (search && !r.symbol.toLowerCase().includes(search)) return false;
            if (f.minVol1h && !(r.vol1h !== null && r.vol1h >= f.minVol1h)) return false;
            if (f.minNatr && !(r.natr5 !== null && r.natr5 >= f.minNatr)) return false;
            if (f.minSpike && !(r.spike !== null && r.spike >= f.minSpike)) return false;
            return true;
        });
    }

    function sortRows(rows, key, dir) {
        const sign = dir === 'asc' ? 1 : -1;
        return rows.slice().sort((a, b) => {
            const av = a[key], bv = b[key];
            if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
            if (bv === null || bv === undefined) return -1;
            if (typeof av === 'string') return sign * av.localeCompare(bv);
            return sign * (av - bv);
        });
    }

    // Оновлює масив 1-хвилинних свічок подією kline (без мутації); cap обмежує довжину історії
    function applyKline(candles, candle, cap) {
        const out = candles.slice();
        const last = out[out.length - 1];
        if (last && last.time === candle.time) out[out.length - 1] = candle;
        else if (!last || candle.time > last.time) out.push(candle);
        return out.length > cap ? out.slice(out.length - cap) : out;
    }

    function parseKline(msg) {
        const k = msg.k;
        return { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, vol: +k.v, quote: +k.q };
    }

    // Правила підсвітки: { key, op: '>=' | '<=', value } у «сирих» одиницях колонки. Невалідні відкидаємо, дублі прибираємо.
    const RULE_OPS = { '>=': (v, x) => v >= x, '<=': (v, x) => v <= x };
    const MAX_RULES = 12;
    function normalizeRules(list, validKeys) {
        if (!Array.isArray(list)) return [];
        const seen = new Set(), out = [];
        for (const r of list) {
            if (!r || typeof r.key !== 'string' || !validKeys.includes(r.key) || !RULE_OPS[r.op]) continue;
            const value = Number(r.value);
            if (!Number.isFinite(value)) continue;
            const id = r.key + r.op + value;
            if (seen.has(id)) continue;
            seen.add(id); out.push({ key: r.key, op: r.op, value });
            if (out.length >= MAX_RULES) break;
        }
        return out;
    }
    const ruleHit = (rules, key, v) => typeof v === 'number' && Number.isFinite(v) && rules.some(r => r.key === key && RULE_OPS[r.op](v, r.value));

    const api = { MAX_RULES, normalizeRules, ruleHit, aggregate, natr, pctChange, quoteVolume, volumeSpike, buildRow, filterRows, sortRows, applyKline, parseKline };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Metrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
