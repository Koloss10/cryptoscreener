"use strict";
        // =========================================================================
        // ЯДРО СКРІНЕРА v6.0 VELES EDITION (БЕЗ ЦИКЛІВ НАВКОЛО AWAIT)
        // =========================================================================
        const COINS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","TONUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","SUIUSDT","PEPEUSDT","NEARUSDT","APTUSDT","LTCUSDT","ARBUSDT","OPUSDT","INJUSDT","DOTUSDT","FETUSDT"];
        const BASE_PRICES = { BTCUSDT:68400, ETHUSDT:2640, SOLUSDT:158, BNBUSDT:595, XRPUSDT:0.55, DOGEUSDT:0.125, TONUSDT:5.25, ADAUSDT:0.36, AVAXUSDT:27.8, LINKUSDT:11.6, SUIUSDT:2.05, PEPEUSDT:0.00001, NEARUSDT:4.9, APTUSDT:9.8, LTCUSDT:71, ARBUSDT:0.56, OPUSDT:1.72, INJUSDT:21.4, DOTUSDT:4.45, FETUSDT:1.42 };

        const CANDLE_LIMIT = 1000;            // макс. для Binance klines; більше історії = змістовніший бектест
        const FETCH_TIMEOUT_MS = 6000;
        const TF_MS = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000, '1M': 2592000000 };
        // спот → резервний спот → ф'ючерси (для монет, яких немає на споті, напр. 1000PEPEUSDT); шляхи /klines, /ticker/24hr, /depth однакові
        const BINANCE_FUTURES = 'https://fapi.binance.com/fapi/v1';
        const BINANCE_BASES = {
            spot: ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3', BINANCE_FUTURES],
            futures: [BINANCE_FUTURES, 'https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3']
        };
        const DEPTH_LIMIT = 20;               // валідний і для споту, і для ф'ючерсів (ф'ючерси: 5/10/20/50/100/500/1000)
        const TIME_EXIT_BARS = 16;            // вихід по часу в бектесті
        const LIQ_MARGIN_FRACTION = 0.9;      // ліквідація при втраті 90% маржі

        const MOD_NAMES = {
            smc: '🧠 SMC (OB/FVG)', sr: '🎯 Рівні П/С', fib: '🌀 Фібо 0.618', pa: '🕯️ Свічки PA',
            ta: '📐 Фігури ТА', liq: '🧲 Ліквідність', rsi: '📊 RSI(14)', st: '📈 Тренд EMA20',
            macd: '⚡ MACD', bb: '💥 Bollinger', ema: '🌊 EMA 20/50', ichi: '☁️ Ішімоку',
            vwap: '💎 VWAP+Vol', stoch: '🎯 Стохастик(9)'
        };

        window.app = {
            sym: 'BTCUSDT', tf: '1h', tvTf: '60', mode: 'canvas',
            candles: [], visibleBars: 55, panOffset: 0, reqId: 0, preferFutures: true, dataSrc: '', inFlightKey: null, dataState: 'loading', scrDemo: false, scrTf: '',
            layers: { dens: true, mtf: true, fib: true, smc: true, pat: true, can: true, vpvr: true, liq: true, botgrid: true },
            btMods: { smc: true, sr: true, fib: true, pa: false, ta: false, liq: false, rsi: true, st: false, macd: false, bb: false, ema: false, ichi: false, vwap: false, stoch: false },
            bot: {
                exchange: 'Binance',
                active: false,
                algo: 'LONG',
                deposit: 500,
                leverage: 10,
                indent: 0.0,
                overlap: 20,
                ordersCount: 5,
                martingale: 15,
                logFactor: 1.1,
                tpPct: 1.5,
                slPct: 2.0,
                feePct: 0.05,
                gridTable: [],
                filledCount: 0,
                avgEntryPrice: 0,
                tpPrice: 0,
                usedUsd: 0
            },
            scrList: [], scrFilter: 'all'
        };

        window.fmt = function(p) {
            p = parseFloat(p);
            if (isNaN(p)) return '0.00';
            if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (p >= 1) return p.toFixed(3);
            if (p >= 0.01) return p.toFixed(4);
            return p.toFixed(7);
        };

        window.fmtK = function(n) {
            return Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 2 }).format(Number(n) || 0);
        };

        // Збирає сторінку й усі її локальні .css/.js в один автономний .html (працює через http/https)
        window.downloadAppFile = function() {
            const scriptClose = '<' + '/script>';
            const safe = (src) => src.replace(/<\/script/gi, '<\\/script');
            const text = (f) => fetch(f).then(r => { if (!r.ok) throw new Error(f); return r.text(); });
            const toDataUrl = (src) => {
                const bytes = new TextEncoder().encode(src);
                let bin = '';
                for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                return 'data:text/javascript;charset=utf-8;base64,' + btoa(bin);
            };
            text('index.html').then(async html => {
                const css = [...html.matchAll(/<link rel="stylesheet" href="([^":]+)">/g)];
                const scripts = [...html.matchAll(/<script src="([^":]+)" defer><\/script>/g)];
                const bodies = new Map();
                await Promise.all([...css, ...scripts].map(m => text(m[1]).then(t => bodies.set(m[0], t))));
                const out = html
                    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
                    .replace(/<link rel="stylesheet" href="([^":]+)">/g, m => `<style>\n${bodies.get(m)}</style>`)
                    .replace(/<script src="([^":]+)" defer><\/script>/g, (m, path) => path.startsWith('vendor/')
                        // webpack-бібліотеці потрібна адреса власного скрипта (publicPath): інлайн-скрипт її не має, data-URL має
                        ? `<script src="${toDataUrl(bodies.get(m))}">` + scriptClose
                        : '<script>\n' + safe(bodies.get(m)) + scriptClose);
                const url = URL.createObjectURL(new Blob([out], { type: 'text/html;charset=utf-8' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'CryptoScreener_v6_VELES_EDITION.html';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }).catch(() => alert('Збереження працює, коли сторінку відкрито через http(s) (наприклад GitHub Pages), а не через file://.'));
        };

        // Генератор свічок, якщо пісочниця обмежує мережу
        window.generateFallbackCandles = function(sym, count = CANDLE_LIMIT) {
            let seed = sym.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + app.tf.charCodeAt(0) * 37;
            const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
            let p = BASE_PRICES[sym] || 100;
            const stepPct = 0.0085;
            const arr = new Array(count);
            const now = Date.now();
            for (let i = 0; i < count; i++) {
                const o = p;
                const wave = Math.sin(i / 7) * p * stepPct * 0.65;
                const move = (rand() - 0.5) * p * stepPct * 2.1 + wave;
                const c = Math.max(p * 0.1, o + move);
                const h = Math.max(o, c) + rand() * p * stepPct * 1.25;
                const l = Math.min(o, c) - rand() * p * stepPct * 1.25;
                const v = (1000 + rand() * 5200) * (100 / Math.max(1, p));
                arr[i] = { time: now - (count - i) * (TF_MS[app.tf] || 3600000), open: o, high: h, low: l, close: c, vol: v };
                p = c;
            }
            return arr;
        };

        // Запит до Binance із таймаутом; src — що пробувати першим ('spot' | 'futures'); onBase(base) — яке джерело відповіло.
        // Повертає null, якщо недоступні всі хости
        window.fetchBinance = function(path, src = 'spot', onBase) {
            const get = (base) => {
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
                return fetch(base + path, { signal: ctl.signal })
                    .then(r => (r.ok ? r.json() : null))
                    .catch(() => null)
                    .finally(() => clearTimeout(timer));
            };
            return BINANCE_BASES[src].reduce((p, base) => p.then(d => {
                if (d !== null) return d;
                return get(base).then(r => { if (r !== null && onBase) onBase(base); return r; });
            }), Promise.resolve(null));
        };

        window.syncDemoBadge = function() {
            const badge = document.getElementById('demoBadge');
            badge.classList.toggle('hidden', app.dataState === 'live');
            badge.textContent = app.dataState === 'loading' ? '⏳ Завантаження…' : '⚠ ДЕМО-ДАНІ';
            const src = document.getElementById('srcBadge');
            src.hidden = app.dataState !== 'live';
            src.textContent = app.dataSrc;
        };

        window.loadMainData = function() {
            const key = `${app.sym}|${app.tf}`;
            if (app.inFlightKey === key) return;   // запит для цієї пари вже летить — не скидаємо його
            app.inFlightKey = key;
            const reqId = app.reqId;               // changeSymbol/changeTF збільшують reqId і роблять відповідь застарілою

            if (!app.candles.length) {
                app.candles = window.generateFallbackCandles(app.sym, CANDLE_LIMIT);
                app.dataState = 'loading';
                window.syncDemoBadge();
                window.updateBotGridPreview();
                window.drawChart();
            }

            const src = app.preferFutures ? 'futures' : 'spot';
            let usedBase = '';
            Promise.all([
                window.fetchBinance(`/klines?symbol=${app.sym}&interval=${app.tf}&limit=${CANDLE_LIMIT}`, src, b => { usedBase = b; }),
                window.fetchBinance(`/ticker/24hr?symbol=${app.sym}`, src),
                window.fetchBinance(`/depth?symbol=${app.sym}&limit=${DEPTH_LIMIT}`, src)
            ]).then(([kRaw, ticker, depth]) => {
                if (reqId !== app.reqId) return;   // застаріла відповідь

                if (Array.isArray(kRaw) && kRaw.length > 0) {
                    app.candles = kRaw.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] }));
                    app.dataState = 'live';
                    app.dataSrc = usedBase === BINANCE_FUTURES ? 'Binance Futures' : 'Binance Spot';
                } else if (app.dataState === 'loading') {
                    app.dataState = 'demo';   // Binance не відповів, лишаються згенеровані свічки
                }
                window.syncDemoBadge();

                const lastP = app.candles[app.candles.length - 1].close;
                const chg = ticker && ticker.priceChangePercent ? parseFloat(ticker.priceChangePercent) : ((lastP - app.candles[0].open) / app.candles[0].open) * 100;

                document.getElementById('topPrice').textContent = '$' + fmt(lastP);
                const chgEl = document.getElementById('topChange');
                chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
                chgEl.className = 'text-[11px] font-bold ' + (chg >= 0 ? 'text-emerald-400' : 'text-red-400');

                window.updateBotGridPreview();
                window.renderAnalyticsAndBook(lastP, ticker, depth);
                window.drawChart();

                if (!document.getElementById('view-backtest').classList.contains('hidden')) {
                    window.executeBacktest();
                }
            }).catch(err => console.error('loadMainData failed:', err))
              .finally(() => { if (reqId === app.reqId) app.inFlightKey = null; });
        };
