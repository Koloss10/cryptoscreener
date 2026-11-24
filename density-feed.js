// Опитувач книг ордерів Binance Futures для карти плотностей. Мережа, годинник і джерело символів
// підміняються параметрами (див. tests/density-feed.test.js). Один запит на тік, по колу.
(function (root) {
    'use strict';

    const REST_BASE = 'https://fapi.binance.com/fapi/v1';
    const DEFAULTS = {
        intervalMs: 2500,        // 1 запит / 2.5 с; глибина 1000 важить 20 → ≈ 480 з 2400 ваги на хвилину
        depthLimit: 1000,        // допустимі значення Binance Futures: 5, 10, 20, 50, 100, 500, 1000
        priorityEvery: 3,        // кожен 3-й запит — символ поточного графіка
        limitPauseMs: 60000,     // пауза після HTTP 429
        banPauseMs: 300000,      // пауза після HTTP 418 (IP тимчасово заблоковано)
        errorAfter: 3,           // стільки невдач поспіль → статус «помилка»
        fetchTimeoutMs: 8000
    };

    function createDensityFeed(options) {
        const o = { ...DEFAULTS, ...options };
        const Density = o.Density;
        let walls = new Map();        // key → стіна з firstSeen
        const coverage = new Map();   // symbol → { bidPct, askPct }
        const updatedAt = new Map();
        let cursor = 0, ticks = 0, failures = 0, pausedUntil = 0, timer = null, inFlight = false, lastStatus = '';

        const setStatus = (s, detail) => {
            const key = s + '|' + (detail || '');
            if (key === lastStatus) return;
            lastStatus = key;
            if (o.onStatus) o.onStatus(s, detail);
        };

        function fetchBook(symbol) {
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), o.fetchTimeoutMs) : null;
            return o.fetchImpl(`${REST_BASE}/depth?symbol=${symbol}&limit=${o.depthLimit}`, ctl ? { signal: ctl.signal } : undefined)
                .finally(() => { if (t) clearTimeout(t); });
        }

        function nextSymbol(list) {
            ticks++;
            const priority = o.getPriority && o.getPriority();
            if (priority && ticks % o.priorityEvery === 0 && list.some(s => s.symbol === priority)) return priority;
            const sym = list[cursor % list.length].symbol;
            cursor++;
            return sym;
        }

        function prune(list) {
            const alive = new Set(list.map(s => s.symbol));
            for (const [k, w] of walls) if (!alive.has(w.symbol)) walls.delete(k);
        }

        function fail(reason) {
            failures++;
            if (failures >= o.errorAfter) setStatus('error', reason);
        }

        async function pollOnce() {
            const list = (o.getSymbols && o.getSymbols()) || [];
            if (!o.isActive() || !list.length) { setStatus('idle'); return; }
            if (o.now() < pausedUntil) return;
            prune(list);
            const symbol = nextSymbol(list);
            try {
                const res = await fetchBook(symbol);
                if (res.status === 429 || res.status === 418) {
                    pausedUntil = o.now() + (res.status === 418 ? o.banPauseMs : o.limitPauseMs);
                    setStatus('limited', 'HTTP ' + res.status);
                    return;
                }
                if (!res.ok) { fail('HTTP ' + res.status); return; }
                const book = Density.parseBook(await res.json());
                if (!book) { fail('некоректна книга ордерів'); return; }
                failures = 0;
                const found = Density.detect(book, o.opts);
                walls = Density.track(walls, symbol, found, o.now());
                coverage.set(symbol, Density.coverage(book));
                updatedAt.set(symbol, o.now());
                setStatus('live');
                if (o.onUpdate) o.onUpdate();
            } catch (e) {
                fail(e.name === 'AbortError' ? 'таймаут запиту' : e.message);
            }
        }

        function enrich(w) {
            const meta = ((o.getSymbols && o.getSymbols()) || []).find(s => s.symbol === w.symbol) || {};
            const perMin = meta.vol1h > 0 ? meta.vol1h / 60 : (meta.vol24 > 0 ? meta.vol24 / 1440 : 0);
            return { ...w, ageMs: o.now() - w.firstSeen, eatMin: Density.eatMinutes(w.usd, perMin), coverage: coverage.get(w.symbol) || null, updatedAt: updatedAt.get(w.symbol) || null };
        }

        const getAll = () => [...walls.values()].map(enrich);
        const forSymbol = sym => getAll().filter(w => w.symbol === sym);

        function start() {
            if (timer) return;
            timer = setInterval(() => {
                if (inFlight) return;                       // не накладаємо запити, якщо попередній ще йде
                inFlight = true;
                pollOnce().finally(() => { inFlight = false; });
            }, o.intervalMs);
        }
        function stop() { clearInterval(timer); timer = null; }

        return { start, stop, pollOnce, getAll, forSymbol };
    }

    const api = { createDensityFeed, DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DensityFeed = api;
})(typeof window !== 'undefined' ? window : globalThis);
