"use strict";
        // =========================================================================
        // ЯДРО СКРІНЕРА v6.0 VELES EDITION (БЕЗ ЦИКЛІВ НАВКОЛО AWAIT)
        // =========================================================================
        const COINS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","TONUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","SUIUSDT","PEPEUSDT","NEARUSDT","APTUSDT","LTCUSDT","ARBUSDT","OPUSDT","INJUSDT","DOTUSDT","FETUSDT"];
        const BASE_PRICES = { BTCUSDT:68400, ETHUSDT:2640, SOLUSDT:158, BNBUSDT:595, XRPUSDT:0.55, DOGEUSDT:0.125, TONUSDT:5.25, ADAUSDT:0.36, AVAXUSDT:27.8, LINKUSDT:11.6, SUIUSDT:2.05, PEPEUSDT:0.00001, NEARUSDT:4.9, APTUSDT:9.8, LTCUSDT:71, ARBUSDT:0.56, OPUSDT:1.72, INJUSDT:21.4, DOTUSDT:4.45, FETUSDT:1.42 };

        const CANDLE_LIMIT = 1000;            // макс. для Binance klines; більше історії = змістовніший бектест
        const FETCH_TIMEOUT_MS = 6000;
        const TF_MS = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000, '1M': 2592000000 };
        const BINANCE_BASES = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];
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
            candles: [], visibleBars: 55, panOffset: 0, reqId: 0, inFlightKey: null, isDemo: false, scrDemo: false,
            layers: { mtf: true, fib: true, smc: true, pat: true, can: true, vpvr: true, liq: true, botgrid: true },
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

        // Збирає index.html + styles.css + app.js в один автономний .html (працює через http/https)
        window.downloadAppFile = function() {
            const files = ['index.html', 'styles.css', 'analysis.js', 'app.js'];
            Promise.all(files.map(f => fetch(f).then(r => {
                if (!r.ok) throw new Error(f);
                return r.text();
            }))).then(([html, css, analysis, app_]) => {
                const scriptClose = '<' + '/script>';
                const safe = (src) => src.replace(/<\/script/gi, '<\\/script');
                const out = html
                    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}</style>`)
                    .replace('<script src="analysis.js" defer>' + scriptClose, () => '<script>\n' + safe(analysis) + scriptClose)
                    .replace('<script src="app.js" defer>' + scriptClose, () => '<script>\n' + safe(app_) + scriptClose);
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

        // Запит до Binance із таймаутом; повертає null, якщо обидва хости недоступні
        window.fetchBinance = function(path) {
            const get = (base) => {
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
                return fetch(base + path, { signal: ctl.signal })
                    .then(r => (r.ok ? r.json() : null))
                    .catch(() => null)
                    .finally(() => clearTimeout(timer));
            };
            return get(BINANCE_BASES[0]).then(d => (d !== null ? d : get(BINANCE_BASES[1])));
        };

        window.syncDemoBadge = function() {
            document.getElementById('demoBadge').classList.toggle('hidden', !app.isDemo);
        };

        window.loadMainData = function() {
            const key = `${app.sym}|${app.tf}`;
            if (app.inFlightKey === key) return;   // запит для цієї пари вже летить — не скидаємо його
            app.inFlightKey = key;
            const reqId = app.reqId;               // changeSymbol/changeTF збільшують reqId і роблять відповідь застарілою

            if (!app.candles.length) {
                app.candles = window.generateFallbackCandles(app.sym, CANDLE_LIMIT);
                app.isDemo = true;
                window.syncDemoBadge();
                window.updateBotGridPreview();
                window.drawChart();
            }

            Promise.all([
                window.fetchBinance(`/klines?symbol=${app.sym}&interval=${app.tf}&limit=${CANDLE_LIMIT}`),
                window.fetchBinance(`/ticker/24hr?symbol=${app.sym}`),
                window.fetchBinance(`/depth?symbol=${app.sym}&limit=30`)
            ]).then(([kRaw, ticker, depth]) => {
                if (reqId !== app.reqId) return;   // застаріла відповідь

                if (Array.isArray(kRaw) && kRaw.length > 30) {
                    app.candles = kRaw.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] }));
                    app.isDemo = false;
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

        // =========================================================================
        // МОДУЛЬ VELES-БОТА ТА ПІДКЛЮЧЕННЯ ДО ТОП-10 БІРЖ ЧЕРЕЗ API
        // =========================================================================
        window.selectExchange = function(exName, btn) {
            app.bot.exchange = exName;
            document.querySelectorAll('.ex-btn').forEach(b => b.className = "ex-btn bg-[#1a202c] text-slate-300 py-1.5 px-2 rounded-lg text-xs font-bold");
            if (btn) btn.className = "ex-btn gold-btn py-1.5 px-2 rounded-lg text-xs";

            document.getElementById('apiConnBadge').textContent = `● Симуляція • ${exName}`;
            document.getElementById('bmPair').textContent = `${exName} • ${app.sym}`;
            window.logBotEvent(`Обрано біржу ${exName} (лише підпис у симуляції; ціни завжди з Binance).`);
        };

        window.applyVelesTemplate = function(tpl) {
            if (tpl === 'conservative') {
                document.getElementById('vBotOverlap').value = 40;
                document.getElementById('vBotOrders').value = 6;
                document.getElementById('vBotMartingale').value = 20;
                document.getElementById('vBotLog').value = 1.2;
                document.getElementById('vBotTpPct').value = 1.2;
            } else if (tpl === 'moderate') {
                document.getElementById('vBotOverlap').value = 25;
                document.getElementById('vBotOrders').value = 5;
                document.getElementById('vBotMartingale').value = 15;
                document.getElementById('vBotLog').value = 1.1;
                document.getElementById('vBotTpPct').value = 1.5;
            } else if (tpl === 'aggressive') {
                document.getElementById('vBotOverlap').value = 12;
                document.getElementById('vBotOrders').value = 4;
                document.getElementById('vBotMartingale').value = 10;
                document.getElementById('vBotLog').value = 1.0;
                document.getElementById('vBotTpPct').value = 2.0;
            }
            window.updateBotGridPreview();
            window.logBotEvent(`Застосовано шаблон Veles: ${tpl.toUpperCase()}`);
        };

        // Точний математичний розрахунок сітки ордерів Veles (Overlap + Martingale + Logarithmic)
        window.calculateVelesGrid = function(basePrice) {
            const algo = document.getElementById('vBotAlgo').value || 'LONG';
            const dep = Math.max(10, parseFloat(document.getElementById('vBotDeposit').value) || 500);
            const lev = Math.max(1, parseFloat(document.getElementById('vBotLeverage').value) || 10);
            const indent = Math.max(0, parseFloat(document.getElementById('vBotIndent').value) || 0);
            const overlap = Math.max(1, parseFloat(document.getElementById('vBotOverlap').value) || 20);
            const count = Math.min(12, Math.max(1, parseInt(document.getElementById('vBotOrders').value) || 5));
            const mart = Math.max(0, parseFloat(document.getElementById('vBotMartingale').value) || 15) / 100;
            const logF = Math.max(0.5, parseFloat(document.getElementById('vBotLog').value) || 1.1);
            const tpPct = Math.max(0.2, parseFloat(document.getElementById('vBotTpPct').value) || 1.5);
            const slPct = Math.max(0.2, parseFloat(document.getElementById('vBotSlPct').value) || 2.0);
            const feePct = Math.max(0.01, parseFloat(document.getElementById('botExchangeFee').value) || 0.05);

            const totalPower = dep * lev;
            const weights = [];
            let weightSum = 0;
            for (let i = 0; i < count; i++) {
                const w = Math.pow(1 + mart, i);
                weights.push(w);
                weightSum += w;
            }

            const orders = [];
            for (let i = 0; i < count; i++) {
                const progress = count === 1 ? 0 : Math.pow(i / (count - 1), logF);
                const dropPct = indent + progress * overlap;
                const orderPrice = algo === 'LONG' ? basePrice * (1 - dropPct / 100) : basePrice * (1 + dropPct / 100);
                const orderUsd = (weights[i] / weightSum) * totalPower;
                const sharePct = (weights[i] / weightSum) * 100;
                orders.push({
                    idx: i + 1,
                    dropPct,
                    price: orderPrice,
                    usd: orderUsd,
                    coins: orderUsd / (orderPrice || 1),
                    sharePct
                });
            }

            app.bot.algo = algo;
            app.bot.deposit = dep;
            app.bot.leverage = lev;
            app.bot.overlap = overlap;
            app.bot.ordersCount = count;
            app.bot.martingale = mart * 100;
            app.bot.tpPct = tpPct;
            app.bot.slPct = slPct;
            app.bot.feePct = feePct;
            app.bot.gridTable = orders;

            return { orders, totalPower, algo, tpPct, slPct };
        };

        window.updateBotGridPreview = function() {
            const lastP = app.candles.length ? app.candles[app.candles.length - 1].close : (BASE_PRICES[app.sym] || 68000);
            const { orders, totalPower, algo, tpPct } = window.calculateVelesGrid(lastP);

            document.getElementById('gridTotalVolumeBadge').textContent = `Купівельна спроможність (${app.bot.leverage}x): $${totalPower.toLocaleString('en-US')}`;

            document.getElementById('velesGridTableBody').innerHTML = orders.map(o => `
                <tr class="hover:bg-[#1a202c]/60">
                    <td class="py-1.5 px-1 font-bold text-white">#${o.idx} ${o.idx===1?'(Вхід)':''}</td>
                    <td class="py-1.5 px-1 ${algo==='LONG'?'text-red-400':'text-amber-400'}">${algo==='LONG'?'-':'+'}${o.dropPct.toFixed(2)}%</td>
                    <td class="py-1.5 px-1 text-emerald-400 font-bold">$${fmt(o.price)}</td>
                    <td class="py-1.5 px-1 text-white">$${o.usd.toFixed(1)}</td>
                    <td class="py-1.5 px-1 text-right text-slate-400">${o.sharePct.toFixed(1)}%</td>
                </tr>
            `).join('');

            // Оновлення живого монітора бота
            const filled = app.bot.active ? Math.max(1, app.bot.filledCount) : 1;
            const activeSlice = orders.slice(0, filled);
            const sumUsd = activeSlice.reduce((s, x) => s + x.usd, 0);
            const sumCoins = activeSlice.reduce((s, x) => s + x.coins, 0);
            const avgPrice = sumUsd / (sumCoins || 1);
            const tpTarget = algo === 'LONG' ? avgPrice * (1 + tpPct / 100) : avgPrice * (1 - tpPct / 100);

            document.getElementById('bmPair').textContent = `${app.bot.exchange} • ${app.sym} (${algo})`;
            document.getElementById('bmAvgPrice').textContent = `$${fmt(avgPrice)}`;
            document.getElementById('bmTpPrice').textContent = `$${fmt(tpTarget)}`;
            document.getElementById('bmFilledOrders').textContent = `${app.bot.active ? filled : 0} / ${orders.length}`;
            document.getElementById('bmUsedVolume').textContent = `$${app.bot.active ? sumUsd.toFixed(1) : '0.00'}`;

            if (app.bot.active) {
                const diffPct = algo === 'LONG' ? ((lastP - avgPrice) / avgPrice) * 100 : ((avgPrice - lastP) / avgPrice) * 100;
                const pnlUsd = sumUsd * (diffPct / 100);
                const pnlEl = document.getElementById('bmLivePnl');
                pnlEl.textContent = `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)`;
                pnlEl.className = `font-mono font-bold ${pnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
            }

            // Синхронізуємо TP та SL з бектестером
            document.getElementById('btTp').value = tpPct;
            document.getElementById('btSl').value = app.bot.slPct;
        };

        window.toggleBotActiveState = function() {
            app.bot.active = !app.bot.active;
            const btn = document.getElementById('btnStartBot');
            const pill = document.getElementById('botLiveStatusPill');
            const headerBadge = document.getElementById('activeBotHeaderBadge');

            if (app.bot.active) {
                app.bot.filledCount = 1;
                btn.innerHTML = `<span>⏹ ЗУПИНИТИ СИМУЛЯЦІЮ (${app.bot.exchange})</span>`;
                btn.className = "bg-red-600 hover:bg-red-500 text-white font-extrabold px-4 py-2.5 rounded-xl text-xs shadow-lg transition";
                pill.textContent = "● СИМУЛЯЦІЯ: В УГОДІ";
                pill.className = "px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold";
                headerBadge.classList.remove('hidden');
                window.logBotEvent(`🚀 [СИМУЛЯЦІЯ] Бот запущено на ${app.bot.exchange} (${app.sym}, ${app.bot.algo}). Виконано Ордер #1, виставлено ${app.bot.ordersCount - 1} лімітних ордерів усереднення.`);
                window.beep(720);
            } else {
                app.bot.filledCount = 0;
                btn.innerHTML = `<span>🚀 ЗАПУСТИТИ СИМУЛЯЦІЮ</span>`;
                btn.className = "veles-btn px-4 py-2.5 rounded-xl text-xs shadow-lg transition";
                pill.textContent = "ЗУПИНЕНО";
                pill.className = "px-2 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-bold";
                headerBadge.classList.add('hidden');
                window.logBotEvent(`⏹ Симуляцію зупинено. Реальні ордери не відправлялись.`);
            }
            window.updateBotGridPreview();
            window.drawChart();
        };

        window.botManualAverage = function() {
            if (!app.bot.active) {
                window.toggleBotActiveState();
                return;
            }
            if (app.bot.filledCount < app.bot.gridTable.length) {
                app.bot.filledCount++;
                const ord = app.bot.gridTable[app.bot.filledCount - 1];
                window.logBotEvent(`➕ Додаткове усереднення: виконано Ордер #${ord.idx} по $${fmt(ord.price)} ($${ord.usd.toFixed(1)}). Середню ціну та Тейк-Профіт перераховано!`);
                window.beep(580);
                window.updateBotGridPreview();
            } else {
                window.logBotEvent(`⚠️ Всі ${app.bot.gridTable.length} ордерів сітки вже задіяні в позиції.`);
            }
        };

        window.botPanicSell = function() {
            if (!app.bot.active) return;
            window.logBotEvent(`🚨 [СИМУЛЯЦІЯ] PANIC SELL: Позицію по ${app.sym} повністю закрито за ринковою ціною на ${app.bot.exchange}!`);
            window.beep(320);
            window.toggleBotActiveState();
        };

        window.logBotEvent = function(msg) {
            const box = document.getElementById('botExecutionLog');
            const t = new Date().toLocaleTimeString('uk-UA');
            box.innerHTML = `<div><span class="text-amber-400">[${t}]</span> ${msg}</div>` + box.innerHTML;
        };

        // =========================================================================
        // БЕКТЕСТЕР ЗА АРХІТЕКТУРОЮ VELES (DCA СІТКА УСЕРЕДНЕНЬ + 14 КОМБО-ФІЛЬТРІВ)
        // =========================================================================
        window.toggleBtMod = function(modKey) {
            app.btMods[modKey] = !app.btMods[modKey];
            if (!Object.values(app.btMods).some(Boolean)) app.btMods[modKey] = true;
            window.syncBtChipsUI();
            window.executeBacktest();
        };

        window.applyBtPreset = function(modArray, logicMode) {
            Object.keys(app.btMods).forEach(k => { app.btMods[k] = modArray.includes(k); });
            if (logicMode) document.getElementById('btLogic').value = logicMode;
            window.syncBtChipsUI();
            window.executeBacktest();
        };

        window.syncBtChipsUI = function() {
            document.querySelectorAll('.bt-chip').forEach(btn => {
                const k = btn.getAttribute('data-mod');
                if (app.btMods[k]) {
                    btn.classList.add('bt-chip-on');
                    btn.classList.remove('text-slate-400');
                } else {
                    btn.classList.remove('bt-chip-on');
                    btn.classList.add('text-slate-400');
                }
            });
        };

        window.executeBacktest = function() {
            if (!app.candles || app.candles.length < 40) {
                app.candles = window.generateFallbackCandles(app.sym, CANDLE_LIMIT);
                app.isDemo = true;
                window.syncDemoBadge();
            }

            const cs = app.candles;
            const n = cs.length;
            const activeMods = Object.keys(app.btMods).filter(k => app.btMods[k]);
            const logic = document.getElementById('btLogic').value;
            const dirFilter = document.getElementById('btDir').value;
            const gridMode = document.getElementById('btVelesGridMode').value; // 'dca' або 'single'
            const tpPct = Math.max(0.2, parseFloat(document.getElementById('btTp').value) || 1.6) / 100;
            const slPct = Math.max(0.2, parseFloat(document.getElementById('btSl').value) || 2.5) / 100;
            const feeRate = (app.bot.feePct || 0.05) / 100;
            const lev = Math.max(1, app.bot.leverage || 1);

            document.getElementById('btCoinBadge').textContent = `${app.sym} • ${app.tf.toUpperCase()} (${n} свічок | Сітка Veles: ${gridMode==='dca'?app.bot.ordersCount+' орд.':'1 орд.'})`;

            // Лінійний розрахунок індикаторів O(N) за 1 прохід
            const ema12 = new Array(n), ema20 = new Array(n), ema26 = new Array(n), ema50 = new Array(n), rsiArr = new Array(n);
            let gAvg = 0.0001, lAvg = 0.0001;
            for (let i = 0; i < n; i++) {
                const cl = cs[i].close;
                if (i === 0) {
                    ema12[0] = cl; ema20[0] = cl; ema26[0] = cl; ema50[0] = cl; rsiArr[0] = 50;
                } else {
                    ema12[i] = cl * (2/13) + ema12[i-1] * (11/13);
                    ema20[i] = cl * (2/21) + ema20[i-1] * (19/21);
                    ema26[i] = cl * (2/27) + ema26[i-1] * (25/27);
                    ema50[i] = cl * (2/51) + ema50[i-1] * (49/51);
                    const diff = cl - cs[i-1].close;
                    gAvg = (gAvg * 13 + (diff > 0 ? diff : 0)) / 14;
                    lAvg = (lAvg * 13 + (diff < 0 ? -diff : 0)) / 14;
                    rsiArr[i] = 100 - (100 / (1 + (gAvg / (lAvg || 0.00001))));
                }
            }

            const startDep = app.bot.deposit || 500;
            let balance = startDep;
            let totalFeesPaid = 0;
            let maxMaePct = 0;
            let maxGridOrderReached = 1;
            const equity = [startDep], trades = [];
            let wins = 0;

            const modStats = {};
            activeMods.forEach(m => { modStats[m] = { triggers: 0, wins: 0 }; });
            const reqCount = logic === 'all' ? activeMods.length : logic === 'synergy3' ? Math.min(3, activeMods.length) : logic === 'synergy2' ? Math.min(2, activeMods.length) : 1;

            for (let i = 22; i < n - 8; i++) {
                const c = cs[i], prev = cs[i - 1], prev2 = cs[i - 2];

                let high20 = cs[i - 1].high, low20 = cs[i - 1].low;
                let high9 = cs[i - 1].high, low9 = cs[i - 1].low;
                let volSum = 0, pvSum = 0, sqSum = 0;
                for (let k = i - 20; k < i; k++) {
                    const b = cs[k];
                    if (b.high > high20) high20 = b.high;
                    if (b.low < low20) low20 = b.low;
                    if (k >= i - 9) {
                        if (b.high > high9) high9 = b.high;
                        if (b.low < low9) low9 = b.low;
                    }
                    volSum += b.vol;
                    pvSum += b.close * b.vol;
                    sqSum += Math.pow(b.close - ema20[k], 2);
                }
                const avgVol = volSum / 20 || 1;
                const vwap = pvSum / (volSum || 1);
                const stdDev = Math.sqrt(sqSum / 20);
                const fib50 = high20 - (high20 - low20) * 0.5;
                const fib618 = high20 - (high20 - low20) * 0.618;

                const bullMods = [], bearMods = [];

                if (app.btMods.smc) {
                    if ((c.low > prev2.high && prev.close > prev.open) || (c.low <= low20 * 1.012 && c.close > c.open)) bullMods.push('smc');
                    if ((c.high < prev2.low && prev.close < prev.open) || (c.high >= high20 * 0.988 && c.close < c.open)) bearMods.push('smc');
                }
                if (app.btMods.sr) {
                    if (Math.abs(c.low - low20) / low20 < 0.012 && c.close >= c.open) bullMods.push('sr');
                    if (Math.abs(c.high - high20) / high20 < 0.012 && c.close <= c.open) bearMods.push('sr');
                }
                if (app.btMods.fib) {
                    if (c.low <= fib50 * 1.005 && c.close >= fib618 * 0.995 && c.close > c.open) bullMods.push('fib');
                    if (c.high >= fib50 * 0.995 && c.close <= (low20 + (high20 - low20) * 0.618) * 1.005 && c.close < c.open) bearMods.push('fib');
                }
                if (app.btMods.pa) {
                    const body = Math.abs(c.close - c.open), pBody = Math.abs(prev.close - prev.open);
                    const lw = Math.min(c.open, c.close) - c.low, uw = c.high - Math.max(c.open, c.close);
                    if ((prev.close < prev.open && c.close > c.open && body >= pBody * 0.9) || lw > body * 1.5) bullMods.push('pa');
                    if ((prev.close > prev.open && c.close < c.open && body >= pBody * 0.9) || uw > body * 1.5) bearMods.push('pa');
                }
                if (app.btMods.ta) {
                    if (c.close > high9 * 0.998 && c.close > c.open) bullMods.push('ta');
                    if (c.close < low9 * 1.002 && c.close < c.open) bearMods.push('ta');
                }
                if (app.btMods.liq) {
                    if (c.low < prev.low && c.close > prev.low && c.close > c.open) bullMods.push('liq');
                    if (c.high > prev.high && c.close < prev.high && c.close < c.open) bearMods.push('liq');
                }
                if (app.btMods.rsi) {
                    if (rsiArr[i] < 46 || (rsiArr[i] > rsiArr[i-1] && rsiArr[i-1] < 42)) bullMods.push('rsi');
                    if (rsiArr[i] > 54 || (rsiArr[i] < rsiArr[i-1] && rsiArr[i-1] > 58)) bearMods.push('rsi');
                }
                if (app.btMods.st) {
                    if (c.close > ema20[i] && c.close > prev.close) bullMods.push('st');
                    if (c.close < ema20[i] && c.close < prev.close) bearMods.push('st');
                }
                if (app.btMods.macd) {
                    const mNow = ema12[i] - ema26[i], mPrev = ema12[i-1] - ema26[i-1];
                    if (mNow > mPrev) bullMods.push('macd');
                    if (mNow < mPrev) bearMods.push('macd');
                }
                if (app.btMods.bb) {
                    if (c.low <= ema20[i] - stdDev * 1.35 || c.close > ema20[i] + stdDev * 1.2) bullMods.push('bb');
                    if (c.high >= ema20[i] + stdDev * 1.35 || c.close < ema20[i] - stdDev * 1.2) bearMods.push('bb');
                }
                if (app.btMods.ema) {
                    if (ema20[i] >= ema50[i] * 0.998 && c.close > ema20[i]) bullMods.push('ema');
                    if (ema20[i] <= ema50[i] * 1.002 && c.close < ema20[i]) bearMods.push('ema');
                }
                if (app.btMods.ichi) {
                    const tenkan = (high9 + low9) / 2, kijun = (high20 + low20) / 2;
                    if (tenkan >= kijun && c.close > tenkan) bullMods.push('ichi');
                    if (tenkan <= kijun && c.close < tenkan) bearMods.push('ichi');
                }
                if (app.btMods.vwap) {
                    if (c.vol > avgVol * 0.95 && c.close >= vwap) bullMods.push('vwap');
                    if (c.vol > avgVol * 0.95 && c.close < vwap) bearMods.push('vwap');
                }
                if (app.btMods.stoch) {
                    const pos = (c.close - low9) / ((high9 - low9) || 1);
                    if (pos < 0.38 && c.close > c.open) bullMods.push('stoch');
                    if (pos > 0.62 && c.close < c.open) bearMods.push('stoch');
                }

                let sig = null, matched = [];
                if (bullMods.length >= reqCount && bullMods.length >= bearMods.length) {
                    sig = 'LONG'; matched = bullMods;
                } else if (bearMods.length >= reqCount) {
                    sig = 'SHORT'; matched = bearMods;
                }

                if (dirFilter === 'long' && sig === 'SHORT') sig = null;
                if (dirFilter === 'short' && sig === 'LONG') sig = null;

                if (sig) {
                    // Сітка беремо з вкладки бота (calculateVelesGrid): ті самі indent/overlap/логарифм/мартингейл
                    const entry0 = c.close;
                    const grid = app.bot.gridTable.length ? app.bot.gridTable : window.calculateVelesGrid(entry0).orders;
                    const levels = gridMode === 'dca' ? grid : grid.slice(0, 1);
                    const baseDrop = levels[0].dropPct;
                    const levelPrice = (o) => entry0 * (1 + (sig === 'LONG' ? -1 : 1) * (o.dropPct - baseDrop) / 100);

                    let filledOrders = 1;
                    let filledUsd = gridMode === 'dca' ? levels[0].usd : startDep * lev;
                    let filledCoins = filledUsd / entry0;
                    let avgPrice = entry0;
                    let dealMaePct = 0;

                    const lastGridPrice = levelPrice(levels[levels.length - 1]);
                    const slPrice = sig === 'LONG' ? lastGridPrice * (1 - slPct) : lastGridPrice * (1 + slPct);

                    let resType = 'ЧАС', exitIdx = Math.min(n - 1, i + TIME_EXIT_BARS), exitPrice = cs[exitIdx].close;
                    const limitJ = exitIdx;

                    for (let j = i + 1; j <= limitJ; j++) {
                        const bar = cs[j];

                        // Добір усереднюючих ордерів (глибокий гніт може зачепити кілька рівнів)
                        while (filledOrders < levels.length) {
                            const nextPrice = levelPrice(levels[filledOrders]);
                            const hit = sig === 'LONG' ? bar.low <= nextPrice : bar.high >= nextPrice;
                            if (!hit) break;
                            filledUsd += levels[filledOrders].usd;
                            filledCoins += levels[filledOrders].usd / nextPrice;
                            avgPrice = filledUsd / filledCoins;
                            filledOrders++;
                            if (filledOrders > maxGridOrderReached) maxGridOrderReached = filledOrders;
                        }

                        // MAE: максимальне просідання угоди від середньої ціни
                        const curAdv = sig === 'LONG' ? ((avgPrice - bar.low) / avgPrice) * 100 : ((bar.high - avgPrice) / avgPrice) * 100;
                        if (curAdv > dealMaePct) dealMaePct = curAdv;
                        if (dealMaePct > maxMaePct) maxMaePct = dealMaePct;

                        const dynamicTpPrice = sig === 'LONG' ? avgPrice * (1 + tpPct) : avgPrice * (1 - tpPct);
                        const liqPrice = sig === 'LONG' ? avgPrice * (1 - LIQ_MARGIN_FRACTION / lev) : avgPrice * (1 + LIQ_MARGIN_FRACTION / lev);
                        const liqFirst = sig === 'LONG' ? liqPrice > slPrice : liqPrice < slPrice;
                        const stopPrice = liqFirst ? liqPrice : slPrice;
                        const stopType = liqFirst ? 'LIQ' : 'SL';

                        // Стоп перевіряється раніше за TP (консервативно для свічки, що зачепила обидва рівні)
                        if (sig === 'LONG') {
                            if (bar.low <= stopPrice) { resType = stopType; exitPrice = stopPrice; exitIdx = j; break; }
                            if (bar.high >= dynamicTpPrice) { resType = 'TP'; exitPrice = dynamicTpPrice; exitIdx = j; break; }
                        } else {
                            if (bar.high >= stopPrice) { resType = stopType; exitPrice = stopPrice; exitIdx = j; break; }
                            if (bar.low <= dynamicTpPrice) { resType = 'TP'; exitPrice = dynamicTpPrice; exitIdx = j; break; }
                        }
                    }

                    const rawPct = sig === 'LONG' ? (exitPrice - avgPrice) / avgPrice : (avgPrice - exitPrice) / avgPrice;
                    // Розмір позиції = задіяна частина сітки (з урахуванням плеча), масштабована під поточний баланс
                    const positionUsd = filledUsd * (balance / startDep);
                    const feeUsd = positionUsd * feeRate * 2;
                    totalFeesPaid += feeUsd;

                    const netPnlUsd = Math.max(-balance, positionUsd * rawPct - feeUsd);
                    balance += netPnlUsd;
                    equity.push(balance);

                    const isWin = netPnlUsd >= 0;
                    if (isWin) wins++;

                    matched.forEach(m => {
                        if (modStats[m]) {
                            modStats[m].triggers++;
                            if (isWin) modStats[m].wins++;
                        }
                    });

                    trades.push({
                        num: trades.length + 1,
                        time: new Date(c.time).toLocaleString('uk-UA', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
                        sig,
                        comboText: matched.map(m => MOD_NAMES[m]).join(' + '),
                        filledOrders,
                        maxOrders: levels.length,
                        avgPrice,
                        exitPrice,
                        mae: dealMaePct.toFixed(2),
                        resType,
                        netUsd: netPnlUsd.toFixed(2),
                        pct: ((netPnlUsd / startDep) * 100).toFixed(2),
                        win: isWin
                    });

                    if (balance <= 0) break;
                    i = Math.max(i + 2, exitIdx);
                }
            }

            let peak = equity[0], maxDdPct = 0;
            for (const e of equity) {
                if (e > peak) peak = e;
                const dd = peak > 0 ? ((peak - e) / peak) * 100 : 0;
                if (dd > maxDdPct) maxDdPct = dd;
            }

            const total = trades.length;
            const wr = total ? ((wins / total) * 100).toFixed(1) : '0.0';
            const netUsdTotal = balance - startDep;
            const roiPct = ((netUsdTotal / startDep) * 100).toFixed(2);

            document.getElementById('btFinalCap').textContent = `Фінал: $${balance.toFixed(2)} (${netUsdTotal >= 0 ? '+' : ''}${roiPct}% ROI)`;

            document.getElementById('btSummary').innerHTML = `
                <div class="p-2.5 rounded-lg bg-[#0b0e14] border border-slate-800"><div class="text-[10px] text-slate-400">Чистий Net Profit</div><b class="text-sm ${netUsdTotal>=0?'text-emerald-400':'text-red-400'}">${netUsdTotal>=0?'+':''}$${netUsdTotal.toFixed(2)} (${roiPct}%)</b></div>
                <div class="p-2.5 rounded-lg bg-[#0b0e14] border border-slate-800"><div class="text-[10px] text-slate-400">Угоди / Winrate</div><b class="text-sm text-white">${total} <span class="text-emerald-400">(${wr}%)</span></b></div>
                <div class="p-2.5 rounded-lg bg-[#0b0e14] border border-slate-800"><div class="text-[10px] text-slate-400">Комісія біржі</div><b class="text-sm text-slate-300">-$${totalFeesPaid.toFixed(2)}</b></div>
                <div class="p-2.5 rounded-lg bg-[#0b0e14] border border-slate-800"><div class="text-[10px] text-slate-400">Макс. ордер сітки</div><b class="text-sm text-cyan-400">${maxGridOrderReached} з ${gridMode==='dca'?app.bot.ordersCount:1}</b></div>
                <div class="p-2.5 rounded-lg bg-[#0b0e14] border border-slate-800"><div class="text-[10px] text-slate-400">Макс. MAE угоди</div><b class="text-sm text-red-400">-${maxMaePct.toFixed(2)}%</b></div>
                <div class="p-2.5 rounded-lg bg-[#0b0e14] border border-slate-800"><div class="text-[10px] text-slate-400">Макс. просадка капіталу</div><b class="text-sm text-red-400">-${maxDdPct.toFixed(2)}%</b></div>
            `;

            document.getElementById('btModuleStats').innerHTML = activeMods.map(m => {
                const st = modStats[m];
                const mWr = st.triggers ? Math.round((st.wins / st.triggers) * 100) : 0;
                return `<div class="px-2.5 py-1 rounded bg-[#131722] border border-slate-700/80 flex items-center gap-1.5">
                    <span class="font-bold text-white">${MOD_NAMES[m]}:</span>
                    <span class="text-slate-400">${st.triggers} уг.</span>
                    <b class="${mWr >= 55 ? 'text-emerald-400' : 'text-amber-400'}">(${mWr}% Win)</b>
                </div>`;
            }).join('');

            window.drawEquityCanvas(equity);

            document.getElementById('btLog').innerHTML = trades.slice().reverse().map(t => `
                <div class="flex flex-wrap items-center justify-between p-2 rounded bg-[#0b0e14] border border-slate-800/80 gap-2">
                    <div>
                        <span class="text-slate-500">#${t.num} (${t.time})</span>
                        <span class="ml-1 px-1.5 py-0.5 rounded font-bold text-[10px] ${t.sig==='LONG'?'bg-emerald-500/20 text-emerald-400':'bg-red-500/20 text-red-400'}">${t.sig}</span>
                        <span class="ml-1 px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[10px] font-bold">Сітка: ${t.filledOrders}/${t.maxOrders} орд.</span>
                        <span class="ml-1 text-amber-300/90 font-sans font-semibold">${t.comboText}</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="text-slate-400">Сер.$${fmt(t.avgPrice)} → $${fmt(t.exitPrice)} (MAE: ${t.mae}%)</span>
                        <b class="${t.win ? 'text-emerald-400' : 'text-red-400'}">${t.win ? '✅ +' : '❌ '}$${t.netUsd} (${t.resType})</b>
                    </div>
                </div>
            `).join('') || '<div class="text-amber-400 p-3 font-sans">За суворим фільтром сигнали не збіглися на одній свічці. Перемкніть логіку на «🤝 Синергія (Мін. 2 збіги)».</div>';
        };

        window.drawEquityCanvas = function(eq) {
            const canvas = document.getElementById('btEquityCanvas');
            if (!canvas || !eq || eq.length < 2) return;
            const rect = canvas.parentElement.getBoundingClientRect();
            const W = rect.width || 320, H = rect.height || 160;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            ctx.fillStyle = '#090c10';
            ctx.fillRect(0, 0, W, H);

            const minE = Math.min(...eq) * 0.992;
            const maxE = Math.max(...eq) * 1.008;
            const range = (maxE - minE) || 1;
            const isProfit = eq[eq.length - 1] >= eq[0];

            ctx.strokeStyle = isProfit ? '#10b981' : '#ef4444';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            for (let i = 0; i < eq.length; i++) {
                const x = 10 + (i / (eq.length - 1)) * (W - 20);
                const y = H - 14 - ((eq[i] - minE) / range) * (H - 28);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        // =========================================================================
        // ГОЛОВНИЙ ГРАФІК З ВІЗУАЛІЗАЦІЄЮ СІТКИ БОТА VELES
        // =========================================================================
        window.drawChart = function() {
            const canvas = document.getElementById('mainCanvas');
            if (!canvas || !app.candles.length) return;
            const rect = canvas.parentElement.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;

            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            const W = rect.width, H = rect.height;
            const padR = 68, padT = 18, padB = 22;
            const cW = W - padR, cH = H - padT - padB;

            const endIdx = Math.max(20, app.candles.length - app.panOffset);
            const startIdx = Math.max(0, endIdx - app.visibleBars);
            const slice = app.candles.slice(startIdx, endIdx);

            let minP = slice[0].low, maxP = slice[0].high;
            for (let i = 1; i < slice.length; i++) {
                if (slice[i].low < minP) minP = slice[i].low;
                if (slice[i].high > maxP) maxP = slice[i].high;
            }
            const highPeak = maxP, lowPeak = minP;
            const diff = (maxP - minP) || 1;
            minP -= diff * 0.1; maxP += diff * 0.08;

            const py = (p) => padT + cH - ((p - minP) / (maxP - minP)) * cH;
            const step = cW / Math.max(1, slice.length);
            const ix = (i) => i * step + step * 0.5;

            ctx.fillStyle = '#090c10';
            ctx.fillRect(0, 0, W, H);

            ctx.strokeStyle = '#151b26';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 5; i++) {
                const y = padT + (cH / 5) * i;
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cW, y); ctx.stroke();
                const val = maxP - ((maxP - minP) / 5) * i;
                ctx.fillStyle = '#64748b'; ctx.font = '10px monospace';
                ctx.fillText(fmt(val), cW + 4, y + 3);
            }

            if (app.layers.fib) {
                [0.236, 0.382, 0.5, 0.618, 0.786].forEach(lvl => {
                    const fp = highPeak - (highPeak - lowPeak) * lvl;
                    const y = py(fp);
                    ctx.strokeStyle = lvl === 0.618 ? 'rgba(245, 158, 11, 0.75)' : 'rgba(59, 130, 246, 0.35)';
                    ctx.setLineDash([2, 3]);
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cW, y); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = lvl === 0.618 ? '#fbbf24' : '#60a5fa';
                    ctx.font = '9px monospace';
                    ctx.fillText(`Fib ${lvl} ($${fmt(fp)})`, 6, y - 3);
                });
            }

            if (app.layers.mtf) {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
                ctx.fillRect(0, py(highPeak) - 4, cW, 10);
                ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
                ctx.fillRect(0, py(lowPeak) - 6, cW, 10);
            }

            if (app.layers.liq) {
                const liqTop = highPeak * 1.004, liqBot = lowPeak * 0.996;
                ctx.strokeStyle = '#ec4899'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(cW * 0.35, py(liqTop)); ctx.lineTo(cW, py(liqTop)); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(cW * 0.35, py(liqBot)); ctx.lineTo(cW, py(liqBot)); ctx.stroke();
            }

            if (app.layers.smc) {
                for (let i = 3; i < slice.length; i++) {
                    const c0 = slice[i-2], c1 = slice[i-1], c2 = slice[i];
                    if (c2.low > c0.high && c1.close > c1.open) {
                        ctx.fillStyle = 'rgba(168, 85, 247, 0.22)';
                        ctx.fillRect(ix(i-1), py(c2.low), cW - ix(i-1), Math.max(3, py(c0.high) - py(c2.low)));
                    }
                }
            }

            if (app.layers.vpvr) {
                const bins = 16;
                const vols = new Array(bins).fill(0);
                for (let i = 0; i < slice.length; i++) {
                    const b = Math.min(bins - 1, Math.max(0, Math.floor(((slice[i].close - minP) / ((maxP - minP) || 1)) * bins)));
                    vols[b] += slice[i].vol;
                }
                const maxV = Math.max(...vols) || 1;
                const pocBin = vols.indexOf(maxV);
                for (let b = 0; b < bins; b++) {
                    const bw = (vols[b] / maxV) * (cW * 0.22);
                    const by = padT + cH - ((b + 1) / bins) * cH;
                    ctx.fillStyle = b === pocBin ? 'rgba(245, 158, 11, 0.45)' : 'rgba(100, 116, 139, 0.22)';
                    ctx.fillRect(cW - bw, by, bw, (cH / bins) - 1);
                }
            }

            // ШАР СІТКИ ОРДЕРІВ БОТА VELES НА ГРАФІКУ
            if (app.layers.botgrid && app.bot.gridTable.length) {
                const lastC = slice[slice.length - 1].close;
                const tpLine = app.bot.algo === 'LONG' ? lastC * (1 + app.bot.tpPct / 100) : lastC * (1 - app.bot.tpPct / 100);
                const yTp = py(tpLine);
                if (yTp >= padT && yTp <= padT + cH) {
                    ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1.8;
                    ctx.beginPath(); ctx.moveTo(cW * 0.55, yTp); ctx.lineTo(cW, yTp); ctx.stroke();
                    ctx.fillStyle = '#10b981'; ctx.font = 'bold 9px sans-serif';
                    ctx.fillText(`🎯 Veles TP ($${fmt(tpLine)})`, cW * 0.56, yTp - 4);
                }

                app.bot.gridTable.forEach(o => {
                    const yo = py(o.price);
                    if (yo >= padT && yo <= padT + cH) {
                        ctx.strokeStyle = 'rgba(34, 211, 238, 0.75)';
                        ctx.setLineDash([4, 3]);
                        ctx.beginPath(); ctx.moveTo(cW * 0.55, yo); ctx.lineTo(cW, yo); ctx.stroke();
                        ctx.setLineDash([]);
                        ctx.fillStyle = '#22d3ee'; ctx.font = '9px monospace';
                        ctx.fillText(`🤖 Орд #${o.idx} ($${o.usd.toFixed(0)})`, cW * 0.56, yo - 2);
                    }
                });
            }

            // Свічки
            const bw = Math.max(2.5, step * 0.66);
            for (let i = 0; i < slice.length; i++) {
                const c = slice[i], x = ix(i), up = c.close >= c.open;
                ctx.strokeStyle = up ? '#10b981' : '#ef4444';
                ctx.fillStyle = up ? '#10b981' : '#ef4444';
                ctx.lineWidth = 1.2;
                ctx.beginPath(); ctx.moveTo(x, py(c.high)); ctx.lineTo(x, py(c.low)); ctx.stroke();
                const yO = py(c.open), yC = py(c.close);
                ctx.fillRect(x - bw/2, Math.min(yO, yC), bw, Math.max(2, Math.abs(yC - yO)));
            }

            if (app.layers.pat && slice.length > 15) {
                const i1 = Math.floor(slice.length * 0.35), i2 = slice.length - 1;
                ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(ix(i1), py(slice[i1].high)); ctx.lineTo(ix(i2), py(slice[i2].high)); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(ix(i1), py(slice[i1].low)); ctx.lineTo(ix(i2), py(slice[i2].low)); ctx.stroke();
            }
        };

        window.renderAnalyticsAndBook = function(lastP, ticker, depth) {
            const c = app.candles[app.candles.length - 1];
            const high25 = Math.max(...app.candles.slice(-25).map(x => x.high));
            const low25 = Math.min(...app.candles.slice(-25).map(x => x.low));

            document.getElementById('boxPatterns').innerHTML = `
                <div class="p-2 rounded bg-amber-500/10 border border-amber-500/30"><b class="text-amber-400">📐 Динамічний трикутник / Канал</b><div class="text-slate-300">Межі: $${fmt(low25)} — $${fmt(high25)}</div></div>
                <div class="p-2 rounded bg-emerald-500/10 border border-emerald-500/30"><b class="text-emerald-400">🕯️ Свічка: ${c.close >= c.open ? 'Бичача активність' : 'Ведмежий тиск'}</b></div>
            `;
            document.getElementById('boxSmc').innerHTML = `
                <div class="p-2 rounded bg-purple-500/10 border border-purple-500/30"><b class="text-purple-400">Bullish Order Block:</b> $${fmt(low25 * 1.002)}</div>
                <div class="p-2 rounded bg-pink-500/10 border border-pink-500/30"><b class="text-pink-400">Пул Ліквідацій Short:</b> $${fmt(high25 * 1.004)}</div>
            `;
            const qv = ticker && ticker.quoteVolume ? parseFloat(ticker.quoteVolume) : 640000000;
            document.getElementById('boxMetrics').innerHTML = `
                <div class="flex justify-between"><span>Об'єм 24г:</span><b class="text-white">$${fmtK(qv)}</b></div>
                <div class="flex justify-between"><span>Волатильність:</span><b class="text-amber-400">${(((high25-low25)/low25)*100).toFixed(2)}%</b></div>
                <div class="flex justify-between"><span>Золотий перетин Fib 0.618:</span><b class="text-blue-400">$${fmt(high25 - (high25-low25)*0.618)}</b></div>
            `;
            document.getElementById('boxSR').innerHTML = `
                <div class="flex justify-between p-1.5 rounded bg-red-500/10 border border-red-500/30"><span class="text-red-400 font-bold">Спротив R1 (MTF)</span><span class="font-mono">$${fmt(high25)}</span></div>
                <div class="flex justify-between p-1.5 rounded bg-amber-500/20 border border-amber-500/40 font-bold"><span>ПОТОЧНА ЦІНА</span><span class="font-mono">$${fmt(lastP)}</span></div>
                <div class="flex justify-between p-1.5 rounded bg-emerald-500/10 border border-emerald-500/30"><span class="text-emerald-400 font-bold">Підтримка S1 (MTF)</span><span class="font-mono">$${fmt(low25)}</span></div>
            `;

            const hasDepth = depth && Array.isArray(depth.asks) && depth.asks.length > 0 && Array.isArray(depth.bids) && depth.bids.length > 0;
            const asks = hasDepth ? depth.asks.slice(0, 5).reverse() : [[lastP*1.0015, 2.1],[lastP*1.001, 1.4],[lastP*1.0005, 3.2]];
            const bids = hasDepth ? depth.bids.slice(0, 5) : [[lastP*0.9995, 3.5],[lastP*0.999, 1.8],[lastP*0.9985, 2.7]];

            const sumB = bids.reduce((s, b) => s + (+b[0])*(+b[1]), 0);
            const sumA = asks.reduce((s, a) => s + (+a[0])*(+a[1]), 0);
            const bidPct = Math.round((sumB / ((sumB + sumA) || 1)) * 100);

            document.getElementById('bidPctTxt').textContent = `Покупці: ${bidPct}%`;
            document.getElementById('askPctTxt').textContent = `Продавці: ${100 - bidPct}%`;
            document.getElementById('bidBar').style.width = `${bidPct}%`;

            document.getElementById('asksList').innerHTML = asks.map(a => `<div class="order-row flex justify-between px-1 py-0.5"><div class="bar-ask" style="width:65%"></div><span class="text-red-400">${fmt(a[0])}</span><span>${(+a[1]).toFixed(2)}</span><span>$${fmtK(a[0]*a[1])}</span></div>`).join('');
            document.getElementById('midPriceBook').textContent = '$' + fmt(lastP);
            document.getElementById('bidsList').innerHTML = bids.map(b => `<div class="order-row flex justify-between px-1 py-0.5"><div class="bar-bid" style="width:72%"></div><span class="text-emerald-400">${fmt(b[0])}</span><span>${(+b[1]).toFixed(2)}</span><span>$${fmtK(b[0]*b[1])}</span></div>`).join('');
            document.getElementById('wallsInfo').innerHTML = `<div class="flex justify-between text-emerald-400"><span>🐋 Стінка Bid:</span><b>$${fmt(bids[0][0])}</b></div><div class="flex justify-between text-red-400"><span>🐋 Стінка Ask:</span><b>$${fmt(asks[asks.length-1][0])}</b></div>`;
        };

        // =========================================================================
        // НАВІГАЦІЯ ТА ДОДАТКОВІ МОДУЛІ
        // =========================================================================
        window.toggleLayer = function(k, btn) { app.layers[k] = !app.layers[k]; btn.classList.toggle('layer-on'); window.drawChart(); };
        window.zoomChart = function(delta) { app.visibleBars = Math.min(140, Math.max(20, app.visibleBars - delta)); window.drawChart(); };
        window.resetChartZoom = function() { app.visibleBars = 55; app.panOffset = 0; window.drawChart(); };
        window.toggleFS = function() { document.getElementById('chartPanel').classList.toggle('fullscreen-box'); setTimeout(window.drawChart, 60); };

        window.changeSymbol = function(s) {
            app.sym = s;
            document.getElementById('coinSelect').value = s;
            app.candles = [];
            app.reqId++; app.inFlightKey = null;
            window.loadMainData();
            if (app.mode === 'tv') window.loadTV();
        };

        window.changeTF = function(tf, tv, btn) {
            app.tf = tf; app.tvTf = tv;
            app.reqId++; app.inFlightKey = null;
            document.querySelectorAll('.tf-b').forEach(b => b.className = "tf-b px-2 py-1 rounded text-xs font-bold text-slate-400");
            btn.className = "tf-b px-2 py-1 rounded text-xs font-bold gold-btn";
            app.candles = [];
            window.loadMainData();
            if (app.mode === 'tv') window.loadTV();
        };

        window.switchChartEngine = function(m) {
            app.mode = m;
            document.getElementById('canvasBox').classList.toggle('hidden', m !== 'canvas');
            document.getElementById('layerBar').classList.toggle('hidden', m !== 'canvas');
            document.getElementById('tvBox').classList.toggle('hidden', m !== 'tv');
            document.getElementById('btnModeCanvas').className = m === 'canvas' ? 'gold-btn py-1.5 rounded text-xs' : 'py-1.5 rounded text-xs font-bold text-slate-400';
            document.getElementById('btnModeTV').className = m === 'tv' ? 'gold-btn py-1.5 rounded text-xs' : 'py-1.5 rounded text-xs font-bold text-slate-400';
            if (m === 'tv') window.loadTV(); else setTimeout(window.drawChart, 50);
        };

        window.loadTV = function() {
            const box = document.getElementById('tvBox');
            box.innerHTML = '';
            if (typeof TradingView !== 'undefined') {
                new TradingView.widget({ autosize: true, symbol: "BINANCE:" + app.sym, interval: app.tvTf, theme: "dark", style: "1", locale: "uk", studies: ["RSI@tv-basicstudies", "MASimple@tv-basicstudies"], container_id: "tvBox" });
            }
        };

        window.openTab = function(id, btn) {
            document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
            document.getElementById('view-' + id).classList.remove('hidden');
            document.querySelectorAll('.t-btn').forEach(b => b.className = "t-btn py-1.5 px-2 rounded-lg text-xs font-bold text-slate-400");
            if (btn) btn.className = "t-btn gold-btn py-1.5 px-2 rounded-lg text-xs";

            if (id === 'terminal') setTimeout(window.drawChart, 50);
            if (id === 'velesbot') window.updateBotGridPreview();
            if (id === 'screener') window.scanTop20();
            if (id === 'multi' && !document.getElementById('multiGrid').children.length) window.buildMulti(4);
            if (id === 'backtest') setTimeout(window.executeBacktest, 30);
        };

        // Текст колонок скрінера з результату Analysis.analyze (чиста функція в analysis.js)
        window.describeScan = function(a) {
            if (!a) return { pat: '—', smc: '—', rsi: null };
            let pat = '—';
            if (a.breakout) pat = `📐 Пробій 20-св. ${a.breakout.type === 'up' ? 'макс.' : 'мін.'}`;
            else if (a.candle) pat = `🕯️ ${a.candle}`;
            else if (a.nearLevel) pat = `🎯 Біля ${a.nearLevel.type === 'support' ? 'підтримки' : 'опору'}`;
            const smc = a.fvg ? `${a.fvg.type === 'bull' ? '🟢 Bull' : '🔴 Bear'} FVG (${a.fvg.age} св.)` : '—';
            return { pat, smc, rsi: a.rsi };
        };

        window.scanTop20 = function() {
            const scanTf = app.tf;
            window.fetchBinance('/ticker/24hr').then(all => {
                app.scrDemo = !(Array.isArray(all) && all.length);
                const tickers = app.scrDemo
                    ? COINS.map((s, idx) => ({ symbol: s, lastPrice: BASE_PRICES[s] || 10, priceChangePercent: (idx % 2 === 0 ? 1 : -1) * (1.2 + (idx * 0.45) % 5.5), quoteVolume: 120000000 + idx * 45000000 }))
                    : COINS.map(s => all.find(x => x.symbol === s)).filter(Boolean);

                return Promise.all(tickers.map(t =>
                    (app.scrDemo ? Promise.resolve(null) : window.fetchBinance(`/klines?symbol=${t.symbol}&interval=${scanTf}&limit=120`))
                        .then(k => {
                            const cs = Array.isArray(k)
                                // остання свічка ще не закрита — відкидаємо
                                ? k.slice(0, -1).map(x => ({ time: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], vol: +x[5] }))
                                : (app.scrDemo ? window.generateFallbackCandles(t.symbol, 120) : null);
                            return { t, scan: window.describeScan(window.Analysis.analyze(cs)) };
                        })
                )).then(rows => {
                    if (scanTf !== app.tf) return;   // користувач уже змінив таймфрейм
                    app.scrList = rows.map(({ t, scan }) => ({
                        sym: t.symbol, p: +t.lastPrice, chg: +t.priceChangePercent, vol: +t.quoteVolume, ...scan
                    }));
                    window.renderScr();
                });
            }).catch(err => console.error('scanTop20 failed:', err));
        };

        window.setScrFilter = function(f, btn) {
            app.scrFilter = f;
            document.querySelectorAll('.scr-f').forEach(b => b.className = "scr-f px-2.5 py-1 rounded bg-[#1a202c] text-slate-300 font-bold text-xs");
            if (btn) btn.className = "scr-f gold-btn px-2.5 py-1 rounded text-xs";
            window.renderScr();
        };

        window.renderScr = function() {
            let list = app.scrList;
            if (app.scrFilter === 'vol') list = list.filter(x => Math.abs(x.chg) > 2.0);
            if (app.scrFilter === 'pat') list = list.filter(x => x.pat.includes('📐') || x.pat.includes('🕯️'));
            if (app.scrFilter === 'smc') list = list.filter(x => x.smc.includes('🟢'));

            const demoRow = app.scrDemo ? '<tr><td colspan="6" class="p-2 text-amber-300 font-bold">⚠ ДЕМО-ДАНІ: Binance недоступний</td></tr>' : '';
            document.getElementById('scrBody').innerHTML = demoRow + list.map(x => `
                <tr>
                    <td class="p-2 font-bold text-white">${x.sym}</td>
                    <td class="p-2 font-mono">$${fmt(x.p)} <span class="${x.chg>=0?'text-emerald-400':'text-red-400'}">(${x.chg>=0?'+':''}${x.chg.toFixed(2)}%)</span></td>
                    <td class="p-2 font-mono">$${fmtK(x.vol)}</td>
                    <td class="p-2 text-amber-300">${x.pat}${x.rsi === null ? '' : ` <span class="text-slate-500">RSI ${x.rsi.toFixed(0)}</span>`}</td>
                    <td class="p-2">${x.smc}</td>
                    <td class="p-2"><button onclick="window.changeSymbol('${x.sym}');window.openTab('velesbot',document.getElementById('nav-velesbot'))" class="gold-btn px-2 py-1 rounded text-[10px]">🤖 У Veles-Бот</button></td>
                </tr>`).join('');
        };

        window.buildMulti = function(n) {
            const g = document.getElementById('multiGrid'); g.innerHTML = '';
            COINS.slice(0, n).forEach((s, i) => {
                const d = document.createElement('div'); d.className = "panel p-2 h-[250px] flex flex-col";
                d.innerHTML = `<div class="text-xs font-bold text-amber-400 mb-1 flex justify-between"><span>#${i+1} ${s}</span><button onclick="window.changeSymbol('${s}');window.openTab('terminal',document.getElementById('nav-terminal'))" class="text-[10px] text-blue-400">Відкрити →</button></div><div id="mc_${i}" class="flex-1 w-full"></div>`;
                g.appendChild(d);
                if (typeof TradingView !== 'undefined') {
                    setTimeout(() => new TradingView.widget({ autosize: true, symbol: "BINANCE:" + s, interval: app.tvTf, theme: "dark", hide_side_toolbar: true, container_id: `mc_${i}` }), i * 120);
                }
            });
        };

        window.beep = function(freq) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination); o.frequency.value = freq;
                g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
                o.start(); o.stop(ctx.currentTime + 0.35);
            } catch (e) {}
        };

        window.sendTgTest = function() {
            window.beep(680);
            const tok = document.getElementById('tgTok').value.trim(), cid = document.getElementById('tgCid').value.trim();
            if (tok && cid) {
                fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({chat_id: cid, text: `🤖 Veles (симуляція, ${app.bot.exchange}): ${app.sym} = ${document.getElementById('topPrice').textContent}`}) })
                    .then(r => r.json().catch(() => ({})).then(body => {
                        if (!r.ok || body.ok === false) throw new Error(body.description || `HTTP ${r.status}`);
                        document.getElementById('tgStatus').textContent = "✅ Повідомлення доставлено в Telegram!";
                    }))
                    .catch(err => { document.getElementById('tgStatus').textContent = `⚠️ Telegram: ${err.message}. Перевірте Token і Chat ID.`; });
            } else {
                document.getElementById('tgStatus').textContent = "🔊 Звуковий сигнал протестовано!";
            }
        };

        let dragX = null;
        const cEl = document.getElementById('mainCanvas');
        cEl.addEventListener('pointerdown', e => { dragX = e.clientX; });
        window.addEventListener('pointermove', e => {
            if (dragX === null) return;
            const dx = e.clientX - dragX;
            if (Math.abs(dx) > 8) {
                app.panOffset = Math.max(0, Math.min(app.candles.length - 25, app.panOffset + Math.sign(dx) * 2));
                dragX = e.clientX;
                window.drawChart();
            }
        });
        window.addEventListener('pointerup', () => { dragX = null; });

        window.addEventListener('resize', () => {
            window.drawChart();
            if (!document.getElementById('view-backtest').classList.contains('hidden')) window.executeBacktest();
        });

        window.addEventListener('DOMContentLoaded', () => {
            const sel = document.getElementById('coinSelect');
            sel.innerHTML = COINS.map(s => `<option value="${s}">${s.replace('USDT', ' / USDT')}</option>`).join('');
            sel.value = app.sym;
            window.loadMainData();
            setInterval(window.loadMainData, 7000);
        });
