const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const pngSize = f => { const b = fs.readFileSync(path.join(root, f)); assert.equal(b.subarray(1, 4).toString(), 'PNG', f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('the manifest is valid and every icon it names exists with the declared size', () => {
    const m = JSON.parse(read('manifest.webmanifest'));
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, './');                                     // працює з піддиректорії GitHub Pages
    assert.equal(m.scope, './');
    assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
    for (const icon of m.icons) {
        assert.ok(fs.existsSync(path.join(root, icon.src)), icon.src);
        if (icon.type === 'image/png') assert.deepEqual(pngSize(icon.src), icon.sizes.split('x').map(Number), icon.src);
    }
    assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512'));   // мінімум для встановлення на Android
});

test('index.html links the manifest and icons that exist, and has a current title', () => {
    const html = read('index.html');
    for (const rel of ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'apple-touch-icon.png']) {
        assert.ok(html.includes(`href="${rel}"`), rel);
        assert.ok(fs.existsSync(path.join(root, rel)), rel);
    }
    assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180]);
    assert.match(html, /<title>CryptoScreener — скринер криптовалют<\/title>/);
    assert.doesNotMatch(html, /<title>[^<]*Veles DCA Simulator/);
});

test('README starts with the online address of the site', () => {
    assert.match(read('README.md'), /\*\*Онлайн:\*\* https:\/\/koloss10\.github\.io\/cryptoscreener\//);
});
