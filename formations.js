// Формації: пошук торгових ситуацій на закритих 1m-свічках, відстеження результату й статистика.
// Чисті функції без DOM і мережі. Тести: tests/formations.test.js. Це аналітика, а не рекомендація.
// Свічка: { time, open, high, low, close, vol, quote } — остання в масиві ще формується й не аналізується.
(function (root) {
    'use strict';

    const MIN = 60000;
    const P = {
        lookback: 60,            // рівень = екстремум останніх 60 закритих хвилин
        minHistory: 62,          // потрібно закритих свічок
        atrPeriod: 14,
        volConfirm: 2,           // обсяг свічки пробою ≥ 2× середнього за 20 хв
        retestWindow: 30,        // ретест шукаємо не далі ніж за 30 хв після пробою
        retestTol: 0.0015,       // «торкнулась рівня»: у межах 0.15%
        failTol: 0.002,          // закриття глибше 0.2% за рівень скасовує пробій
        surgeX: 3,               // обсяг 5 хв ≥ 3× середнього 5-хвилинного за попередню годину
        surgeMovePct: 0.6,       // і рух ціни за 5 хв ≥ 0.6%
        bounceTouch: 0.001,      // торкання плотності у межах 0.1%
        bounceNearPct: 0.5,      // плотність не далі 0.5% від ціни
        wallMinAgeMs: 60000,     // плотність мала простояти хоча б хвилину
        rr: 2,                   // тейк = 2 × ризик
        maxRiskPct: 2,           // ризик більший за 2% ціни — сигнал відкидаємо
        cooldownMs: 30 * MIN,    // повторна формація того ж типу й боку по монеті — не раніше ніж за 30 хв
        horizonMs: 60 * MIN,     // скільки чекаємо тейк/стоп, потім «закінчився час»
        coverGapMs: 2 * MIN,     // перша свічка після сигналу має бути не пізніше за це, інакше шлях невідомий
        maxSignals: 500
    };

    const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const maxHigh = cs => Math.max(...cs.map(c => c.high));
    const minLow = cs => Math.min(...cs.map(c => c.low));

    function atr(cs, period = P.atrPeriod) {
        const tail = cs.slice(-(period + 1));
        const tr = [];
        for (let i = 1; i < tail.length; i++) {
            tr.push(Math.max(tail[i].high - tail[i].low, Math.abs(tail[i].high - tail[i - 1].close), Math.abs(tail[i].low - tail[i - 1].close)));
        }
        return mean(tr);
    }

    function build(symbol, type, side, last, level, stop) {
        const entry = last.close;
        const risk = side === 'long' ? entry - stop : stop - entry;
        if (!(risk > 0) || (risk / entry) * 100 > P.maxRiskPct) return null;
        const take = side === 'long' ? entry + P.rr * risk : entry - P.rr * risk;
        return { id: `${symbol}|${type}|${side}|${last.time}`, symbol, type, side, time: last.time, level, entry, stop, take, status: 'open', r: null };
    }

    const volOk = (candle, prior) => candle.quote >= P.volConfirm * mean(prior.slice(-20).map(c => c.quote));

    function breakouts(symbol, closed, a) {
        const n = closed.length, last = closed[n - 1], before = closed.slice(0, n - 1);
        const window = before.slice(-P.lookback), hi = maxHigh(window), lo = minLow(window);
        if (!volOk(last, before)) return [];
        if (last.close > hi) return [build(symbol, 'breakout', 'long', last, hi, hi - 0.5 * a)];
        if (last.close < lo) return [build(symbol, 'breakout', 'short', last, lo, lo + 0.5 * a)];
        return [];
    }

    // Знаходить останній пробій у вікні ретесту, який ще не провалився
    function findBrokenLevel(closed, side) {
        const n = closed.length;
        for (let j = n - 2; j >= Math.max(P.lookback, n - 1 - P.retestWindow); j--) {
            const window = closed.slice(j - P.lookback, j);
            const level = side === 'long' ? maxHigh(window) : minLow(window);
            const broke = side === 'long' ? closed[j].close > level : closed[j].close < level;
            if (!broke || !volOk(closed[j], closed.slice(0, j))) continue;
            const held = closed.slice(j + 1, n - 1).every(c => (side === 'long' ? c.close >= level * (1 - P.failTol) : c.close <= level * (1 + P.failTol)));
            return held ? level : null;
        }
        return null;
    }

    function retests(symbol, closed, a) {
        const last = closed[closed.length - 1], out = [];
        const up = findBrokenLevel(closed, 'long');
        if (up !== null && last.low <= up * (1 + P.retestTol) && last.close > up && last.close > last.open) {
            out.push(build(symbol, 'retest', 'long', last, up, Math.min(last.low, up) - 0.3 * a));
        }
        const down = findBrokenLevel(closed, 'short');
        if (down !== null && last.high >= down * (1 - P.retestTol) && last.close < down && last.close < last.open) {
            out.push(build(symbol, 'retest', 'short', last, down, Math.max(last.high, down) + 0.3 * a));
        }
        return out;
    }

    function surges(symbol, closed, a) {
        const n = closed.length, need = 5 * 13;
        if (n < need) return [];
        const sum = cs => cs.reduce((s, c) => s + c.quote, 0);
        const baseline = sum(closed.slice(n - need, n - 5)) / 12;
        if (!(baseline > 0)) return [];
        const spike = sum(closed.slice(-5)) / baseline, last = closed[n - 1];
        const movePct = (last.close / closed[n - 6].close - 1) * 100;
        if (spike < P.surgeX || Math.abs(movePct) < P.surgeMovePct) return [];
        if (movePct > 0 && last.close > last.open) return [build(symbol, 'surge', 'long', last, closed[n - 6].close, last.close - 1.5 * a)];
        if (movePct < 0 && last.close < last.open) return [build(symbol, 'surge', 'short', last, closed[n - 6].close, last.close + 1.5 * a)];
        return [];
    }

    function bounces(symbol, closed, a, walls) {
        const last = closed[closed.length - 1], out = [];
        for (const w of walls || []) {
            if (!(w.ageMs >= P.wallMinAgeMs) || Math.abs(last.close - w.price) / last.close * 100 > P.bounceNearPct) continue;
            if (w.side === 'bid' && last.low <= w.price * (1 + P.bounceTouch) && last.close > w.price && last.close > last.open) {
                out.push(build(symbol, 'bounce', 'long', last, w.price, w.price - 0.5 * a));
            } else if (w.side === 'ask' && last.high >= w.price * (1 - P.bounceTouch) && last.close < w.price && last.close < last.open) {
                out.push(build(symbol, 'bounce', 'short', last, w.price, w.price + 0.5 * a));
            }
        }
        return out;
    }

    // Формації на останній ЗАКРИТІЙ свічці (остання в масиві — та, що формується, її відкидаємо)
    function detect(symbol, candles, ctx) {
        const closed = candles.slice(0, -1);
        if (closed.length < P.minHistory) return [];
        const a = atr(closed.slice(0, -1));
        if (!(a > 0)) return [];
        return [...breakouts(symbol, closed, a), ...retests(symbol, closed, a), ...surges(symbol, closed, a), ...bounces(symbol, closed, a, ctx && ctx.walls)]
            .filter(Boolean);
    }

    // Додає нові сигнали без мутації: дедуп за id і cooldown на (монета, тип, бік)
    function addSignals(state, fresh) {
        let signals = state.signals.slice();
        for (const s of fresh) {
            if (signals.some(x => x.id === s.id)) continue;
            if (signals.some(x => x.symbol === s.symbol && x.type === s.type && x.side === s.side && Math.abs(s.time - x.time) < P.cooldownMs)) continue;
            signals.push(s);
        }
        if (signals.length > P.maxSignals) signals = signals.slice(signals.length - P.maxSignals);
        return { ...state, signals };
    }

    // Результат відкритого сигналу за закритими свічками після нього. Стоп і тейк в одній свічці = стоп (консервативно).
    function evaluate(sig, closedCandles, now) {
        const after = closedCandles.filter(c => c.time > sig.time);
        const expired = now - sig.time >= P.horizonMs;
        const covered = after.length > 0 && after[0].time - sig.time <= P.coverGapMs;
        if (!covered) return expired ? { status: 'unknown', r: null } : { status: 'open', r: null };
        const risk = Math.abs(sig.entry - sig.stop), reward = Math.abs(sig.take - sig.entry) / risk;
        const long = sig.side === 'long';
        for (const c of after) {
            if (c.time > sig.time + P.horizonMs) break;
            if (long ? c.low <= sig.stop : c.high >= sig.stop) return { status: 'loss', r: -1, closedAt: c.time };
            if (long ? c.high >= sig.take : c.low <= sig.take) return { status: 'win', r: reward, closedAt: c.time };
        }
        if (!expired) return { status: 'open', r: null };
        const inside = after.filter(c => c.time <= sig.time + P.horizonMs);
        const exit = inside[inside.length - 1];
        return { status: 'expired', r: ((long ? exit.close - sig.entry : sig.entry - exit.close) / risk), closedAt: exit.time };
    }

    // Статистика за вікно: winrate = перемоги / (перемоги + програші); avgR — по всіх завершених із відомим результатом
    function stats(signals, windowMs, now) {
        const out = {};
        for (const s of signals) {
            if (now - s.time > windowMs) continue;
            const t = out[s.type] || (out[s.type] = { n: 0, open: 0, unknown: 0, wins: 0, losses: 0, expired: 0, winrate: null, avgR: null, _r: [] });
            t.n++;
            if (s.status === 'open') t.open++;
            else if (s.status === 'unknown') t.unknown++;
            else {
                if (s.status === 'win') t.wins++; else if (s.status === 'loss') t.losses++; else t.expired++;
                if (typeof s.r === 'number') t._r.push(s.r);
            }
        }
        for (const t of Object.values(out)) {
            t.winrate = t.wins + t.losses ? (t.wins / (t.wins + t.losses)) * 100 : null;
            t.avgR = t._r.length ? mean(t._r) : null;
            delete t._r;
        }
        return out;
    }

    const api = { P, detect, addSignals, evaluate, stats };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Formations = api;
})(typeof window !== 'undefined' ? window : globalThis);
