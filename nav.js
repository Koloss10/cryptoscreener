"use strict";
// Навігація, TradingView на вимогу, скрінер Топ-20, сповіщення бота й запуск (було частиною app.js).
        // =========================================================================
        // НАВІГАЦІЯ ТА ДОДАТКОВІ МОДУЛІ
        // =========================================================================
        window.toggleLayer = function(k, btn) { app.layers[k] = !app.layers[k]; btn.classList.toggle('layer-on'); window.drawChart(); };
        window.zoomChart = function(delta) { app.visibleBars = Math.min(140, Math.max(20, app.visibleBars - delta)); window.drawChart(); };
        window.resetChartZoom = function() { app.visibleBars = 55; app.panOffset = 0; window.drawChart(); };
        window.toggleFS = function() { document.getElementById('chartPanel').classList.toggle('fullscreen-box'); setTimeout(window.drawChart, 60); };

        window.changeSymbol = function(s, opts) {
            if (opts && typeof opts.futures === 'boolean') app.preferFutures = opts.futures;
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
            if (!document.getElementById('view-screener').classList.contains('hidden')) window.scanTop20();
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

        // Сторонній скрипт TradingView вантажимо лише коли він справді потрібен: сторінка ділить origin із сесією Orbix
        window.loadTradingView = function() {
            if (window.TradingView) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://s3.tradingview.com/tv.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('tv.js не завантажився'));
                document.head.appendChild(s);
            });
        };

        window.loadTV = function() {
            const box = document.getElementById('tvBox');
            box.innerHTML = '';
            window.loadTradingView().then(() => {
                new TradingView.widget({ autosize: true, symbol: "BINANCE:" + app.sym, interval: app.tvTf, theme: "dark", style: "1", locale: "uk", studies: ["RSI@tv-basicstudies", "MASimple@tv-basicstudies"], container_id: "tvBox" });
            }).catch(() => { box.textContent = 'TradingView недоступний (мережа або блокувальник).'; });
        };

        window.openTab = function(id, btn) {
            document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
            document.getElementById('view-' + id).classList.remove('hidden');
            document.querySelectorAll('.t-btn').forEach(b => b.className = "t-btn py-1.5 px-2 rounded-lg text-xs font-bold text-slate-400");
            if (btn) btn.className = "t-btn gold-btn py-1.5 px-2 rounded-lg text-xs";

            try { history.replaceState(null, '', '#' + id); } catch (e) { /* file:// у деяких браузерах не дозволяє — не критично */ }
            if (id === 'live' && window.renderLive) window.renderLive();
            if (id === 'dens' && window.renderDens) window.renderDens();
            if (id === 'form' && window.renderForm) window.renderForm();
            if (id === 'trade' && window.renderTrade) window.renderTrade();
            if (id === 'cmp' && window.renderCompare) window.renderCompare();
            if (id === 'sig' && window.renderSignals) window.renderSignals();
            if (id !== 'cmp' && window.leaveCompare) window.leaveCompare();
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
                    if (scanTf !== app.tf) return;   // користувач уже змінив таймфрейм; changeTF запустить новий скан
                    app.scrTf = scanTf;
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

            document.getElementById('scrTfBadge').textContent = app.scrTf ? `(${app.scrTf.toUpperCase()})` : '';
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
                window.loadTradingView().then(() => {
                    setTimeout(() => new TradingView.widget({ autosize: true, symbol: "BINANCE:" + s, interval: app.tvTf, theme: "dark", hide_side_toolbar: true, container_id: `mc_${i}` }), i * 120);
                }).catch(() => { d.insertAdjacentText('beforeend', 'TradingView недоступний'); });
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
            const tabId = location.hash.slice(1);   // посилання на вкладку: …/#dens
            if (tabId && document.getElementById('nav-' + tabId)) window.openTab(tabId, document.getElementById('nav-' + tabId));
            const sel = document.getElementById('coinSelect');
            sel.innerHTML = COINS.map(s => `<option value="${s}">${s.replace('USDT', ' / USDT')}</option>`).join('');
            sel.value = app.sym;
            window.loadMainData();
            setInterval(window.loadMainData, 7000);
        });
