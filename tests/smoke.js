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

    // --- джерело OKX у скринері: знімок із гілки data (підроблений) ---
    const okxSnap = (ageMs = 60000) => ({
        ts: Date.now() - ageMs, ex: 'okx',
        coins: [
            { s: 'BTCUSDT', last: 60000, chg24h: -2.5, volUsd: 8e9, oiUsd: 1.8e9, fund: 0.0001 },
            { s: 'SOLUSDT', last: 150, chg24h: 4.2, volUsd: 2e9, oiUsd: 5e8, fund: -0.0002 },
            { s: 'XYZUSDT', last: 1, chg24h: 0.1, volUsd: 1e6, oiUsd: null, fund: null }
        ],
        walls: { BTCUSDT: { mid: 60000, bids: [{ px: 59900, usd: 500000, dist: -0.17 }], asks: [{ px: 60100, usd: 900000, dist: 0.17 }] } }
    });
    async function okxSetup(page, { snap = okxSnap(), status = 200 } = {}) {
        const hits = { n: 0, by: {} };
        await liveSetup(page);
        await page.route('**/raw.githubusercontent.com/**', route => {
            hits.n++;
            const ex = (new URL(route.request().url()).pathname.match(/\/data\/([a-z]+)\/latest\.json$/) || [])[1];
            hits.by[ex] = (hits.by[ex] || 0) + 1;
            return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...snap, ex }) });   // знімок завжди «своєї» біржі
        });
        return hits;
    }

    await run('okx source: switching shows the OKX table with its own columns, filters and a note', async page => {
        await okxSetup(page);
        await page.click('#lvSource [data-src="okx"]'); await page.waitForTimeout(500);
        assert.equal(await page.locator('#lvBody tr[data-sym]').count(), 3);
        assert.match(await page.textContent('#lvHead'), /Відкр\. інтерес/);
        assert.match(await page.textContent('#lvHead'), /Стіна/);
        assert.doesNotMatch(await page.textContent('#lvHead'), /NATR/);
        const btc = await page.$eval('#lvBody tr[data-sym="BTCUSDT"]', tr => tr.textContent.replace(/\s+/g, ' '));
        assert.match(btc, /60,?000/); assert.match(btc, /-2\.50%/); assert.match(btc, /\$900/);       // найбільша стіна 900K
        assert.equal(await page.textContent('#lvStatus'), 'Наживо');
        assert.equal(await page.isDisabled('#lvMinNatr'), true);
        assert.match(await page.textContent('#lvNote'), /збирач на GitHub Actions/);
        await page.fill('#lvSearch', 'sol');
        assert.equal(await page.locator('#lvBody tr[data-sym]').count(), 1);
    }, browser);

    await run('okx source: min volume filter uses the 24h volume; Binance feed keeps running in the background', async page => {
        await okxSetup(page);
        await page.click('#lvSource [data-src="okx"]'); await page.waitForTimeout(400);
        await page.fill('#lvMinVol', '1500');                                   // 1500 млн $ → лишаються BTC і SOL
        assert.equal(await page.locator('#lvBody tr[data-sym]').count(), 2);
        assert.equal(await page.evaluate(() => typeof window.liveFeed.getRows), 'function');
        assert.ok((await page.evaluate(() => window.liveFeed.getRows().length)) > 0);
    }, browser);

    await run('okx source: an old snapshot is flagged as stale, a missing one shows the error, neither is shown as live', async page => {
        await okxSetup(page, { snap: okxSnap(40 * 60000) });
        await page.click('#lvSource [data-src="okx"]'); await page.waitForTimeout(500);
        assert.notEqual(await page.textContent('#lvStatus'), 'Наживо');
        assert.match(await page.textContent('#lvDetail'), /застаріли на 40 хв/);
    }, browser);

    await run('okx source: HTTP error from the data branch is reported', async page => {
        await okxSetup(page, { status: 404 });
        await page.click('#lvSource [data-src="okx"]'); await page.waitForTimeout(500);
        assert.match(await page.textContent('#lvDetail'), /HTTP 404/);
        assert.equal(await page.locator('#lvBody tr[data-sym]').count(), 0);
    }, browser);

    await run('okx source: nothing is requested from GitHub until OKX is selected, and switching back restores the Binance table', async page => {
        const hits = await okxSetup(page);
        await page.waitForTimeout(400);
        assert.equal(hits.n, 0);
        await page.click('#lvSource [data-src="okx"]'); await page.waitForTimeout(400);
        assert.equal(hits.n, 1);
        await page.click('#lvSource [data-src="binance"]'); await page.waitForTimeout(300);
        assert.match(await page.textContent('#lvHead'), /NATR/);
        assert.equal(await page.isDisabled('#lvMinNatr'), false);
        assert.equal(await page.locator('#lvBody tr[data-sym="ETHUSDT"]').count(), 1);
    }, browser);

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


    // --- вкладка «Торгівля»: УСІ запити до Supabase підроблено; реальних викликів біржі немає ---
    const SB_HOST = 'ozffbhmfyoerdiosbfqq.supabase.co';
    const SB_KEY_NAME = 'sb-ozffbhmfyoerdiosbfqq-auth-token';
    const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const fakeSession = (aal, factors) => ({
        access_token: `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'u1', aal, amr: [], role: 'authenticated', exp: 4102444800 })}.sig`,
        refresh_token: 'r', expires_at: 4102444800, expires_in: 3600, token_type: 'bearer',
        user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'me@example.com', factors, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
    });
    const VERIFIED = [{ id: 'f1', status: 'verified', factor_type: 'totp' }];
    const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const ACTIVE = { id: 'c1', exchange: 'bybit', status: 'active', key_hint: 'ab12', can_trade: true, last_checked_at: null };
    const LINK_RE = /^cs[0-9a-f]{20}$/;

    // session: сесія в localStorage (null — не ввійшли); afterLogin/afterVerify — що поверне сервер входу
    async function tradeSetup(page, { session = fakeSession('aal2', VERIFIED), conns = [ACTIVE], fn, afterLogin = fakeSession('aal1', []), afterVerify = fakeSession('aal2', VERIFIED) } = {}) {
        const calls = { exchange: [], auth: [], rest: [], rpc: [], conns };
        await page.addInitScript(([key, s]) => {
            window.WebSocket = class { close() {} };
            if (s) localStorage.setItem(key, s);
        }, [SB_KEY_NAME, session ? JSON.stringify(session) : null]);
        await page.route('**/api/v3/**', r => r.abort());
        await page.route('**/fapi/v1/**', r => r.abort());
        await page.route(`**/${SB_HOST}/**`, async route => {
            const req = route.request(), url = new URL(req.url());
            const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
            const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (e) { return {}; } };
            if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
            const p = url.pathname;
            if (p.startsWith('/auth/v1/')) {
                calls.auth.push({ path: p, body: body() });
                if (p === '/auth/v1/token' || p === '/auth/v1/signup') return json(200, afterLogin);
                if (p === '/auth/v1/user') return json(200, (afterLogin || fakeSession('aal1', [])).user);
                if (p === '/auth/v1/factors') return json(200, { id: 'f2', type: 'totp', totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://x' } });
                if (p.endsWith('/challenge')) return json(200, { id: 'ch1', expires_at: 4102444800 });
                if (p.endsWith('/verify')) return json(200, afterVerify);
                if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: CORS });
                return json(400, { error: 'unexpected auth call' });
            }
            if (p.startsWith('/rest/v1/rpc/')) {
                const name = p.split('/').pop();
                calls.rpc.push({ name, body: body() });
                if (name === 'ex_save') { calls.conns = [{ ...ACTIVE, status: 'pending', can_trade: false }]; return json(200, 'c1'); }
                if (name === 'ex_delete') { calls.conns = []; return json(200, null); }
                return json(404, {});
            }
            if (p.startsWith('/rest/v1/exchange_connections')) { calls.rest.push('exchange_connections'); return json(200, calls.conns); }
            if (p === '/functions/v1/exchange') {
                const b = body();
                calls.exchange.push(b);
                const r = (fn && fn(b)) || { status: 200, json: { ok: true, positions: [], order: null, canTrade: true, wallet: 1000, available: 900, unrealized: 5 } };
                if (r.delay) await new Promise(res => setTimeout(res, r.delay));
                if (r.abort) return route.abort();
                if (r.raw !== undefined) return route.fulfill({ status: r.status, contentType: 'text/html', headers: CORS, body: r.raw });
                return json(r.status, r.json);
            }
            return json(404, {});
        });
        await page.goto(PAGE + '#trade'); await page.waitForTimeout(700);
        return calls;
    }
    const acceptDialogs = (page, store) => page.on('dialog', d => { store.push(d.message()); d.accept(); });
    const msg = page => page.textContent('#trMsg');

    await run('trade: without a session only the login form is shown and nothing is sent anywhere', async page => {
        const calls = await tradeSetup(page, { session: null });
        assert.equal(await page.isVisible('#trLogin'), true);
        assert.equal(await page.isVisible('#trMfa'), false);
        assert.equal(await page.isVisible('#trKeys'), false);
        assert.equal(await page.locator('#trBuy').count(), 0);
        assert.match(await page.textContent('#trBody'), /Увійдіть або створіть акаунт/);
        assert.deepEqual([calls.exchange.length, calls.auth.length, calls.rpc.length], [0, 0, 0]);
    }, browser);

    await run('trade: signed in without 2FA shows only the 2FA block (no keys, no order form)', async page => {
        const calls = await tradeSetup(page, { session: fakeSession('aal1', []) });
        assert.equal(await page.isVisible('#trMfa'), true);
        assert.equal(await page.isVisible('#trMfaStart'), true);
        assert.equal(await page.isVisible('#trKeys'), false);
        assert.equal(await page.isVisible('#trLogin'), false);
        assert.equal(await page.locator('#trBuy').count(), 0);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('trade: sign-in sends the credentials once, clears the password field and keeps it out of state and storage', async page => {
        const calls = await tradeSetup(page, { session: null });
        await page.fill('#trEmail', 'me@example.com'); await page.fill('#trPass', 'S3cret-pass-XYZ');
        await page.click('#trLogin button[type="submit"]'); await page.waitForTimeout(500);
        const tokens = calls.auth.filter(c => c.path === '/auth/v1/token');
        assert.equal(tokens.length, 1);
        assert.deepEqual([tokens[0].body.email, tokens[0].body.password], ['me@example.com', 'S3cret-pass-XYZ']);
        assert.equal(await page.inputValue('#trPass'), '');
        const leaked = await page.evaluate(() => JSON.stringify(window.tradeState) + JSON.stringify(Object.entries(localStorage)));
        assert.equal(leaked.includes('S3cret-pass-XYZ'), false);
        assert.equal(await page.isVisible('#trMfa'), true);                                 // далі — 2FA
        assert.equal(await page.isVisible('#trLogin'), false);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('trade: enabling 2FA shows the QR and secret, a correct code unlocks the key form', async page => {
        const calls = await tradeSetup(page, { session: fakeSession('aal1', []), conns: [] });
        await page.click('#trMfaStart'); await page.waitForTimeout(400);
        assert.equal(await page.isVisible('#trMfaEnroll'), true);
        assert.match(await page.textContent('#trSecretTxt'), /JBSWY3DPEHPK3PXP/);
        assert.match(await page.getAttribute('#trQr', 'src'), /^data:image\/svg\+xml/);
        await page.fill('#trTotp', '123 456');
        await page.click('#trMfaForm button[type="submit"]'); await page.waitForTimeout(500);
        const verify = calls.auth.find(c => c.path.endsWith('/verify'));
        assert.equal(verify.body.code, '123456');
        assert.equal(await page.isVisible('#trKeys'), true);
        assert.equal(await page.isVisible('#trMfa'), false);
        assert.equal(await page.inputValue('#trTotp'), '');
    }, browser);

    await run('trade: a wrong 2FA code is rejected before sending (not 6 digits)', async page => {
        const calls = await tradeSetup(page, { session: fakeSession('aal1', VERIFIED) });
        await page.fill('#trTotp', '12ab');
        await page.click('#trMfaForm button[type="submit"]'); await page.waitForTimeout(300);
        assert.equal(calls.auth.filter(c => c.path.endsWith('/verify')).length, 0);
        assert.match(await page.textContent('#trAuthMsg'), /6 цифр/);
    }, browser);

    await run('trade: keys go to the server via ex_save once, the inputs are cleared and the secret never stays in the page', async page => {
        const calls = await tradeSetup(page, { conns: [] });
        assert.equal(await page.isVisible('#trKeys'), true);
        await page.fill('#trKey', 'AbCdEfGh12345678'); await page.fill('#trSecret', 'ZyXwVuTsRq9876543210');
        await page.click('#trKeyForm button[type="submit"]'); await page.waitForTimeout(700);
        assert.equal(calls.rpc.length, 1);
        assert.deepEqual(calls.rpc[0], { name: 'ex_save', body: { p_key: 'AbCdEfGh12345678', p_secret: 'ZyXwVuTsRq9876543210', p_exchange: 'bybit' } });
        assert.equal(await page.inputValue('#trKey'), ''); assert.equal(await page.inputValue('#trSecret'), '');
        assert.deepEqual(calls.exchange, [{ exchange: 'bybit', action: 'check' }]);         // одразу перевірка ключа, без ордерів
        const leaked = await page.evaluate(() => JSON.stringify(window.tradeState) + JSON.stringify(Object.entries(localStorage)) + document.body.innerText);
        assert.equal(leaked.includes('ZyXwVuTsRq9876543210'), false);
        assert.equal(leaked.includes('AbCdEfGh12345678'), false);
    }, browser);

    await run('trade: keys can only be saved with 2FA; empty fields send nothing', async page => {
        const calls = await tradeSetup(page, { conns: [] });
        await page.click('#trKeyForm button[type="submit"]'); await page.waitForTimeout(300);
        assert.equal(calls.rpc.length, 0);
        assert.match(await msg(page), /обидва ключі/);
    }, browser);

    await run('trade: deleting keys asks for confirmation and calls ex_delete only after it', async page => {
        const calls = await tradeSetup(page);
        page.once('dialog', d => d.dismiss());
        await page.click('#trKeyDel'); await page.waitForTimeout(300);
        assert.equal(calls.rpc.length, 0);
        page.once('dialog', d => d.accept());
        await page.click('#trKeyDel'); await page.waitForTimeout(500);
        assert.deepEqual(calls.rpc, [{ name: 'ex_delete', body: { p_exchange: 'bybit' } }]);
        assert.match(await page.textContent('#trBody'), /не збережено/);
    }, browser);

    await run('trade: a key that is not active (or cannot trade) gives no order form', async page => {
        const calls = await tradeSetup(page, { conns: [{ ...ACTIVE, status: 'invalid' }] });
        assert.equal(await page.locator('#trBuy').count(), 0);
        assert.match(await page.textContent('#trBody'), /не приймає збережені ключі/);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('trade: an order sends the exact body (with a link) once, shows the confirmation and is NOT retried on failure', async page => {
        const seen = [];
        const calls = await tradeSetup(page, { fn: b => (b.action === 'order' ? { status: 502, json: { error: 'ab not enough', code: 110007 } } : null) });
        acceptDialogs(page, seen);
        await page.fill('#trSym', 'ethusdt'); await page.fill('#trNotional', '150'); await page.fill('#trLev', '5');
        await page.click('#trBuy'); await page.waitForTimeout(500);
        const orders = calls.exchange.filter(b => b.action === 'order');
        assert.equal(orders.length, 1);                                                   // жодних автоповторів
        const { link, ...rest } = orders[0];
        assert.match(link, LINK_RE);
        assert.deepEqual(rest, { exchange: 'bybit', action: 'order', symbol: 'ETHUSDT', side: 'BUY', notional: 150, leverage: 5 });
        assert.match(seen[0], /Bybit Demo/i); assert.match(seen[0], /БЕЗ СТОПА/);
        assert.match(await msg(page), /Недостатньо коштів на демо-рахунку/);
        assert.equal(calls.exchange.filter(b => b.action === 'positions').length, 1);     // після помилки показуємо справжні позиції
    }, browser);

    await run('trade: cancelling the confirmation sends nothing', async page => {
        const calls = await tradeSetup(page);
        page.on('dialog', d => d.dismiss());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trSell'); await page.waitForTimeout(300);
        assert.equal(calls.exchange.length, 0);
        assert.match(await msg(page), /Скасовано/);
    }, browser);

    await run('trade: invalid input is rejected before anything is sent (size above the cap)', async page => {
        const calls = await tradeSetup(page);
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT'); await page.fill('#trNotional', '99999');
        await page.click('#trBuy'); await page.waitForTimeout(200);
        assert.match(await msg(page), /Сума ордера/);
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
        assert.match(await msg(page), /Виконано: купівля 0\.08 ETHUSDT за 1712\.3456/);
        assert.match(await page.textContent('#trBody'), /Закрити/);
        assert.ok(calls.exchange.every(b => b.exchange === 'bybit'));
    }, browser);

    await run('trade: closing a position sends only the pair after confirmation', async page => {
        const calls = await tradeSetup(page, {
            fn: b => (b.action === 'positions' ? { status: 200, json: { ok: true, positions: [{ symbol: 'ETHUSDT', amt: 0.08, entry: 1712.3, mark: 1713, pnl: 0.05, lev: 3 }] } }
                : b.action === 'close' ? { status: 200, json: { ok: true, closed: true, order: { price: 1714 } } } : null)
        });
        page.on('dialog', d => d.accept());
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        await page.click('[data-act="close"]'); await page.waitForTimeout(400);
        assert.deepEqual(calls.exchange.filter(b => b.action === 'close'), [{ exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' }]);
        assert.match(await msg(page), /Позицію закрито/);
    }, browser);

    await run('trade: server 403 «mfa required» shows the 2FA instruction', async page => {
        await tradeSetup(page, { fn: () => ({ status: 403, json: { error: 'mfa required' } }) });
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        assert.match(await msg(page), /Google Authenticator/);
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
        assert.match(await msg(page), /<b id="pwn">boom<\/b>/);
    }, browser);

    await run('trade: typed pair, sum and leverage survive «Позиції» and a validation error (no silent reset)', async page => {
        await tradeSetup(page);
        await page.fill('#trSym', 'ethusdt'); await page.fill('#trNotional', '150'); await page.fill('#trLev', '5');
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        assert.equal(await page.inputValue('#trSym'), 'ETHUSDT');
        assert.equal(await page.inputValue('#trNotional'), '150');
        assert.equal(await page.inputValue('#trLev'), '5');
        await page.fill('#trNotional', '99999');
        await page.click('#trBuy'); await page.waitForTimeout(200);
        assert.equal(await page.inputValue('#trSym'), 'ETHUSDT');
        assert.equal(await page.inputValue('#trNotional'), '99999');
    }, browser);

    await run('trade: a blocked pair gets no order and no close button, and the list persists', async page => {
        const seen = [];
        const calls = await tradeSetup(page, {
            fn: b => (b.action === 'positions' ? { status: 200, json: { ok: true, positions: [{ symbol: 'BTCUSDT', amt: 0.1, entry: 60000, mark: 60100, pnl: 10, lev: 3 }] } } : null)
        });
        acceptDialogs(page, seen);
        await page.fill('#trBlock', 'btc/usdt, SOLUSDT');
        await page.fill('#trSym', 'BTCUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(300);
        assert.match(await msg(page), /заблоковано/);
        assert.equal(seen.length, 0);                                                     // підтвердження навіть не показували
        await page.click('[data-act="positions"]'); await page.waitForTimeout(300);
        assert.match(await page.textContent('#trBody'), /заблоковано вами/);
        assert.equal(await page.locator('[data-act="close"]').count(), 0);
        assert.equal(calls.exchange.filter(b => b.action === 'order' || b.action === 'close').length, 0);
        assert.equal(await page.evaluate(() => localStorage.getItem('cs_trade_block_v1')), 'btc/usdt, SOLUSDT');
    }, browser);

    await run('trade: a timeout is an UNKNOWN outcome: the order is sent once and its fate is read by link, never re-sent', async page => {
        const calls = await tradeSetup(page, { fn: b => (b.action === 'order' ? { status: 200, json: { ok: true }, delay: 1500 } : null) });
        page.on('dialog', d => d.accept());
        await page.evaluate(() => { window.tradeState.timeoutMs = 200; });
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(900);
        const orders = calls.exchange.filter(b => b.action === 'order'), lookups = calls.exchange.filter(b => b.action === 'status');
        assert.equal(orders.length, 1);
        assert.equal(lookups.length, 1);
        assert.deepEqual([lookups[0].symbol, lookups[0].link], [orders[0].symbol, orders[0].link]);   // той самий ідентифікатор
        assert.match(await msg(page), /Біржа поки не бачить цього ордера/);
        assert.equal(calls.exchange.filter(b => b.action === 'positions').length, 1);
    }, browser);

    await run('trade: when the exchange confirms the order by link after a lost reply, the user is told it was executed', async page => {
        const calls = await tradeSetup(page, {
            fn: b => (b.action === 'order' ? { abort: true }
                : b.action === 'status' ? { status: 200, json: { ok: true, order: { symbol: 'ETHUSDT', side: 'BUY', qty: 0.08, price: 1712.3, status: 'Filled' } } } : null)
        });
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(700);
        assert.match(await msg(page), /біржа підтвердила: ордер виконано — купівля 0\.08 ETHUSDT/);
        assert.equal(calls.exchange.filter(b => b.action === 'order').length, 1);
    }, browser);

    await run('trade: if nothing can be read after a lost reply the user is told to check the exchange manually', async page => {
        const calls = await tradeSetup(page, { fn: b => (b.action === 'order' ? { abort: true } : { status: 502, raw: '<html>Bad gateway</html>' }) });
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(700);
        const text = await msg(page);
        assert.match(text, /Результат невідомий/);
        assert.match(text, /вручну/);
        assert.doesNotMatch(text, /не виконала/);
        assert.equal(calls.exchange.filter(b => b.action === 'order').length, 1);
    }, browser);

    await run('trade: a 200 reply that carries an error is shown as an error, not as a fill', async page => {
        await tradeSetup(page, { fn: b => (b.action === 'order' ? { status: 200, json: { error: 'order too small: min 5.00 USDT' } } : null) });
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(400);
        assert.doesNotMatch(await msg(page), /Виконано/);
        assert.match(await msg(page), /мінімум 5\.00 USDT/);
    }, browser);

    await run('trade: after a refusal the exchange is asked by link; if it shows the order the user is told so', async page => {
        const calls = await tradeSetup(page, {
            fn: b => (b.action === 'order' ? { status: 502, json: { error: 'exchange request failed' } }
                : b.action === 'status' ? { status: 200, json: { ok: true, order: { symbol: 'ETHUSDT', side: 'BUY', qty: 0.08, price: 1712.3 } } } : null)
        });
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(500);
        assert.match(await msg(page), /біржа показує ордер/);
        assert.equal(calls.exchange.filter(b => b.action === 'order').length, 1);
    }, browser);

    await run('trade: the 2FA secret is not kept in state and the QR is cleared after verification', async page => {
        await tradeSetup(page, { session: fakeSession('aal1', []), conns: [] });
        await page.click('#trMfaStart'); await page.waitForTimeout(400);
        assert.equal((await page.evaluate(() => JSON.stringify(window.tradeState))).includes('JBSWY3DPEHPK3PXP'), false);
        await page.fill('#trTotp', '123456');
        await page.click('#trMfaForm button[type="submit"]'); await page.waitForTimeout(500);
        assert.equal(await page.textContent('#trSecretTxt'), '');
        assert.equal(await page.getAttribute('#trQr', 'src'), null);
    }, browser);

    await run('trade: the function\'s own JSON error is a definite refusal', async page => {
        await tradeSetup(page, { fn: b => (b.action === 'order' ? { status: 502, json: { error: 'order too small: min 5.00 USDT' } } : null) });
        page.on('dialog', d => d.accept());
        await page.fill('#trSym', 'ETHUSDT');
        await page.click('#trBuy'); await page.waitForTimeout(400);
        assert.match(await msg(page), /Біржа ордер не виконала/);
        assert.match(await msg(page), /мінімум 5\.00 USDT/);
    }, browser);

    await run('trade: the 🛒 button on a formation only prefills the pair and never sends an order', async page => {
        const calls = await tradeSetup(page);
        await page.evaluate(() => window.openTrade({ symbol: 'SOLUSDT', side: 'short' }));
        await page.waitForTimeout(500);
        assert.equal(await page.inputValue('#trSym'), 'SOLUSDT');
        assert.match(await page.textContent('#trBody'), /Сигнал: SOLUSDT SHORT/);
        assert.equal(calls.exchange.length, 0);
    }, browser);

    await run('trade: sign-out calls the auth server and returns to the login form', async page => {
        const calls = await tradeSetup(page);
        await page.click('#trSignOut'); await page.waitForTimeout(500);
        assert.ok(calls.auth.some(c => c.path === '/auth/v1/logout'));
        assert.equal(await page.isVisible('#trLogin'), true);
        assert.equal(await page.locator('#trBuy').count(), 0);
    }, browser);

    await run('exchange sources: each button reads only its own file, and switching stops polling the previous one', async page => {
        const hits = await okxSetup(page);
        for (const ex of ['bitget', 'gate', 'mexc']) {
            await page.click(`#lvSource [data-src="${ex}"]`); await page.waitForTimeout(350);
            assert.equal(hits.by[ex], 1, ex);
            assert.equal(await page.locator('#lvBody tr[data-sym]').count(), 3, ex);
            assert.match(await page.textContent('#lvTitle'), new RegExp(ex, 'i'));
            assert.equal(await page.textContent('#lvStatus'), 'Наживо');
            assert.equal(/UTC\+8/.test(await page.textContent('#lvNote')), ex === 'mexc', ex);      // попередження лише для MEXC
        }
        assert.equal(hits.by.okx, undefined);                                   // OKX не чіпали
        await page.waitForTimeout(200);
        assert.deepEqual(Object.keys(hits.by).sort(), ['bitget', 'gate', 'mexc']);
        assert.equal(await page.getAttribute('#lvSource [data-src="mexc"]', 'aria-pressed'), 'true');
        assert.equal(await page.getAttribute('#lvSource [data-src="gate"]', 'aria-pressed'), 'false');
    }, browser);

    await run('exchange sources: the chosen source is remembered after reload', async page => {
        await okxSetup(page);
        await page.click('#lvSource [data-src="gate"]'); await page.waitForTimeout(300);
        await page.reload(); await page.waitForTimeout(600);
        assert.match(await page.textContent('#lvTitle'), /Gate/);
        assert.equal(await page.locator('#lvBody tr[data-sym]').count(), 3);
    }, browser);

    // --- вкладка «Порівняння»: Binance наживо (підроблений потік) + знімки чотирьох бірж (підроблені) ---
    const cmpSnap = (ex, price, { ageMs = 60000, extra = [] } = {}) => ({
        ts: Date.now() - ageMs, ex,
        coins: [
            { s: 'BTCUSDT', last: price, chg24h: 1.5, volUsd: 5e9, oiUsd: 1e9, fund: ex === 'gate' ? -0.0002 : 0.0001 },
            { s: 'SOLUSDT', last: 150, chg24h: 2, volUsd: 1e9, oiUsd: 1e8, fund: 0.0001 },
            ...extra
        ],
        walls: { BTCUSDT: { mid: price, bids: [], asks: [{ px: price * 1.001, usd: 750000, dist: 0.1 }] } }
    });
    async function cmpSetup(page, { snaps = {}, failEx = [] } = {}) {
        const hits = { n: 0, by: {} };
        await liveSetup(page);
        const prices = { okx: 100.5, bitget: 99.5, gate: 100.2, mexc: 100.0 };
        await page.route('**/raw.githubusercontent.com/**', route => {
            const ex = (new URL(route.request().url()).pathname.match(/\/data\/([a-z]+)\/latest\.json$/) || [])[1];
            hits.n++; hits.by[ex] = (hits.by[ex] || 0) + 1;
            const body = snaps[ex] || cmpSnap(ex, prices[ex]);
            const status = failEx.includes(ex) ? 404 : 200;
            return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.evaluate(() => window.openTab('cmp', document.getElementById('nav-cmp')));
        await page.waitForTimeout(700);
        return hits;
    }
    const cmpRow = (page, ex) => page.$eval(`#cmBody tr[data-ex="${ex}"]`, tr => tr.textContent.replace(/\s+/g, ' '));

    await run('compare: one coin on five exchanges, deviations from the median, spread and funding spread', async page => {
        await cmpSetup(page);
        assert.equal(await page.locator('#cmBody tr').count(), 5);
        assert.match(await cmpRow(page, 'okx'), /\$100\.5/);
        assert.match(await cmpRow(page, 'bitget'), /\$99\.5/);
        assert.match(await cmpRow(page, 'bitget'), /-0\.\d\d%/);                         // нижче медіани
        assert.match(await cmpRow(page, 'okx'), /\+0\.\d\d%/);                           // вище медіани
        assert.match(await cmpRow(page, 'gate'), /-0\.0200%/);                           // фандинг Gate
        assert.match(await cmpRow(page, 'okx'), /\$750K|\$750\.0K|750/);                  // стіна
        assert.match(await page.textContent('#cmSummary'), /Розкид цін/);
        assert.match(await page.textContent('#cmSummary'), /Різниця фандингу/);
        assert.match(await cmpRow(page, 'binance'), /наживо/);
        assert.equal(await page.textContent('#cmCount'), '5 з 5 бірж зі свіжими даними');
    }, browser);

    await run('compare: another coin by short name; a coin outside Binance top-40 or missing on an exchange is explained', async page => {
        await cmpSetup(page, { snaps: { mexc: cmpSnap('mexc', 100, { extra: [] }) } });
        await page.fill('#cmSym', 'sol');
        await page.click('#cmForm button[type="submit"]'); await page.waitForTimeout(200);
        assert.equal(await page.inputValue('#cmSym'), 'SOLUSDT');
        assert.match(await cmpRow(page, 'binance'), /немає серед топ-40/);
        assert.match(await cmpRow(page, 'okx'), /\$150/);
        await page.fill('#cmSym', 'NOPEUSDT');
        await page.click('#cmForm button[type="submit"]'); await page.waitForTimeout(200);
        assert.match(await cmpRow(page, 'okx'), /монети немає на цій біржі/);
        assert.match(await page.textContent('#cmSummary'), /хоча б із двох бірж/);
    }, browser);

    await run('compare: a stale snapshot is shown with its age but is left out of the median and the spread', async page => {
        await cmpSetup(page, { snaps: { gate: cmpSnap('gate', 120, { ageMs: 40 * 60000 }) } });
        const gate = await cmpRow(page, 'gate');
        assert.match(gate, /застарілі/);
        assert.match(gate, /\$120/);
        assert.doesNotMatch(await page.textContent('#cmSummary'), /GATE/i);                  // 120 не потрапило ні в розкид, ні в різницю фандингу
        assert.equal(await page.textContent('#cmCount'), '4 з 5 бірж зі свіжими даними');
    }, browser);

    await run('compare: an exchange whose file cannot be loaded shows its error while the others still work', async page => {
        await cmpSetup(page, { failEx: ['mexc'] });
        assert.match(await cmpRow(page, 'mexc'), /HTTP 404/);
        assert.match(await cmpRow(page, 'okx'), /\$100\.5/);
        assert.equal(await page.textContent('#cmCount'), '4 з 5 бірж зі свіжими даними');
    }, browser);

    await run('compare: the chosen coin is remembered and nothing is requested until the tab is opened', async page => {
        await liveSetup(page);
        let n = 0;
        await page.route('**/raw.githubusercontent.com/**', route => { n++; return route.fulfill({ status: 404, body: '' }); });
        await page.waitForTimeout(400);
        assert.equal(n, 0);
        await page.evaluate(() => window.openTab('cmp', document.getElementById('nav-cmp')));
        await page.fill('#cmSym', 'eth'); await page.click('#cmForm button[type="submit"]');
        await page.reload(); await page.waitForTimeout(500);
        assert.equal(await page.inputValue('#cmSym'), 'ETHUSDT');
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
