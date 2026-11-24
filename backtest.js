"use strict";
// Бектестер Veles (було частиною app.js).
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
                if (app.dataState === 'live') {   // справжньої історії замало — не підміняємо її вигаданою
                    document.getElementById('btLog').innerHTML = '<div class="text-amber-400 p-3 font-sans">Замало свічок для бектесту (потрібно ≥ 40).</div>';
                    return;
                }
                app.candles = window.generateFallbackCandles(app.sym, CANDLE_LIMIT);
                app.dataState = 'demo';
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
