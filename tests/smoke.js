// Smoke-тест у headless Chromium з підміною мережі: node tests/smoke.js
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const BASE = { BTCUSDT: 80000, ETHUSDT: 3000, NEARUSDT: 4 };

function klines(sym, n) {
    const base = BASE[sym] || 100;
    return Array.from({ length: n }, (_, i) => {
        const o = base * (1 + Math.sin(i / 9) * 0.01), c = base * (1 + Math.sin((i + 1) / 9) * 0.01);
        return [Date.now() - (n - i) * 3600000, o, Math.max(o, c) * 1.003, Math.min(o, c) * 0.997, c, 1000 + i];
    });
}

async function mockBinance(page, { slowBtc = false } = {}) {
    await page.route('**/api/v3/**', async route => {
        const u = new URL(route.request().url());
        const sym = u.searchParams.get('symbol') || '';
        if (slowBtc && sym === 'BTCUSDT' && u.pathname.endsWith('/klines')) await new Promise(r => setTimeout(r, 900));
        let body;
        if (u.pathname.endsWith('/klines')) body = klines(sym, +u.searchParams.get('limit'));
        else if (u.pathname.endsWith('/depth')) body = { bids: [['79990', '1.2']], asks: [['80010', '1.1']] };
        else body = sym ? { priceChangePercent: '1.5', quoteVolume: '9e8' }
            : [{ symbol: 'BTCUSDT', lastPrice: '4', priceChangePercent: '3.1', quoteVolume: '5e8' }];
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
}

async function run(name, fn, browser) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) return;   // ONLY=trade node tests/smoke.js — лише потрібні тести
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try { await fn(page); assert.deepEqual(errors, [], 'page errors'); console.log('ok   ' + name); }
    catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
    finally { await page.close(); }
}

(async () => {
    const browser = await chromium.launch();

    await run('offline: demo badge shown, backtest renders', async page => {
        await page.route('**/api/v3/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(1200);
        assert.equal(await page.$eval('#demoBadge', e => e.classList.contains('hidden')), false);
        assert.match(await page.textContent('#demoBadge'), /ДЕМО/);
        await page.evaluate(() => window.openTab('backtest', document.getElementById('nav-backtest')));
        await page.waitForTimeout(400);
        assert.ok((await page.$$('#btLog > div')).length > 0);
    }, browser);

    await run('live: demo badge hidden, 1000 candles', async page => {
        await mockBinance(page);
        await page.goto(PAGE); await page.waitForTimeout(1200);
        assert.equal(await page.$eval('#demoBadge', e => e.classList.contains('hidden')), true);
        assert.equal(await page.evaluate(() => app.candles.length), 1000);
    }, browser);

    await run('race: stale response for old symbol is discarded', async page => {
        await mockBinance(page, { slowBtc: true });
        await page.goto(PAGE); await page.waitForTimeout(200);
        await page.evaluate(() => window.changeSymbol('ETHUSDT'));
        await page.waitForTimeout(1800);
        assert.match(await page.textContent('#topPrice'), /2,9|3,0/);   // ~$3000, не $80000
    }, browser);

    await run('coin select lists all COINS and follows screener choice', async page => {
        await mockBinance(page);
        await page.goto(PAGE); await page.waitForTimeout(500);
        assert.equal((await page.$$('#coinSelect option')).length, await page.evaluate(() => COINS.length));
        await page.evaluate(() => window.changeSymbol('NEARUSDT'));
        assert.equal(await page.inputValue('#coinSelect'), 'NEARUSDT');
    }, browser);

    await run('telegram: HTTP 401 is reported as failure', async page => {
        await mockBinance(page);
        await page.route('https://api.telegram.org/**', r => r.fulfill({ status: 401, contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' }, body: '{"ok":false,"description":"Unauthorized"}' }));
        await page.goto(PAGE);
        await page.evaluate(() => window.openTab('alerts', document.getElementById('nav-alerts')));
        await page.fill('#tgTok', 'x'); await page.fill('#tgCid', '1');
        await page.evaluate(() => window.sendTgTest()); await page.waitForTimeout(400);
        assert.match(await page.textContent('#tgStatus'), /Unauthorized/);
    }, browser);

    await run('refresh tick does not duplicate an in-flight request', async page => {
        let klineCalls = 0;
        // графік іде спершу у ф'ючерси: рахуємо перший запит ланцюжка (1h-свічки), решта хостів і потік скрінера — обрив
        await page.route('**/fapi/v1/klines**', async route => {
            if (new URL(route.request().url()).searchParams.get('interval') === '1h') klineCalls++;
            await new Promise(r => setTimeout(r, 500));
            await route.abort();
        });
        await page.route('**/api/v3/**', r => r.abort());
        await page.route('**/fapi/v1/ticker/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(100);
        assert.equal(klineCalls, 1);
        await page.evaluate(() => { window.loadMainData(); window.loadMainData(); });
        await page.waitForTimeout(100);
        assert.equal(klineCalls, 1);   // обидва виклики пропущено: запит для цієї пари вже летить
    }, browser);

    await run('screener: real analysis from klines (breakout + RSI), no heuristic text', async page => {
        await page.route('**/api/v3/**', async route => {
            const u = new URL(route.request().url());
            const sym = u.searchParams.get('symbol');
            let body;
            if (u.pathname.endsWith('/ticker/24hr') && !sym) body = [{ symbol: 'BTCUSDT', lastPrice: '110', priceChangePercent: '0.1', quoteVolume: '5e8' }];
            else if (u.pathname.endsWith('/klines')) {
                // 100 плоских свічок і різкий пробій вгору; остання (незакрита) свічка відкидається
                body = Array.from({ length: 101 }, (_, i) => i < 99 ? [i, 100, 101, 99, 100, 1] : i === 99 ? [i, 102, 112, 102, 110, 1] : [i, 110, 111, 109, 110, 1]);
            } else body = [];
            await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.goto(PAGE); await page.waitForTimeout(300);
        await page.evaluate(() => window.openTab('screener', document.getElementById('nav-screener')));
        await page.waitForTimeout(800);
        const row = await page.$eval('#scrBody tr', tr => tr.textContent.replace(/\s+/g, ' '));
        assert.match(row, /BTCUSDT/);
        assert.match(row, /Пробій 20-св\. макс\./);
        assert.match(row, /RSI \d+/);
        assert.match(row, /Bull FVG/);
    }, browser);


    await run('screener rescans when timeframe changes and shows it in the header', async page => {
        const intervals = [];
        await page.route('**/api/v3/**', async route => {
            const u = new URL(route.request().url());
            const sym = u.searchParams.get('symbol');
            if (u.pathname.endsWith('/klines') && sym === 'BTCUSDT') intervals.push(u.searchParams.get('interval'));
            const body = u.pathname.endsWith('/klines') ? klines(sym, +u.searchParams.get('limit'))
                : sym ? { priceChangePercent: '1', quoteVolume: '1e8' } : [{ symbol: 'BTCUSDT', lastPrice: '1', priceChangePercent: '1', quoteVolume: '1e8' }];
            await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.goto(PAGE); await page.waitForTimeout(300);
        await page.evaluate(() => window.openTab('screener', document.getElementById('nav-screener')));
        await page.waitForTimeout(600);
        assert.match(await page.textContent('#scrTfBadge'), /1H/);
        await page.evaluate(() => window.changeTF('4h', '240', document.querySelectorAll('.tf-b')[2]));
        await page.waitForTimeout(800);
        assert.match(await page.textContent('#scrTfBadge'), /4H/);
        assert.ok(intervals.includes('4h'));
    }, browser);

    await run('screener offline: demo row and 20 analysed rows', async page => {
        await page.route('**/api/v3/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(300);
        await page.evaluate(() => window.openTab('screener', document.getElementById('nav-screener')));
        await page.waitForTimeout(800);
        assert.equal((await page.$$('#scrBody tr')).length, 21);   // 20 монет + рядок «ДЕМО»
        assert.match(await page.textContent('#scrBody'), /ДЕМО-ДАНІ/);
    }, browser);

    await run('short but real kline history is not shown as demo data', async page => {
        await page.route('**/api/v3/**', async route => {
            const u = new URL(route.request().url());
            const body = u.pathname.endsWith('/klines') ? klines('BTCUSDT', 12) : u.searchParams.get('symbol') ? { priceChangePercent: '1', quoteVolume: '1e8' } : [];
            await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.goto(PAGE); await page.waitForTimeout(1000);
        assert.equal(await page.evaluate(() => app.dataState), 'live');
        assert.equal(await page.evaluate(() => app.candles.length), 12);
    }, browser);


    // --- вкладка «Скринер» (live): підроблені WebSocket і fapi REST ---
    async function liveSetup(page, { kl } = {}) {
        await page.addInitScript(() => {
            window.__sockets = [];
            window.WebSocket = class {
                constructor(url) { this.url = url; window.__sockets.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
                close() {}
            };
        });
        const now = Math.floor(Date.now() / 60000) * 60000;
        const fk = (spikeLast) => Array.from({ length: 130 }, (_, i) => {
            const t = now - (129 - i) * 60000, close = 100 + Math.sin(i / 5);
            return [t, close, close + 0.4, close - 0.4, close, 10, t + 59999, i >= 125 ? spikeLast : 1000];
        });
        await page.route('**/fapi/v1/**', route => {
            const u = new URL(route.request().url());
            const tk = (symbol, q) => ({ symbol, lastPrice: '100', priceChangePercent: '1.5', quoteVolume: String(q) });
            const info = (symbol, type) => ({ symbol, status: 'TRADING', contractType: type === 'COIN' ? 'PERPETUAL' : 'TRADIFI_PERPETUAL', underlyingType: type });
            const body = u.pathname.endsWith('/exchangeInfo')
                ? { symbols: [info('BTCUSDT', 'COIN'), info('ETHUSDT', 'COIN'), info('1000PEPEUSDT', 'COIN'), info('NVDAUSDT', 'EQUITY')] }
                : u.pathname.endsWith('/ticker/24hr')
                ? [tk('BTCUSDT', 9e9), tk('ETHUSDT', 5e9), tk('NVDAUSDT', 4e9), tk('1000PEPEUSDT', 1e9), tk('SOLUSDT_250101', 9e10)]
                : ((kl && kl(u.searchParams.get('symbol'))) || fk(u.searchParams.get('symbol') === 'ETHUSDT' ? 9000 : 1000));
            return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.route('**/api/v3/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(500);
        // сокет відкрито й пішли перші дані (порожній масив markPrice) → «Наживо»
        await page.evaluate(() => {
            const ws = window.__sockets[0];
            ws.onopen();
            ws.onmessage({ data: JSON.stringify({ stream: '!markPrice@arr@1s', data: [] }) });
            window.liveFeed.tick();
        });
    }

    await run('live tab is the default and renders metrics from feed data', async page => {
        await liveSetup(page);
        assert.equal(await page.$eval('#view-live', e => e.classList.contains('hidden')), false);
        assert.equal(await page.$eval('#view-terminal', e => e.classList.contains('hidden')), true);
        assert.equal((await page.$$('#lvBody tr[data-sym]')).length, 3);                 // без SOLUSDT_250101 і без акції NVDA
        assert.equal(await page.locator('#lvBody tr[data-sym="NVDAUSDT"]').count(), 0);
        assert.ok(String(await page.evaluate(() => window.__sockets[0].url)).includes('/market/stream?streams='));
        assert.equal(await page.textContent('#lvStatus'), 'Наживо');
        const eth = await page.$eval('#lvBody tr[data-sym="ETHUSDT"]', tr => tr.textContent.replace(/\s+/g, ' '));
        assert.match(eth, /×\d/);                                                       // сплеск обсягу порахований
        assert.match(eth, /\+1\.50%/);                                                  // 24г зміна з тікера
    }, browser);

    await run('live tab: header click sorts, filters narrow the list, settings persist', async page => {
        await liveSetup(page);
        await page.click('#lvHead th[data-k="spike"]');
        assert.equal(await page.$eval('#lvBody tr', tr => tr.dataset.sym), 'ETHUSDT');   // найбільший сплеск — зверху
        await page.fill('#lvSearch', 'eth');
        assert.equal((await page.$$('#lvBody tr[data-sym]')).length, 1);
        await page.reload(); await page.waitForTimeout(300);
        assert.equal(await page.inputValue('#lvSearch'), 'eth');                         // збереглося в localStorage
    }, browser);

    await run('live tab: clicking a row opens the terminal on that symbol (even futures-only)', async page => {
        await liveSetup(page);
        await page.click('#lvBody tr[data-sym="1000PEPEUSDT"]');
        assert.equal(await page.evaluate(() => app.sym), '1000PEPEUSDT');
        assert.equal(await page.inputValue('#coinSelect'), '1000PEPEUSDT');
        assert.equal(await page.$eval('#view-terminal', e => e.classList.contains('hidden')), false);
    }, browser);

    await run('live tab: kline websocket message updates the row', async page => {
        await liveSetup(page);
        const before = await page.$eval('#lvBody tr[data-sym="BTCUSDT"] td:nth-child(2)', e => e.textContent);
        await page.evaluate(() => {
            const k = Math.floor(Date.now() / 60000) * 60000;
            const data = { s: 'BTCUSDT', k: { t: k, o: '100', h: '260', l: '100', c: '250', v: '1', q: '5000' } };
            window.__sockets[0].onmessage({ data: JSON.stringify({ stream: 'btcusdt@kline_1m', data }) });
            window.liveFeed.tick();
        });
        const after = await page.$eval('#lvBody tr[data-sym="BTCUSDT"] td:nth-child(2)', e => e.textContent);
        assert.notEqual(before, after);
        assert.match(after, /250/);
    }, browser);


    await run('screener row opens a futures-first chart: source label, no invented order book', async page => {
        await liveSetup(page);
        await page.click('#lvBody tr[data-sym="1000PEPEUSDT"]');
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(() => app.dataSrc), 'Binance Futures');
        assert.equal(await page.textContent('#srcBadge'), 'Binance Futures');
        assert.match(await page.textContent('#asksList'), /стакан недоступний/);   // fapi-мок не віддає depth
        assert.doesNotMatch(await page.textContent('#bidsList'), /\d/);
        assert.doesNotMatch(await page.textContent('#bookLive'), /LIVE/);          // без стакана не пишемо LIVE
    }, browser);

    await run('futures depth uses a limit that the futures API accepts', async page => {
        const limits = [];
        await liveSetup(page);
        await page.route('**/fapi/v1/depth**', route => { limits.push(new URL(route.request().url()).searchParams.get('limit')); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"asks":[["101","1"]],"bids":[["99","1"]]}' }); });
        await page.click('#lvBody tr[data-sym="BTCUSDT"]');
        await page.waitForTimeout(800);
        assert.deepEqual([...new Set(limits)], ['20']);                                // 5/10/20/50/100/500/1000 — валідні
        assert.match(await page.textContent('#asksList'), /101/);
    }, browser);

    await run('live tab keeps showing why it cannot connect (HTTP 451)', async page => {
        await page.addInitScript(() => { window.WebSocket = class { close() {} }; });
        await page.route('**/fapi/v1/**', r => r.fulfill({ status: 451, body: '' }));
        await page.route('**/api/v3/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(800);
        const msg = await page.textContent('#lvDetail');
        assert.match(msg, /HTTP 451/);
        assert.match(msg, /VPN/);
        assert.equal(await page.$eval('#lvDetail', e => e.hidden), false);
        assert.match(await page.textContent('#lvBody'), /HTTP 451/);
    }, browser);


    await run('live tab: «Лише крипто» toggle restarts the feed, shows TradFi and is remembered', async page => {
        await liveSetup(page);
        assert.equal(await page.isChecked('#lvCryptoOnly'), true);
        await page.uncheck('#lvCryptoOnly');
        await page.waitForTimeout(600);
        await page.evaluate(() => {
            const ws = window.__sockets[window.__sockets.length - 1];
            ws.onopen();
            ws.onmessage({ data: JSON.stringify({ stream: '!markPrice@arr@1s', data: [] }) });
            window.liveFeed.tick();
        });
        assert.equal(await page.evaluate(() => window.__sockets.length), 2);                 // старий сокет закрито, відкрито новий
        assert.ok((await page.locator('#lvBody tr[data-sym="NVDAUSDT"]').count()) > 0);
        await page.reload(); await page.waitForTimeout(300);
        assert.equal(await page.isChecked('#lvCryptoOnly'), false);
    }, browser);


    // --- вкладка «Плотності»: книги ордерів з підробленого fapi /depth ---
    const depthFixture = (wallQty) => {
        const bids = [], asks = [];
        for (let i = 0; i < 60; i++) { bids.push([(99.9 - i * 0.1).toFixed(2), '10']); asks.push([(100.1 + i * 0.1).toFixed(2), '10']); }
        asks[10][1] = String(wallQty);                       // стіна на 101.1 (≈ +1.1% від ціни)
        return { lastUpdateId: 1, T: 5, bids, asks };
    };
    async function densSetup(page, { status = 200, wallQty = 3000 } = {}) {
        await liveSetup(page);
        await page.route('**/fapi/v1/depth**', route => route.fulfill({
            status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: status === 200 ? JSON.stringify(depthFixture(wallQty)) : '{}'
        }));
        await page.click('#nav-dens');
        for (let i = 0; i < 3; i++) await page.evaluate(() => window.densFeed.pollOnce());   // по колу: BTC, ETH, 1000PEPE
    }

    await run('density tab lists walls with size, distance, eat time and book depth', async page => {
        await densSetup(page);
        const rows = await page.$$eval('#dsBody tr[data-sym]', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ')));
        assert.equal(rows.length, 3);
        assert.match(rows[0], /ПРОДАВЦІ/);
        assert.match(rows[0], /\$30[0-9.]*K/);              // 101.1 × 3000 ≈ $303.3K
        assert.match(rows[0], /×\d+/);
        assert.match(rows[0], /1\.\d\d%/);                   // відстань ≈ 1.1%
        assert.match(rows[0], /хв/);
        assert.match(rows[0], /±\d/);                        // глибина книги
        assert.equal(await page.textContent('#dsStatus'), 'Наживо');
    }, browser);

    await run('density tab: size and distance filters narrow the list and are remembered', async page => {
        await densSetup(page);
        await page.fill('#dsMinUsd', '500');                 // $500K > $303K
        assert.equal((await page.$$('#dsBody tr[data-sym]')).length, 0);
        await page.fill('#dsMinUsd', '100');
        await page.fill('#dsMaxDist', '0.5');                // стіна на ≈ 1.1%
        assert.equal((await page.$$('#dsBody tr[data-sym]')).length, 0);
        await page.fill('#dsMaxDist', '2');
        assert.equal((await page.$$('#dsBody tr[data-sym]')).length, 3);
        await page.reload(); await page.waitForTimeout(300);
        assert.equal(await page.inputValue('#dsMinUsd'), '100');
    }, browser);

    await run('density wall is drawn on the chart layer and a row click opens that symbol', async page => {
        await densSetup(page);
        assert.ok(await page.evaluate(() => window.densFeed.forSymbol('BTCUSDT').length) > 0);
        await page.click('#dsBody tr[data-sym="1000PEPEUSDT"]');
        assert.equal(await page.evaluate(() => app.sym), '1000PEPEUSDT');
        assert.equal(await page.evaluate(() => window.app.layers.dens), true);
        await page.evaluate(() => window.drawChart());       // шар не має кидати помилок (run() перевіряє pageerror)
    }, browser);

    await run('density tab shows a pause when Binance rate-limits (HTTP 429)', async page => {
        await densSetup(page, { status: 429 });
        assert.equal(await page.textContent('#dsStatus'), 'Ліміт Binance: пауза');
        assert.equal((await page.$$('#dsBody tr[data-sym]')).length, 0);
    }, browser);

    await run('density polling stays idle while neither densities nor chart are on screen', async page => {
        let depthCalls = 0;
        await liveSetup(page);
        await page.route('**/fapi/v1/depth**', route => { depthCalls++; return route.abort(); });
        await page.evaluate(() => window.densFeed.pollOnce());   // відкрита вкладка «Скринер»
        assert.equal(depthCalls, 0);
    }, browser);


    await run('tab is kept in the URL hash and a #dens link opens that tab', async page => {
        await page.route('**/api/v3/**', r => r.abort());
        await page.route('**/fapi/v1/**', r => r.abort());
        await page.goto(PAGE + '#dens'); await page.waitForTimeout(500);
        assert.equal(await page.$eval('#view-dens', e => e.classList.contains('hidden')), false);
        assert.equal(await page.$eval('#view-live', e => e.classList.contains('hidden')), true);
        await page.click('#nav-terminal');
        assert.match(await page.evaluate(() => location.hash), /#terminal/);
    }, browser);


    // --- вкладка «Формації»: пробій на останній закритій свічці BTC ---
    const nowMin = () => Math.floor(Date.now() / 60000) * 60000;
    const breakoutKlines = (now) => (symbol) => {
        if (symbol !== 'BTCUSDT') return null;
        return Array.from({ length: 130 }, (_, i) => {
            const t = now - (129 - i) * 60000;
            if (i === 128) return [t, 100, 101.1, 100, 101, 10, t + 59999, 5000];     // закрита свічка пробою рівня 100.2
            if (i === 129) return [t, 101, 101.2, 100.9, 101.1, 10, t + 59999, 500];  // поточна, ще формується
            return [t, 100, 100.2, 99.8, 100, 10, t + 59999, 1000];
        });
    };
    const klineMsg = (t, o, h, l, c, q) => JSON.stringify({ stream: 'btcusdt@kline_1m', data: { s: 'BTCUSDT', k: { t, o: String(o), h: String(h), l: String(l), c: String(c), v: '1', q: String(q) } } });

    await run('formations tab shows a breakout found on the last closed candle and counts it in stats', async page => {
        const now = nowMin();
        await liveSetup(page, { kl: breakoutKlines(now) });
        await page.evaluate(() => window.formationsScan());
        await page.click('#nav-form');
        const row = await page.$eval('#fmBody tr[data-sym="BTCUSDT"]', tr => tr.textContent.replace(/\s+/g, ' '));
        assert.match(row, /Пробій рівня/);
        assert.match(row, /LONG/);
        assert.match(row, /відкрита/);
        assert.match(await page.textContent('#fmStats'), /Пробій рівня\s*1/);
        assert.equal((await page.$$('#fmBody tr[data-sym]')).length, 1);                // інші монети — без сигналів
    }, browser);

    await run('formations: take hit on later candles is recorded as a win and the history survives a reload', async page => {
        const now = nowMin();
        await liveSetup(page, { kl: breakoutKlines(now) });
        await page.evaluate(() => window.formationsScan());
        await page.evaluate(([a, b]) => {
            const ws = window.__sockets[0];
            ws.onmessage({ data: a });                                                    // поточна свічка сягнула тейку (≈103)
            ws.onmessage({ data: b });                                                    // нова хвилина → попередня стала закритою
            window.formationsScan();
        }, [klineMsg(now, 101, 103.6, 100.9, 103.4, 900), klineMsg(now + 60000, 103.4, 103.5, 103.2, 103.3, 400)]);
        await page.click('#nav-form');
        assert.match(await page.$eval('#fmBody tr[data-sym="BTCUSDT"]', tr => tr.textContent), /✅ \+2\.0R/);
        assert.match(await page.textContent('#fmStats'), /Пробій рівня\s*1\s*·\s*100%\s*·\s*\+2\.0R/);
        await page.reload(); await page.waitForTimeout(400);
        assert.equal(await page.$eval('#view-form', e => e.classList.contains('hidden')), false);   // вкладка з URL-хешу
        assert.match(await page.$eval('#fmBody tr[data-sym="BTCUSDT"]', tr => tr.textContent), /✅/);
    }, browser);

    await run('formations: corrupted saved history is discarded without breaking the page', async page => {
        await page.addInitScript(() => localStorage.setItem('cs_form_v1', JSON.stringify({ signals: [{ id: 5 }, null, 'x', { id: 'ok', type: 'nope' }], type: 'weird' })));
        await page.route('**/api/v3/**', r => r.abort());
        await page.route('**/fapi/v1/**', r => r.abort());
        await page.goto(PAGE + '#form'); await page.waitForTimeout(500);
        assert.match(await page.textContent('#fmBody'), /Поки що формацій не знайдено/);
        assert.equal(await page.inputValue('#fmType'), 'all');
    }, browser);

    await run('formations: filters (open only, type) work and the history can be cleared', async page => {
        const now = nowMin();
        await liveSetup(page, { kl: breakoutKlines(now) });
        await page.evaluate(() => window.formationsScan());
        await page.click('#nav-form');
        await page.selectOption('#fmType', 'surge');
        assert.equal((await page.$$('#fmBody tr[data-sym]')).length, 0);
        await page.selectOption('#fmType', 'breakout');
        await page.check('#fmOpen');
        assert.equal((await page.$$('#fmBody tr[data-sym]')).length, 1);
        page.once('dialog', d => d.accept());
        await page.click('#fmClear');
        assert.equal((await page.$$('#fmBody tr[data-sym]')).length, 0);
    }, browser);


    // --- вкладка «Торгівля»: УСІ запити до Supabase підроблено; реальних викликів біржі/Orbix немає ---
    const SB_KEY_NAME = 'sb-krmnaypaitruhqgaxkfw-auth-token';
    const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const fakeSession = (aal, factors) => ({
        access_token: `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'u1', aal, amr: [], role: 'authenticated', exp: 4102444800 })}.sig`,
        refresh_token: 'r', expires_at: 4102444800, expires_in: 3600, token_type: 'bearer',
        user: { id: 'u1', aud: 'authenticated', role: 'authenticated', factors, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
    });
    const VERIFIED = [{ id: 'f1', status: 'verified', factor_type: 'totp' }];
    const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

    async function tradeSetup(page, { session = fakeSession('aal2', VERIFIED), conns, bots = [], fn } = {}) {
        const calls = { exchange: [], auth: 0, rest: [] };
        const conn = conns || [{ id: 'c1', exchange: 'bybit', status: 'active', key_hint: 'ab12', can_trade: true, last_checked_at: null }];
        await page.addInitScript(([key, s]) => {
            window.WebSocket = class { close() {} };
            if (s) localStorage.setItem(key, s);
        }, [SB_KEY_NAME, session ? JSON.stringify(session) : null]);
        await page.route('**/api/v3/**', r => r.abort());
        await page.route('**/fapi/v1/**', r => r.abort());
        await page.route('**/krmnaypaitruhqgaxkfw.supabase.co/**', async route => {
            const req = route.request(), url = new URL(req.url());
            const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
            if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
            if (url.pathname.startsWith('/auth/')) { calls.auth++; return json(400, { error: 'unexpected auth call' }); }
            if (url.pathname.startsWith('/rest/v1/exchange_connections')) { calls.rest.push('exchange_connections'); return json(200, conn); }
            if (url.pathname.startsWith('/rest/v1/bots')) { calls.rest.push('bots'); return json(200, bots); }
            if (url.pathname === '/functions/v1/exchange') {
                const body = JSON.parse(req.postData() || '{}');
                calls.exchange.push(body);
                const r = (fn && fn(body)) || { status: 200, json: { ok: true, positions: [], canTrade: true, wallet: 1000, available: 900, unrealized: 5 } };
                return json(r.status, r.json);
            }
            return json(404, {});
        });
        await page.goto(PAGE + '#trade'); await page.waitForTimeout(700);
        return calls;
    }
    const acceptDialogs = (page, store) => page.on('dialog', d => { store.push(d.message()); d.accept(); });

    await run('trade: without a session nothing is sent to the exchange function and there is no order form', async page => {
        const calls = await tradeSetup(page, { session: null });
        assert.match(await page.textContent('#trBody'), /Увійдіть в Orbix/);
        assert.equal(await page.locator('#trBuy').count(), 0);
        assert.equal(calls.exchange.length, 0);
        assert.equal(calls.auth, 0);
    }, browser);

    await run('trade: a seeded Orbix session unlocks the panel, is never cleared and causes no auth or exchange requests', async page => {
        const calls = await tradeSetup(page);
        assert.ok((await page.locator('#trBuy').count()) > 0);
        assert.equal(calls.exchange.length, 0);                                           // жодних автоматичних звернень до біржі
        assert.equal(calls.auth, 0);
        const kept = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), SB_KEY_NAME);
        assert.equal(kept.refresh_token, 'r');
        assert.match(await page.textContent('#trBody'), /2FA: підтверджено/);
    }, browser);

    await run('trade: without 2FA the panel is read-only and explains how to enable it in Orbix', async page => {
        const calls = await tradeSetup(page, { session: fakeSession('aal1', []) });
        assert.match(await page.textContent('#trBody'), /Увімкніть двофакторний вхід в Orbix/);
        assert.equal(await page.locator('#trBuy').count(), 0);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('trade: 2FA enrolled but not confirmed asks for the code in Orbix', async page => {
        await tradeSetup(page, { session: fakeSession('aal1', VERIFIED) });
        assert.match(await page.textContent('#trBody'), /кодом з Google Authenticator в Orbix/);
        assert.equal(await page.locator('#trBuy').count(), 0);
    }, browser);

    await run('trade: keys are never entered here (no key fields) and the Orbix link is offered', async page => {
        await tradeSetup(page, { conns: [] });
        assert.match(await page.textContent('#trBody'), /Додайте ключі біржі в Orbix/);
        assert.equal(await page.locator('input[type="password"]').count(), 0);
        assert.equal(await page.locator('#trBody input[placeholder*="Key" i]').count(), 0);
        assert.equal(await page.getAttribute('#trBody a', 'href'), 'https://koloss10.github.io/Orbix/');
    }, browser);

    await run('trade: a pair with an Orbix server bot is blocked for orders and for closing', async page => {
        const seen = [];
        const calls = await tradeSetup(page, {
            bots: [{ id: 'b1', name: 'BTC bot', symbol: 'BTC/USDT', status: 'running', config: { _srv: true, _tn: true, _ex: 'bybit' } }],
            fn: b => (b.action === 'positions' ? { status: 200, json: { ok: true, positions: [{ symbol: 'BTCUSDT', amt: 0.1, entry: 60000, mark: 60100, pnl: 10, lev: 3 }] } } : null)
        });
        acceptDialogs(page, seen);
        await page.fill('#trSym', 'BTCUSDT');
        await page.click('#trBuy');
        assert.match(await page.textContent('#trMsg'), /працює бот Orbix/);
        assert.equal(seen.length, 0);                                                     // підтвердження навіть не показували
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        assert.match(await page.textContent('#trBody'), /\(бот Orbix, заблоковано\)/);
        assert.equal(await page.locator('[data-act="close"]').count(), 0);                           // кнопки «Закрити» для ботової пари немає
        assert.equal(calls.exchange.filter(b => b.action === 'order' || b.action === 'close').length, 0);
    }, browser);

    await run('trade: an order sends the exact body once, shows the confirmation text and is NOT retried on failure', async page => {
        const seen = [];
        const calls = await tradeSetup(page, {
            fn: b => (b.action === 'order' ? { status: 502, json: { error: 'ab not enough', code: 110007 } } : null)
        });
        acceptDialogs(page, seen);
        await page.fill('#trSym', 'ethusdt'); await page.fill('#trNotional', '150'); await page.fill('#trLev', '5');
        await page.click('#trBuy'); await page.waitForTimeout(500);
        const orders = calls.exchange.filter(b => b.action === 'order');
        assert.equal(orders.length, 1);                                                   // жодних автоповторів
        assert.deepEqual(orders[0], { exchange: 'bybit', action: 'order', symbol: 'ETHUSDT', side: 'BUY', notional: 150, leverage: 5 });
        assert.match(seen[0], /Bybit Demo/i); assert.match(seen[0], /БЕЗ СТОПА/);
        assert.match(await page.textContent('#trMsg'), /Недостатньо коштів на демо-рахунку/);
        assert.equal(calls.exchange.filter(b => b.action === 'positions').length, 1);     // після помилки показуємо справжні позиції
    }, browser);

    await run('trade: cancelling the confirmation sends nothing', async page => {
        const calls = await tradeSetup(page);
        page.on('dialog', d => d.dismiss());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trSell'); await page.waitForTimeout(300);
        assert.equal(calls.exchange.length, 0);
        assert.match(await page.textContent('#trMsg'), /Скасовано/);
    }, browser);

    await run('trade: invalid input is rejected before anything is sent (size above the client cap)', async page => {
        const calls = await tradeSetup(page);
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT'); await page.fill('#trNotional', '99999');
        await page.click('#trBuy'); await page.waitForTimeout(200);
        assert.match(await page.textContent('#trMsg'), /Сума ордера/);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('trade: success shows the server fill and refreshes positions; Bybit is the default exchange', async page => {
        const calls = await tradeSetup(page, {
            fn: b => (b.action === 'order' ? { status: 200, json: { ok: true, order: { symbol: 'ETHUSDT', side: 'BUY', qty: 0.08, price: 1712.3456, approx: false } } }
                : b.action === 'positions' ? { status: 200, json: { ok: true, positions: [{ symbol: 'ETHUSDT', amt: 0.08, entry: 1712.3, mark: 1713, pnl: 0.05, lev: 3 }] } } : null)
        });
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(500);
        assert.match(await page.textContent('#trMsg'), /Виконано: купівля 0\.08 ETHUSDT за 1712\.3456/);
        assert.match(await page.textContent('#trBody'), /Закрити/);
        assert.ok(calls.exchange.every(b => b.exchange === 'bybit'));
    }, browser);

    await run('trade: 403 «mfa required» from the server shows the Orbix instruction', async page => {
        await tradeSetup(page, { fn: () => ({ status: 403, json: { error: 'mfa required' } }) });
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        assert.match(await page.textContent('#trMsg'), /Google Authenticator в Orbix/);
    }, browser);

    await run('trade: strings from the server are escaped (positions and error text)', async page => {
        await tradeSetup(page, {
            fn: b => (b.action === 'positions'
                ? { status: 200, json: { ok: true, positions: [{ symbol: '<img src=x onerror="window.__xss=1">', amt: 1, entry: 1, mark: 1, pnl: 0, lev: 1 }] } }
                : { status: 502, json: { error: '<b id="pwn">boom</b>' } })
        });
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => window.__xss), undefined);
        assert.match(await page.textContent('#trBody'), /<img src=x/);                   // видно як текст
        await page.click('[data-act="check"]'); await page.waitForTimeout(300);
        assert.equal(await page.locator('#pwn').count(), 0);
        assert.match(await page.textContent('#trMsg'), /<b id="pwn">boom<\/b>/);
    }, browser);

    await run('trade: the 🛒 button on a formation only prefills the pair and never sends an order', async page => {
        const calls = await tradeSetup(page);
        await page.evaluate(() => window.openTrade({ symbol: 'SOLUSDT', side: 'short' }));
        await page.waitForTimeout(500);
        assert.equal(await page.inputValue('#trSym'), 'SOLUSDT');
        assert.match(await page.textContent('#trBody'), /Сигнал: SOLUSDT SHORT/);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('TradingView script is not loaded with the page, only on demand', async page => {
        const asked = [];
        page.on('request', r => { if (r.url().includes('tradingview.com')) asked.push(r.url()); });
        await page.route('**/s3.tradingview.com/**', r => r.abort());
        await page.route('**/api/v3/**', r => r.abort());
        await page.route('**/fapi/v1/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(600);
        assert.equal(asked.length, 0);
        await page.evaluate(() => window.switchChartEngine('tv')); await page.waitForTimeout(300);
        assert.ok(asked.length >= 1);
    }, browser);

    // «Скачати .html» -> автономний файл має відкриватись без помилок (потрібен http, не file://)
    const server = http.createServer((req, res) => {
        const f = path.join(__dirname, '..', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
        fs.readFile(f, (err, data) => { if (err) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(data); } });
    }).listen(0);
    const port = server.address().port;
    await run('download bundles a working standalone html', async page => {
        await page.route('**/api/v3/**', r => r.abort());
        await page.goto('http://127.0.0.1:' + port + '/'); await page.waitForTimeout(500);
        const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.downloadAppFile())]);
        const out = path.join(require('node:os').tmpdir(), 'cs_bundle_test.html');
        await dl.saveAs(out);
        const bundle = await browser.newPage();
        const errs = [];
        bundle.on('pageerror', e => errs.push(e.message));
        await bundle.route('**/api/v3/**', r => r.abort());
        await bundle.goto('file://' + out); await bundle.waitForTimeout(1200);
        assert.deepEqual(errs, []);
        assert.ok(await bundle.evaluate(() => app.candles.length) > 0);
        const srcs = await bundle.evaluate(() => [...document.querySelectorAll('script[src]')].map(s => s.src.slice(0, 5)));
        assert.deepEqual(srcs, ['data:']);                                   // лише вбудована бібліотека входу; зовнішніх скриптів немає
        assert.equal(await bundle.evaluate(() => typeof window.supabase.createClient), 'function');
        await bundle.close();
        fs.unlinkSync(out);
    }, browser);
    server.close();

    await browser.close();
})();
