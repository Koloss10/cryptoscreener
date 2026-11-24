// Джерела-знімки (OKX, Bitget, Gate, MEXC) для скринера: читає файл, який раз на 5 хв кладе збирач (collector/*.mjs) у гілку data.
// Без ключів і акаунта. Мережа підміняється параметрами (tests/okx-source.test.js).
(function (root) {
    'use strict';

    const EXCHANGES = ['okx', 'bitget', 'gate', 'mexc'];
    const urlLatest = ex => `https://raw.githubusercontent.com/Koloss10/cryptoscreener/data/${ex}/latest.json`;
    const DEFAULTS = { intervalMs: 60000, staleMs: 15 * 60000, fetchTimeoutMs: 10000 };

    // Знімок → рядки таблиці. Стіна — найбільша заявка стакана (обидва боки); для монет без знімка стакана — null.
    function parseSnapshot(snap, ex) {
        if (!snap || snap.ex !== ex || !Array.isArray(snap.coins) || !Number.isFinite(snap.ts)) throw new Error('невірний формат знімка');
        const walls = snap.walls || {};
        return snap.coins.map(c => {
            const w = walls[c.s];
            const all = w ? [...(w.bids || []), ...(w.asks || [])] : [];
            const top = all.reduce((best, x) => (!best || x.usd > best.usd ? x : best), null);
            return {
                symbol: c.s, price: c.last, chg24: c.chg24h, vol24: c.volUsd, oi: c.oiUsd ?? null, funding: c.fund ?? null,
                wallUsd: top ? top.usd : null, wallDist: top ? top.dist : null
            };
        });
    }

    function createExchangeFeed(options) {
        if (!EXCHANGES.includes(options.ex)) throw new Error('невідома біржа: ' + options.ex);
        const o = { ...DEFAULTS, url: urlLatest(options.ex), ...options };
        let timer = null, running = false, generation = 0;

        async function fetchSnapshot() {
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), o.fetchTimeoutMs) : null;
            try {
                const r = await o.fetchImpl(o.url, ctl ? { signal: ctl.signal, cache: 'no-store' } : undefined);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return await r.json();
            } finally { if (t) clearTimeout(t); }
        }

        async function poll() {
            const gen = generation;
            try {
                const snap = await fetchSnapshot();
                if (gen !== generation) return;
                const rows = parseSnapshot(snap, o.ex);
                const ageMs = o.now() - snap.ts;
                o.onRows(rows, ageMs);
                if (ageMs > o.staleMs) o.onStatus('reconnecting', `дані ${o.ex.toUpperCase()} застаріли на ${Math.round(ageMs / 60000)} хв: збирач на GitHub не оновлював їх (розклад Actions міг зупинитись)`);
                else o.onStatus('live', '');
            } catch (e) {
                if (gen !== generation) return;
                o.onStatus('error', `не вдалося отримати дані ${o.ex.toUpperCase()} (${e.message})`);
            }
        }

        function start() {
            if (running) return;
            running = true;
            poll();
            timer = setInterval(poll, o.intervalMs);
        }
        function stop() { running = false; generation++; if (timer) clearInterval(timer); timer = null; }
        return { start, stop, poll };
    }

    const api = { EXCHANGES, urlLatest, parseSnapshot, createExchangeFeed, createOkxFeed: opts => createExchangeFeed({ ex: 'okx', ...opts }) };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.OkxSource = api;
})(typeof window !== 'undefined' ? window : globalThis);
