"use strict";
// Головний графік із сіткою бота (було частиною app.js).
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

            // Плотності з книги ордерів (density-feed): лінії зі стороною й розміром; поза видимим діапазоном цін не малюємо
            if (app.layers.dens && window.densFeed) {
                ctx.font = 'bold 9px sans-serif';
                window.densFeed.forSymbol(app.sym).forEach(w => {
                    const y = py(w.price);
                    if (y < padT || y > padT + cH) return;
                    const color = w.side === 'bid' ? '#34D399' : '#FB7185';
                    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(cW * 0.2, y); ctx.lineTo(cW, y); ctx.stroke();
                    ctx.fillText(`🧱 $${fmtK(w.usd)}${w.eatMin !== null ? ' · ~' + (w.eatMin < 1 ? '<1' : Math.round(w.eatMin)) + ' хв' : ''}`, cW * 0.21, y - 3);
                });
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
            const live = document.getElementById('bookLive');
            live.textContent = hasDepth ? '● LIVE' : '● немає даних';
            live.className = 'text-[10px] font-bold ' + (hasDepth ? 'text-emerald-400' : 'text-slate-500');
            if (!hasDepth) {   // без даних біржі стакан не вигадуємо
                const na = '<div class="px-1 py-2 text-slate-500 text-center">стакан недоступний</div>';
                document.getElementById('asksList').innerHTML = na;
                document.getElementById('bidsList').innerHTML = '';
                document.getElementById('bidPctTxt').textContent = 'Покупці: —';
                document.getElementById('askPctTxt').textContent = 'Продавці: —';
                document.getElementById('bidBar').style.width = '50%';
                document.getElementById('midPriceBook').textContent = '$' + fmt(lastP);
                document.getElementById('wallsInfo').innerHTML = '';
                return;
            }
            const asks = depth.asks.slice(0, 5).reverse();
            const bids = depth.bids.slice(0, 5);

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
