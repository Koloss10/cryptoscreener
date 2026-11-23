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
        await page.route('**/api/v3/**', async route => {
            const u = new URL(route.request().url());
            if (u.pathname.endsWith('/klines')) { klineCalls++; await new Promise(r => setTimeout(r, 500)); }
            await route.abort();
        });
        await page.goto(PAGE); await page.waitForTimeout(100);
        const before = klineCalls;
        await page.evaluate(() => { window.loadMainData(); window.loadMainData(); });
        await page.waitForTimeout(100);
        assert.equal(klineCalls, before);   // обидва виклики пропущено: запит для цієї пари вже летить
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
    async function liveSetup(page) {
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
            const body = u.pathname.endsWith('/ticker/24hr')
                ? [tk('BTCUSDT', 9e9), tk('ETHUSDT', 5e9), tk('1000PEPEUSDT', 1e9), tk('SOLUSDT_250101', 9e10)]
                : fk(u.searchParams.get('symbol') === 'ETHUSDT' ? 9000 : 1000);
            return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        });
        await page.route('**/api/v3/**', r => r.abort());
        await page.goto(PAGE); await page.waitForTimeout(500);
        await page.evaluate(() => { window.__sockets[0].onopen(); window.liveFeed.tick(); });
    }

    await run('live tab is the default and renders metrics from feed data', async page => {
        await liveSetup(page);
        assert.equal(await page.$eval('#view-live', e => e.classList.contains('hidden')), false);
        assert.equal(await page.$eval('#view-terminal', e => e.classList.contains('hidden')), true);
        assert.equal((await page.$$('#lvBody tr[data-sym]')).length, 3);                 // без SOLUSDT_250101
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
        assert.equal(await bundle.evaluate(() => document.querySelectorAll('script[src]').length), 1); // лише tv.js
        await bundle.close();
        fs.unlinkSync(out);
    }, browser);
    server.close();

    await browser.close();
})();
