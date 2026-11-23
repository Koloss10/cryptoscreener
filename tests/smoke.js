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
