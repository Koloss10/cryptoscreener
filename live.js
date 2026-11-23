// Вкладка «Скринер»: таблиця метрик Binance Futures наживо. Дані — feed.js, розрахунки — metrics.js.
(function () {
    'use strict';

    const STORE_KEY = 'cs_live_v1';
    const HOT = { natr5: 2, spike: 3 };            // підсвітка за замовчуванням: NATR ≥ 2%, сплеск обсягу ≥ ×3
    const STATUS_TEXT = { connecting: 'Підключення…', live: 'Наживо', reconnecting: 'Перепідключення…', error: 'Помилка' };
    const COLUMNS = [
        { key: 'symbol', label: 'Монета' },
        { key: 'price', label: 'Ціна', fmt: v => '$' + window.fmt(v) },
        { key: 'chg24', label: '24г', fmt: pct, tone: true },
        { key: 'chg5', label: '5хв', fmt: pct, tone: true },
        { key: 'chg15', label: '15хв', fmt: pct, tone: true },
        { key: 'chg60', label: '1г', fmt: pct, tone: true },
        { key: 'vol1h', label: 'Обсяг 1г', fmt: usd },
        { key: 'spike', label: 'Сплеск', fmt: v => '×' + v.toFixed(1), hot: HOT.spike },
        { key: 'natr5', label: 'NATR 5m', fmt: v => v.toFixed(2) + '%', hot: HOT.natr5 },
        { key: 'funding', label: 'Фандинг', fmt: v => (v * 100).toFixed(4) + '%', tone: true },
        { key: 'vol24', label: 'Обсяг 24г', fmt: usd }
    ];

    const state = { rows: [], sortKey: 'vol1h', sortDir: 'desc', filters: { minVol1h: 0, minNatr: 0, minSpike: 0, search: '' }, status: 'connecting' };

    function pct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
    function usd(v) { return '$' + window.fmtK(v); }
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (saved && typeof saved === 'object') {
                Object.assign(state.filters, saved.filters || {});
                if (COLUMNS.some(c => c.key === saved.sortKey)) state.sortKey = saved.sortKey;
                if (saved.sortDir === 'asc' || saved.sortDir === 'desc') state.sortDir = saved.sortDir;
            }
        } catch (e) { /* сховище недоступне або пошкоджене — працюємо зі значеннями за замовчуванням */ }
    }
    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ filters: state.filters, sortKey: state.sortKey, sortDir: state.sortDir })); }
        catch (e) { /* приватний режим: налаштування не збережуться, це не критично */ }
    }

    function cell(col, row) {
        const v = row[col.key];
        if (v === null || v === undefined) return '<td class="lv-mu">—</td>';
        if (col.key === 'symbol') return `<td>${esc(v.replace(/USDT$/, ''))}<span class="lv-mu"> /USDT</span></td>`;
        const hot = col.hot && v >= col.hot ? ' lv-hot' : '';
        const tone = col.tone ? (v > 0 ? ' lv-up' : v < 0 ? ' lv-dn' : '') : '';
        return `<td><span class="${(hot + tone).trim()}">${esc(col.fmt(v))}</span></td>`;
    }

    function render() {
        const view = document.getElementById('view-live');
        if (!view || view.classList.contains('hidden')) return;     // у фоні не перемальовуємо
        const rows = window.Metrics.sortRows(window.Metrics.filterRows(state.rows, state.filters), state.sortKey, state.sortDir);

        document.getElementById('lvHead').innerHTML = '<tr>' + COLUMNS.map(c =>
            `<th data-k="${c.key}" ${c.key === state.sortKey ? `aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}${c.key === state.sortKey ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';

        const body = document.getElementById('lvBody');
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="lv-empty">${state.rows.length ? 'Жодна монета не пройшла фільтри.' : 'Очікуємо дані…'}</td></tr>`;
        } else {
            body.innerHTML = rows.map(r => `<tr data-sym="${esc(r.symbol)}" tabindex="0">${COLUMNS.map(c => cell(c, r)).join('')}</tr>`).join('');
        }
        const chip = document.getElementById('lvStatus');
        chip.textContent = STATUS_TEXT[state.status] || state.status;
        chip.dataset.s = state.status;
        document.getElementById('lvCount').textContent = `${rows.length} з ${state.rows.length} монет`;
    }

    function openSymbol(sym) {
        const sel = document.getElementById('coinSelect');
        if (![...sel.options].some(o => o.value === sym)) sel.add(new Option(sym.replace('USDT', ' / USDT'), sym));
        window.changeSymbol(sym);
        window.openTab('terminal', document.getElementById('nav-terminal'));
    }

    function bind() {
        document.getElementById('lvHead').addEventListener('click', e => {
            const th = e.target.closest('th[data-k]');
            if (!th) return;
            const key = th.dataset.k;
            state.sortDir = key === state.sortKey ? (state.sortDir === 'desc' ? 'asc' : 'desc') : (key === 'symbol' ? 'asc' : 'desc');
            state.sortKey = key;
            save(); render();
        });
        const body = document.getElementById('lvBody');
        body.addEventListener('click', e => { const tr = e.target.closest('tr[data-sym]'); if (tr) openSymbol(tr.dataset.sym); });
        body.addEventListener('keydown', e => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-sym]'); if (tr) openSymbol(tr.dataset.sym); } });

        const fields = { lvMinVol: ['minVol1h', 1e6], lvMinNatr: ['minNatr', 1], lvMinSpike: ['minSpike', 1], lvSearch: ['search', null] };
        for (const [id, [key, mult]] of Object.entries(fields)) {
            const el = document.getElementById(id);
            el.value = mult === null ? state.filters[key] : (state.filters[key] / mult || '');
            el.addEventListener('input', () => {
                state.filters[key] = mult === null ? el.value : Math.max(0, parseFloat(el.value) || 0) * mult;
                save(); render();
            });
        }
    }

    function start() {
        load();
        bind();
        const feed = window.Feed.createFeed({
            Metrics: window.Metrics,
            fetchImpl: (u, o) => fetch(u, o),
            WebSocketImpl: window.WebSocket,
            now: () => Date.now(),
            onRows: rows => { state.rows = rows; render(); },
            onStatus: s => { state.status = s; render(); }
        });
        window.liveFeed = feed;
        window.renderLive = render;      // викликається при відкритті вкладки
        feed.start();
        render();
    }

    window.addEventListener('DOMContentLoaded', start);
})();
