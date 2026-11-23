// Чисті функції аналізу свічок (без DOM) — використовуються скрінером; тестуються в tests/analysis.test.js.
// Свічка: { time, open, high, low, close, vol }. Масив впорядкований від старої до нової; остання — закрита.
(function (root) {
    'use strict';

    const BREAKOUT_LOOKBACK = 20;
    const FVG_LOOKBACK = 20;
    const NEAR_LEVEL_PCT = 0.5;      // «біля рівня», % від ціни
    const PIN_WICK_TO_BODY = 2;      // тінь ≥ 2 тіл для пін-бара

    function sma(values, period) {
        if (values.length < period) return null;
        let sum = 0;
        for (let i = values.length - period; i < values.length; i++) sum += values[i];
        return sum / period;
    }

    function ema(values, period) {
        if (values.length < period) return null;
        const k = 2 / (period + 1);
        let e = sma(values.slice(0, period), period);
        for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
        return e;
    }

    // RSI за Вайлдером (згладжування 1/period)
    function rsi(closes, period = 14) {
        if (closes.length <= period) return null;
        let gain = 0, loss = 0;
        for (let i = 1; i <= period; i++) {
            const d = closes[i] - closes[i - 1];
            if (d >= 0) gain += d; else loss -= d;
        }
        gain /= period; loss /= period;
        for (let i = period + 1; i < closes.length; i++) {
            const d = closes[i] - closes[i - 1];
            gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
            loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
        }
        if (loss === 0) return gain === 0 ? 50 : 100;
        return 100 - 100 / (1 + gain / loss);
    }

    // Пробій екстремуму попередніх N свічок (остання свічка в діапазон не входить)
    function breakout(cs, lookback = BREAKOUT_LOOKBACK) {
        if (cs.length < lookback + 1) return null;
        const last = cs[cs.length - 1];
        const prior = cs.slice(-lookback - 1, -1);
        const hi = Math.max(...prior.map(c => c.high));
        const lo = Math.min(...prior.map(c => c.low));
        if (last.close > hi) return { type: 'up', level: hi };
        if (last.close < lo) return { type: 'down', level: lo };
        return null;
    }

    // Найближчий рівень підтримки/опору (екстремум N свічок) у межах NEAR_LEVEL_PCT
    function nearLevel(cs, lookback = BREAKOUT_LOOKBACK) {
        if (cs.length < lookback + 1) return null;
        const last = cs[cs.length - 1];
        const prior = cs.slice(-lookback - 1, -1);
        const hi = Math.max(...prior.map(c => c.high));
        const lo = Math.min(...prior.map(c => c.low));
        if (Math.abs(last.close - hi) / hi * 100 <= NEAR_LEVEL_PCT) return { type: 'resistance', level: hi };
        if (Math.abs(last.close - lo) / lo * 100 <= NEAR_LEVEL_PCT) return { type: 'support', level: lo };
        return null;
    }

    // Свічковий патерн на останній закритій свічці
    function candlePattern(cs) {
        if (cs.length < 2) return null;
        const c = cs[cs.length - 1], p = cs[cs.length - 2];
        const body = Math.abs(c.close - c.open), pBody = Math.abs(p.close - p.open);
        const upper = c.high - Math.max(c.open, c.close);
        const lower = Math.min(c.open, c.close) - c.low;
        if (p.close < p.open && c.close > c.open && c.close >= p.open && c.open <= p.close && body > pBody) return 'Бичаче поглинання';
        if (p.close > p.open && c.close < c.open && c.close <= p.open && c.open >= p.close && body > pBody) return 'Ведмеже поглинання';
        if (body > 0 && lower >= body * PIN_WICK_TO_BODY && upper <= body) return 'Молот (пін-бар)';
        if (body > 0 && upper >= body * PIN_WICK_TO_BODY && lower <= body) return 'Падаюча зірка (пін-бар)';
        return null;
    }

    // Остання незакрита цінова прогалина (FVG) за 3 свічки; age — скільки свічок тому сформована
    function lastFvg(cs, lookback = FVG_LOOKBACK) {
        const n = cs.length;
        for (let i = n - 1; i >= Math.max(2, n - lookback); i--) {
            const a = cs[i - 2], c = cs[i];
            let gap = null;
            if (c.low > a.high) gap = { type: 'bull', bottom: a.high, top: c.low };
            else if (c.high < a.low) gap = { type: 'bear', bottom: c.high, top: a.low };
            if (!gap) continue;
            const after = cs.slice(i + 1);
            const filled = gap.type === 'bull'
                ? after.some(x => x.low <= gap.bottom)
                : after.some(x => x.high >= gap.top);
            if (!filled) return { ...gap, age: n - 1 - i };
        }
        return null;
    }

    function analyze(cs) {
        if (!Array.isArray(cs) || cs.length < 30) return null;
        const closes = cs.map(c => c.close);
        const e20 = ema(closes, 20), e50 = closes.length >= 50 ? ema(closes, 50) : null;
        const last = closes[closes.length - 1];
        return {
            rsi: rsi(closes),
            trend: e50 === null ? null : (last > e20 && e20 > e50 ? 'up' : last < e20 && e20 < e50 ? 'down' : 'flat'),
            breakout: breakout(cs),
            nearLevel: nearLevel(cs),
            candle: candlePattern(cs),
            fvg: lastFvg(cs)
        };
    }

    const api = { sma, ema, rsi, breakout, nearLevel, candlePattern, lastFvg, analyze };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Analysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
