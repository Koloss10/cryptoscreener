// Вкладка «Порівняння»: одна монета на Binance (наживо) і чотирьох біржах-знімках (OKX, Bitget, Gate, MEXC).
// Логіка — compare-core.js; знімки — okx-source.js. Опитування лише поки вкладка відкрита.
(function () {
    'use strict';

    const STORE_KEY = 'cs_compare_v1';
    const EXCHANGES = ['okx', 'bitget', 'gate', 'mexc'];
    const NAMES = { binance: 'Binance', okx: 'OKX', bitget: 'Bitget', gate: 'Gate', mexc: 'MEXC' };
    const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;

    const state = { symbol: 'BTCUSDT', slots: {} };
    let feeds = [];
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const $ = id => document.getElementById(id);
    const visible = () => { const el = $('view-cmp'); return !!el && !el.classList.contains('hidden'); };
    const usd = v => (v === null || v === undefined ? '—' : '$' + window.fmtK(v));
    const pct = (v, d = 2) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');
    const tone = v => (v > 0 ? 'lv-up' : v < 0 ? 'lv-dn' : '');

    function load() {
        try { const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); if (s && SYMBOL_RE.test(s.symbol)) state.symbol = s.symbol; }
        catch (e) { /* сховище недоступне — лишаємо значення за замовчуванням */ }
    }
    function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ symbol: state.symbol })); } catch (e) { /* приватний режим — не критично */ } }

    // Джерела для compare-core: Binance — із живого потоку скринера (лише топ-40 за обсягом), решта — знімки
    function sources() {
        const list = [{ ex: 'binance', name: NAMES.binance, rows: window.liveFeed ? window.liveFeed.getRows() : null, ageMs: 0, error: '' }];
        for (const ex of EXCHANGES) {
            const s = state.slots[ex] || {};
            // вік рахуємо при кожному малюванні: якщо оновлення збоїть, знімок чесно «старіє» на екрані
            list.push({ ex, name: NAMES[ex], rows: s.rows || null, ageMs: s.at === undefined ? null : Date.now() - s.at, error: s.error || '' });
        }
        return list;
    }

    function itemCells(i) {
        if (!i.loaded) return `<td colspan="8" class="lv-mu">${i.error ? esc(i.error) : 'Завантаження…'}</td>`;
        if (!i.row) return `<td colspan="8" class="lv-mu">${i.ex === 'binance' ? 'немає серед топ-40 за обсягом (Binance Futures)' : 'монети немає на цій біржі'}</td>`;
        const r = i.row;
        const age = i.ex === 'binance' ? 'наживо' : `${Math.max(0, Math.round(i.ageMs / 60000))} хв${i.stale ? ' (застарілі)' : ''}`;
        const fund = r.funding === null || r.funding === undefined ? '—' : (r.funding * 100).toFixed(4) + '%';
        const wall = r.wallUsd === null || r.wallUsd === undefined ? '—' : usd(r.wallUsd) + ' (' + pct(r.wallDist) + ')';
        return `<td>$${esc(window.fmt(r.price))}</td><td><span class="${tone(i.dev)}">${i.dev === null ? '—' : esc(pct(i.dev))}</span></td>`
            + `<td><span class="${tone(r.chg24)}">${esc(pct(r.chg24))}</span></td><td>${esc(usd(r.vol24))}</td><td>${esc(usd(r.oi))}</td>`
            + `<td><span class="${tone(r.funding)}">${esc(fund)}</span></td><td>${esc(wall)}</td><td class="lv-mu">${esc(age)}</td>`;
    }

    function render() {
        if (!visible()) return;
        const srcs = sources();
        const c = window.CompareCore.compare(state.symbol, srcs);
        $('cmBody').innerHTML = c.items.map(i => `<tr data-ex="${esc(i.ex)}"><td>${esc(i.name)}</td>${itemCells(i)}</tr>`).join('');
        const sum = [];
        if (c.priceSpread) sum.push(`Розкид цін: <b>${esc(c.priceSpread.pct.toFixed(2))}%</b> (найдешевше — ${esc(c.priceSpread.lo)}, найдорожче — ${esc(c.priceSpread.hi)}).`);
        if (c.fundingSpread) sum.push(`Різниця фандингу: <b>${esc((c.fundingSpread.diff * 100).toFixed(4))}%</b> (${esc(c.fundingSpread.lo)} → ${esc(c.fundingSpread.hi)}).`);
        if (!sum.length && c.freshCount < 2) sum.push('Щоб порахувати розкид, потрібні свіжі дані хоча б із двох бірж.');
        $('cmSummary').innerHTML = sum.join(' ');
        $('cmSyms').innerHTML = window.CompareCore.commonSymbols(srcs).map(s => `<option value="${esc(s)}"></option>`).join('');
        $('cmCount').textContent = `${c.freshCount} з ${srcs.length} бірж зі свіжими даними`;
    }

    function setSymbol(raw) {
        const s = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const sym = s && !s.endsWith('USDT') ? s + 'USDT' : s;
        if (!SYMBOL_RE.test(sym)) { $('cmMsg').textContent = 'Введіть монету, наприклад BTC або BTCUSDT.'; return; }
        $('cmMsg').textContent = '';
        state.symbol = sym; $('cmSym').value = sym; save(); render();
    }

    function stop() { feeds.forEach(f => f.stop()); feeds = []; }
    function start() {
        stop();
        feeds = EXCHANGES.map(ex => {
            state.slots[ex] = state.slots[ex] || {};
            const feed = window.OkxSource.createExchangeFeed({
                ex, fetchImpl: (u, o) => fetch(u, o), now: () => Date.now(),
                onRows: (rows, ageMs) => { Object.assign(state.slots[ex], { rows, at: Date.now() - ageMs, error: '' }); render(); },
                onStatus: (s, detail) => { if (s === 'error') { state.slots[ex].error = detail; render(); } }
            });
            feed.start();
            return feed;
        });
    }

    window.renderCompare = function () { start(); render(); };      // викликається при відкритті вкладки
    window.leaveCompare = stop;                                      // і при виході з неї
    window.addEventListener('DOMContentLoaded', () => {
        load();
        $('cmSym').value = state.symbol;
        $('cmForm').addEventListener('submit', e => { e.preventDefault(); setSymbol($('cmSym').value); });
    });
})();
