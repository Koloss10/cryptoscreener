"use strict";
// Veles-бот і підключення до бірж (було частиною app.js; спільні const/let — глобальні, скрипти завантажуються по черзі).
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
