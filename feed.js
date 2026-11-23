// Потік даних Binance Futures для скрінера: 1m-свічки топ-N монет (REST-історія + WebSocket),
// міні-тікер 24г і ставка фандингу. Мережа підміняється параметрами (див. tests/feed.test.js).
(function (root) {
    'use strict';

    const REST_BASE = 'https://fapi.binance.com/fapi/v1';
    // Звичайні ринкові стріми (kline, miniTicker, markPrice) — на /market. Старі /stream і /ws після міграції Binance
    // (developers.binance.com → Important WebSocket Change Notice) не віддають ці дані.
    const WS_BASE = 'wss://fstream.binance.com/market/stream?streams=';
    const DEFAULTS = {
        topN: 40,             // скільки монет за обсягом стежимо
        historyCap: 130,      // 1m-свічок на монету (≥ 5m×15 для NATR і 65 хв для сплеску обсягу)
        refreshMs: 2000,      // як часто віддавати оновлені рядки
        staleMs: 15000,       // тиша в сокеті довше за це → перепідключення
        reconnectMinMs: 1000,
        reconnectMaxMs: 30000,
        historyConcurrency: 5,
        fetchTimeoutMs: 8000,
        includeTradfi: true   // false → лише крипто (PERPETUAL/COIN), без акцій, сировини, FX
    };

    function createFeed(options) {
        const o = { ...DEFAULTS, ...options };
        const Metrics = o.Metrics;
        const candles = new Map();   // symbol → [candle]
        const tickers = new Map();   // symbol → { lastPrice, priceChangePercent, quoteVolume }
        const funding = new Map();   // symbol → ставка (частка, 0.0001 = 0.01%)
        let symbols = [];
        let cryptoSet = null;        // symbol → true для крипто-перпетуалів; кешується між перепідключеннями
        let wentLive = false;
        let socket = null;
        let dirty = false;
        let lastMsgAt = null;
        let timer = null;
        let retryTimer = null;
        let attempt = 0;
        let running = false;
        let generation = 0;          // скасовує застарілі асинхронні кроки після stop()/перепідключення

        const setStatus = (status, detail) => o.onStatus && o.onStatus(status, detail);

        function fetchJson(path) {
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), o.fetchTimeoutMs) : null;
            return o.fetchImpl(REST_BASE + path, ctl ? { signal: ctl.signal } : undefined)
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .finally(() => { if (t) clearTimeout(t); });
        }

        async function loadCryptoSet() {
            if (cryptoSet) return cryptoSet;
            try {
                const info = await fetchJson('/exchangeInfo');
                const list = (info.symbols || []).filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.underlyingType === 'COIN');
                if (!list.length) throw new Error('порожній exchangeInfo');
                cryptoSet = new Set(list.map(s => s.symbol));
            } catch (e) {
                if (o.onNotice) o.onNotice(`Не вдалося отримати типи контрактів (${e.message}): показуємо всі, включно з акціями й сировиною.`);
            }
            return cryptoSet;
        }

        function pickUniverse(all, crypto) {
            return all
                .filter(t => /USDT$/.test(t.symbol) && !t.symbol.includes('_') && (!crypto || crypto.has(t.symbol)))
                .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
                .slice(0, o.topN)
                .map(t => t.symbol);
        }

        async function loadHistory(gen) {
            const all = await fetchJson('/ticker/24hr');
            if (gen !== generation) return false;
            const crypto = o.includeTradfi ? null : await loadCryptoSet();
            if (gen !== generation) return false;
            symbols = pickUniverse(all, crypto);
            all.forEach(t => tickers.set(t.symbol, { lastPrice: t.lastPrice, priceChangePercent: t.priceChangePercent, quoteVolume: t.quoteVolume }));
            const queue = symbols.slice();
            const worker = async () => {
                while (queue.length && gen === generation) {
                    const sym = queue.shift();
                    try {
                        const k = await fetchJson(`/klines?symbol=${sym}&interval=1m&limit=${o.historyCap}`);
                        if (gen !== generation) return;
                        candles.set(sym, k.map(x => ({ time: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], vol: +x[5], quote: +x[7] })));
                    } catch (e) {
                        // одна монета без історії не зупиняє скрінер: вона з'явиться з порожніми метриками
                        if (!candles.has(sym)) candles.set(sym, []);
                    }
                }
            };
            await Promise.all(Array.from({ length: o.historyConcurrency }, worker));
            if (gen !== generation) return false;
            if (symbols.length && symbols.every(s => !candles.get(s) || !candles.get(s).length)) throw new Error('історію свічок не завантажено');
            return true;
        }

        function onMessage(raw) {
            lastMsgAt = o.now();
            if (!wentLive) { wentLive = true; attempt = 0; setStatus('live'); }   // «Наживо» лише коли справді пішли дані
            let msg;
            try { msg = JSON.parse(raw); } catch (e) { return; }
            const { stream, data } = msg;
            if (!stream || data === undefined) return;
            if (stream.endsWith('@kline_1m')) {
                const sym = data.s;
                if (!candles.has(sym)) return;
                candles.set(sym, Metrics.applyKline(candles.get(sym), Metrics.parseKline(data), o.historyCap));
                dirty = true;
            } else if (stream === '!miniTicker@arr') {
                for (const t of data) {
                    if (!candles.has(t.s)) continue;
                    const open = +t.o;
                    tickers.set(t.s, { lastPrice: t.c, priceChangePercent: open > 0 ? ((+t.c - open) / open) * 100 : null, quoteVolume: t.q });
                }
                dirty = true;
            } else if (stream.startsWith('!markPrice@arr')) {
                for (const t of data) if (candles.has(t.s) && t.r !== undefined) funding.set(t.s, +t.r);
                dirty = true;
            }
        }

        function openSocket(gen) {
            const streams = [...symbols.map(s => s.toLowerCase() + '@kline_1m'), '!miniTicker@arr', '!markPrice@arr@1s'];
            const ws = new o.WebSocketImpl(WS_BASE + streams.join('/'));
            socket = ws;
            wentLive = false;
            ws.onopen = () => { if (gen !== generation) return; lastMsgAt = o.now(); };   // відлік тиші — від відкриття
            ws.onmessage = ev => { if (gen === generation) onMessage(ev.data); };
            ws.onerror = () => { /* деталі помилки браузер не віддає; перепідключення — у onclose */ };
            ws.onclose = () => { if (gen === generation && running) scheduleReconnect('socket closed'); };
        }

        function scheduleReconnect(reason) {
            generation++;                                  // відсікає все, що ще летить зі старого з'єднання
            lastMsgAt = null;                              // таймер тиші не має зіпсувати щойно відкрите з'єднання
            if (socket) { try { socket.onclose = null; socket.close(); } catch (e) { /* вже закрито */ } socket = null; }
            const delay = Math.min(o.reconnectMaxMs, o.reconnectMinMs * 2 ** attempt);
            attempt++;
            setStatus('reconnecting', reason);
            clearTimeout(retryTimer);
            retryTimer = setTimeout(connect, delay);
        }

        async function connect() {
            if (!running) return;
            const gen = ++generation;
            setStatus(attempt ? 'reconnecting' : 'connecting');
            try {
                if (!(await loadHistory(gen))) return;
                openSocket(gen);
                dirty = true;
            } catch (e) {
                if (gen === generation && running) { setStatus('error', e.message); scheduleReconnect(e.message); }
            }
        }

        function tick() {
            if (socket && lastMsgAt !== null && o.now() - lastMsgAt > o.staleMs) { scheduleReconnect('stale'); return; }
            if (!dirty || !o.onRows) return;
            dirty = false;
            o.onRows(getRows());
        }

        function getRows() {
            return symbols
                .filter(s => candles.has(s))
                .map(s => Metrics.buildRow(s, candles.get(s), tickers.get(s), funding.has(s) ? funding.get(s) : null));
        }

        function start() {
            if (running) return;
            running = true;
            timer = setInterval(tick, o.refreshMs);
            connect();
        }

        function stop() {
            running = false;
            generation++;
            clearInterval(timer); clearTimeout(retryTimer);
            if (socket) { try { socket.onclose = null; socket.close(); } catch (e) { /* вже закрито */ } socket = null; }
        }

        return { start, stop, getRows, tick };
    }

    const api = { createFeed, DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Feed = api;
})(typeof window !== 'undefined' ? window : globalThis);
