// Вкладка «Плотності» і шар плотностей на графіку. Дані — density-feed.js (книги ордерів Binance Futures).
(function () {
    'use strict';

    const STORE_KEY = 'cs_dens_v1';
    const UNIVERSE = 30;                       // скільки найліквідніших монет опитуємо
    const STATUS_TEXT = { idle: 'Очікування', live: 'Наживо', limited: 'Ліміт Binance: пауза', error: 'Помилка' };
    const state = { sortKey: 'usd', sortDir: 'desc', minUsd: 200000, maxDist: 2, status: 'idle', detail: '' };
    const COLUMNS = [
        { key: 'symbol', label: 'Монета' },
        { key: 'side', label: 'Бік' },
        { key: 'price', label: 'Ціна', fmt: v => '$' + window.fmt(v) },
        { key: 'usd', label: 'Розмір', fmt: v => '$' + window.fmtK(v) },
        { key: 'ratio', label: 'До норми', fmt: v => '×' + v.toFixed(0) },
        { key: 'distPct', label: 'Відстань', fmt: v => v.toFixed(2) + '%' },
        { key: 'eatMin', label: 'Розїдання', fmt: v => (v < 1 ? '<1' : v < 100 ? v.toFixed(0) : '99+') + ' хв' },
        { key: 'ageMs', label: 'Стоїть', fmt: v => (v < 60000 ? Math.round(v / 1000) + ' с' : Math.round(v / 60000) + ' хв') },
        { key: 'depth', label: 'Глибина книги' }
    ];
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const visible = id => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden'); };

    function load() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (s && typeof s === 'object') {
                if (COLUMNS.some(c => c.key === s.sortKey)) state.sortKey = s.sortKey;
                if (s.sortDir === 'asc' || s.sortDir === 'desc') state.sortDir = s.sortDir;
                if (Number.isFinite(s.minUsd) && s.minUsd >= 0) state.minUsd = s.minUsd;
                if (Number.isFinite(s.maxDist) && s.maxDist > 0) state.maxDist = s.maxDist;
            }
        } catch (e) { /* сховище недоступне — лишаються значення за замовчуванням */ }
    }
    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ sortKey: state.sortKey, sortDir: state.sortDir, minUsd: state.minUsd, maxDist: state.maxDist })); }
        catch (e) { /* приватний режим: налаштування не збережуться */ }
    }

    function sortValue(w, key) {
        if (key === 'depth') return w.coverage ? Math.min(w.coverage.bidPct, w.coverage.askPct) : null;
        return w[key];
    }

    function rows() {
        const list = window.densFeed.getAll().filter(w => w.usd >= state.minUsd && w.distPct <= state.maxDist);
        const sign = state.sortDir === 'asc' ? 1 : -1;
        return list.sort((a, b) => {
            const av = sortValue(a, state.sortKey), bv = sortValue(b, state.sortKey);
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            return typeof av === 'string' ? sign * av.localeCompare(bv) : sign * (av - bv);
        });
    }

    function cell(col, w) {
        if (col.key === 'symbol') return `<td>${esc(w.symbol.replace(/USDT$/, ''))}<span class="lv-mu"> /USDT</span></td>`;
        if (col.key === 'side') return `<td class="${w.side === 'bid' ? 'lv-up' : 'lv-dn'}">${w.side === 'bid' ? 'ПОКУПЦІ ▲' : 'ПРОДАВЦІ ▼'}</td>`;
        if (col.key === 'depth') return w.coverage ? `<td class="lv-mu">±${Math.min(w.coverage.bidPct, w.coverage.askPct).toFixed(2)}%</td>` : '<td class="lv-mu">—</td>';
        const v = w[col.key];
        return v === null || v === undefined ? '<td class="lv-mu">—</td>' : `<td>${esc(col.fmt(v))}</td>`;
    }

    function render() {
        if (!visible('view-dens')) return;
        const list = rows();
        document.getElementById('dsHead').innerHTML = '<tr>' + COLUMNS.map(c =>
            `<th data-k="${c.key}" ${c.key === state.sortKey ? `aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}${c.key === state.sortKey ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
        const body = document.getElementById('dsBody');
        const hasAny = window.densFeed.getAll().length > 0;
        body.innerHTML = list.length
            ? list.map(w => `<tr data-sym="${esc(w.symbol)}" tabindex="0">${COLUMNS.map(c => cell(c, w)).join('')}</tr>`).join('')
            : `<tr><td colspan="${COLUMNS.length}" class="lv-empty">${hasAny ? 'Жодна плотність не пройшла фільтри.' : (state.status === 'live' ? 'Збираємо книги ордерів: монети опитуються по черзі (≈ 1 за 2.5 с)…' : 'Очікуємо дані…')}</td></tr>`;
        const chip = document.getElementById('dsStatus');
        chip.textContent = STATUS_TEXT[state.status] || state.status;
        chip.dataset.s = state.status === 'idle' ? 'connecting' : state.status === 'limited' ? 'reconnecting' : state.status;
        const detail = document.getElementById('dsDetail');
        detail.hidden = !(state.detail && state.status !== 'live');
        detail.textContent = detail.hidden ? '' : `Binance Futures: ${state.detail}. Спробуємо знову автоматично.`;
        document.getElementById('dsCount').textContent = `${list.length} плотностей`;
    }

    function bind() {
        document.getElementById('dsHead').addEventListener('click', e => {
            const th = e.target.closest('th[data-k]');
            if (!th) return;
            state.sortDir = th.dataset.k === state.sortKey ? (state.sortDir === 'desc' ? 'asc' : 'desc') : (th.dataset.k === 'symbol' ? 'asc' : 'desc');
            state.sortKey = th.dataset.k;
            save(); render();
        });
        const body = document.getElementById('dsBody');
        body.addEventListener('click', e => { const tr = e.target.closest('tr[data-sym]'); if (tr) window.openFuturesChart(tr.dataset.sym); });
        body.addEventListener('keydown', e => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-sym]'); if (tr) window.openFuturesChart(tr.dataset.sym); } });
        const usd = document.getElementById('dsMinUsd'), dist = document.getElementById('dsMaxDist');
        usd.value = state.minUsd / 1000; dist.value = state.maxDist;
        usd.addEventListener('input', () => { state.minUsd = Math.max(0, parseFloat(usd.value) || 0) * 1000; save(); render(); });
        dist.addEventListener('input', () => { state.maxDist = Math.max(0.01, parseFloat(dist.value) || 5); save(); render(); });
    }

    function start() {
        load();
        bind();
        window.densFeed = window.DensityFeed.createDensityFeed({
            Density: window.Density,
            fetchImpl: (u, o) => fetch(u, o),
            now: () => Date.now(),
            // ті самі найліквідніші крипто-монети, що в скрінері; метрики обсягу — для «розїдання»
            getSymbols: () => (window.liveFeed ? window.liveFeed.getRows() : [])
                .filter(r => r.vol24 !== null).sort((a, b) => b.vol24 - a.vol24).slice(0, UNIVERSE)
                .map(r => ({ symbol: r.symbol, vol1h: r.vol1h, vol24: r.vol24 })),
            getPriority: () => (visible('view-terminal') && window.app ? window.app.sym : null),
            isActive: () => !document.hidden && (visible('view-dens') || visible('view-terminal') || visible('view-form')),
            onUpdate: () => { render(); if (visible('view-terminal') && window.app.layers.dens) window.drawChart(); },
            onStatus: (s, detail) => { state.status = s; state.detail = detail || ''; render(); },
            opts: { minUsd: 100000, minRatio: 8, maxDistPct: 5, perSide: 3 }
        });
        window.renderDens = render;
        window.densFeed.start();
        render();
    }

    window.addEventListener('DOMContentLoaded', start);
})();
