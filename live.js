// Вкладка «Скринер»: таблиця метрик Binance Futures наживо (feed.js, metrics.js) або знімок OKX / Bitget / Gate / MEXC зі збирача (okx-source.js).
(function () {
    'use strict';

    const STORE_KEY = 'cs_live_v1';
    // Підсвітка за замовчуванням (до першого збереження власних правил): NATR ≥ 2%, сплеск обсягу ≥ ×3
    const DEFAULT_RULES = [{ key: 'natr5', op: '>=', value: 2 }, { key: 'spike', op: '>=', value: 3 }];
    // Одиниці колонок для правил: 1 одиниця в полі = unit «сирих» (фандинг зберігається часткою, обсяги — в доларах)
    const UNITS = {
        price: { unit: 1, hint: '$' }, chg24: { unit: 1, hint: '%' }, chg5: { unit: 1, hint: '%' }, chg15: { unit: 1, hint: '%' }, chg60: { unit: 1, hint: '%' },
        vol1h: { unit: 1e6, hint: 'млн $' }, vol24: { unit: 1e6, hint: 'млн $' }, oi: { unit: 1e6, hint: 'млн $' }, wallUsd: { unit: 1e6, hint: 'млн $' },
        spike: { unit: 1, hint: '×' }, natr5: { unit: 1, hint: '%' }, funding: { unit: 0.01, hint: '%' }, wallDist: { unit: 1, hint: '%' }
    };
    const RULE_KEYS = Object.keys(UNITS);
    const STATUS_TEXT = { connecting: 'Підключення…', live: 'Наживо', reconnecting: 'Перепідключення…', error: 'Помилка' };
    const BINANCE_COLUMNS = [
        { key: 'symbol', label: 'Монета' },
        { key: 'price', label: 'Ціна', fmt: v => '$' + window.fmt(v) },
        { key: 'chg24', label: '24г', fmt: pct, tone: true },
        { key: 'chg5', label: '5хв', fmt: pct, tone: true },
        { key: 'chg15', label: '15хв', fmt: pct, tone: true },
        { key: 'chg60', label: '1г', fmt: pct, tone: true },
        { key: 'vol1h', label: 'Обсяг 1г', fmt: usd },
        { key: 'spike', label: 'Сплеск', fmt: v => '×' + v.toFixed(1), },
        { key: 'natr5', label: 'NATR 5m', fmt: v => v.toFixed(2) + '%', },
        { key: 'funding', label: 'Фандинг', fmt: v => (v * 100).toFixed(4) + '%', tone: true },
        { key: 'vol24', label: 'Обсяг 24г', fmt: usd }
    ];
    const OKX_COLUMNS = [
        { key: 'symbol', label: 'Монета' },
        { key: 'price', label: 'Ціна', fmt: v => '$' + window.fmt(v) },
        { key: 'chg24', label: '24г', fmt: pct, tone: true },
        { key: 'vol24', label: 'Обсяг 24г', fmt: usd },
        { key: 'oi', label: 'Відкр. інтерес', fmt: usd },
        { key: 'funding', label: 'Фандинг', fmt: v => (v * 100).toFixed(4) + '%', tone: true },
        { key: 'wallUsd', label: 'Стіна, $', fmt: usd },
        { key: 'wallDist', label: 'Стіна, %', fmt: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%' }
    ];
    const SOURCES = {
        binance: { name: 'Binance Futures', columns: BINANCE_COLUMNS, defaultSort: 'vol1h' },
        okx: { name: 'OKX (знімок раз на 5 хв)', columns: OKX_COLUMNS, defaultSort: 'vol24', snap: true },
        bitget: { name: 'Bitget (знімок раз на 5 хв)', columns: OKX_COLUMNS, defaultSort: 'vol24', snap: true },
        gate: { name: 'Gate (знімок раз на 5 хв)', columns: OKX_COLUMNS, defaultSort: 'vol24', snap: true },
        mexc: { name: 'MEXC (знімок раз на 5 хв)', columns: OKX_COLUMNS, defaultSort: 'vol24', snap: true }
    };

    const freshSnap = () => ({ rows: [], status: 'connecting', detail: '', ageMs: null });
    const state = { rules: DEFAULT_RULES.map(r => ({ ...r })), source: 'binance', snaps: { okx: freshSnap(), bitget: freshSnap(), gate: freshSnap(), mexc: freshSnap() }, rows: [], sortKey: 'vol1h', sortDir: 'desc', filters: { minVol1h: 0, minNatr: 0, minSpike: 0, search: '' }, cryptoOnly: true, notice: '', status: 'connecting', detail: '' };

    function pct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
    function usd(v) { return '$' + window.fmtK(v); }
    const DETAIL_TEXT = { stale: 'немає даних понад 15 с', 'socket closed': "з'єднання закрито" };
    const columns = () => SOURCES[state.source].columns;
    // Стан активного джерела: рядки, статус і пояснення збою
    const isSnap = () => !!SOURCES[state.source].snap;
    const cur = () => (isSnap() ? state.snaps[state.source] : state);
    const failureText = () => (isSnap()
        ? `${state.source.toUpperCase()}: ${state.snaps[state.source].detail}.`
        : `Binance Futures: ${DETAIL_TEXT[state.detail] || state.detail}. Повторюємо автоматично. Якщо не з'єднується — перевірте VPN/регіон: Binance Futures недоступний у частині країн.`);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (saved && typeof saved === 'object') {
                Object.assign(state.filters, saved.filters || {});
                if (typeof saved.cryptoOnly === 'boolean') state.cryptoOnly = saved.cryptoOnly;
                if (SOURCES[saved.source]) state.source = saved.source;
                if (Array.isArray(saved.rules)) state.rules = window.Metrics.normalizeRules(saved.rules, RULE_KEYS);
                if (columns().some(c => c.key === saved.sortKey)) state.sortKey = saved.sortKey;
                if (saved.sortDir === 'asc' || saved.sortDir === 'desc') state.sortDir = saved.sortDir;
            }
        } catch (e) { /* сховище недоступне або пошкоджене — працюємо зі значеннями за замовчуванням */ }
    }
    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ rules: state.rules, source: state.source, filters: state.filters, cryptoOnly: state.cryptoOnly, sortKey: state.sortKey, sortDir: state.sortDir })); }
        catch (e) { /* приватний режим: налаштування не збережуться, це не критично */ }
    }

    function cell(col, row) {
        const v = row[col.key];
        if (v === null || v === undefined) return '<td class="lv-mu">—</td>';
        if (col.key === 'symbol') return `<td>${esc(v.replace(/USDT$/, ''))}<span class="lv-mu"> /USDT</span></td>`;
        const hot = window.Metrics.ruleHit(state.rules, col.key, v) ? ' lv-hot' : '';
        const tone = col.tone ? (v > 0 ? ' lv-up' : v < 0 ? ' lv-dn' : '') : '';
        return `<td><span class="${(hot + tone).trim()}">${esc(col.fmt(v))}</span></td>`;
    }

    function render() {
        const view = document.getElementById('view-live');
        if (!view || view.classList.contains('hidden')) return;     // у фоні не перемальовуємо
        const c = cur(), cols = columns();
        const rows = window.Metrics.sortRows(filterRows(c.rows), state.sortKey, state.sortDir);

        document.getElementById('lvHead').innerHTML = '<tr>' + cols.map(c =>
            `<th data-k="${c.key}" ${c.key === state.sortKey ? `aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}${c.key === state.sortKey ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';

        const body = document.getElementById('lvBody');
        if (!rows.length) {
            const msg = c.rows.length ? 'Жодна монета не пройшла фільтри.' : (c.detail ? esc(failureText()) : 'Очікуємо дані…');
            body.innerHTML = `<tr><td colspan="${cols.length}" class="lv-empty">${msg}</td></tr>`;
        } else {
            body.innerHTML = rows.map(r => `<tr data-sym="${esc(r.symbol)}" tabindex="0">${cols.map(col => cell(col, r)).join('')}</tr>`).join('');
        }
        const chip = document.getElementById('lvStatus');
        chip.textContent = STATUS_TEXT[c.status] || c.status;
        chip.dataset.s = c.status;
        const detail = document.getElementById('lvDetail');
        const failing = c.detail && c.status !== 'live';
        const notice = isSnap() ? '' : state.notice;
        detail.hidden = !(failing || notice);
        detail.textContent = failing ? failureText() : notice;
        document.getElementById('lvCount').textContent = `${rows.length} з ${c.rows.length} монет`;
        renderSource();
    }

    // OKX-таблиця не має хвилинних метрик: працюють лише пошук і мінімальний обсяг (за 24 год)
    function filterRows(rows) {
        if (!isSnap()) return window.Metrics.filterRows(rows, state.filters);
        const f = state.filters, search = String(f.search || '').trim().toLowerCase();
        return rows.filter(r => (!search || r.symbol.toLowerCase().includes(search)) && (!f.minVol1h || r.vol24 >= f.minVol1h));
    }

    // ---------- правила підсвітки ----------
    const unitOf = key => UNITS[key];
    const labelOf = key => (columns().find(c => c.key === key) || {}).label || key;
    const ruleText = r => `${labelOf(r.key)} ${r.op === '>=' ? '≥' : '≤'} ${+(r.value / unitOf(r.key).unit).toPrecision(6)} ${unitOf(r.key).hint}`;
    // Колонки, для яких можна додати правило в поточному джерелі (без «Монета»)
    const ruleColumns = () => columns().filter(c => UNITS[c.key]);

    function renderRules() {
        const sel = document.getElementById('lvRuleCol');
        const keep = sel.value;
        sel.innerHTML = ruleColumns().map(c => `<option value="${esc(c.key)}">${esc(c.label)} (${esc(unitOf(c.key).hint)})</option>`).join('');
        if (ruleColumns().some(c => c.key === keep)) sel.value = keep;
        const shown = state.rules.map((r, i) => ({ r, i })).filter(x => ruleColumns().some(c => c.key === x.r.key));
        document.getElementById('lvRuleList').innerHTML = shown.length
            ? shown.map(x => `<button type="button" class="lv-btn" data-rm="${x.i}" aria-label="Видалити правило: ${esc(ruleText(x.r))}">${esc(ruleText(x.r))} ✕</button>`).join('')
            : '<span class="lv-mu" style="font-size:12px">Правил підсвітки немає.</span>';
    }
    function addRule() {
        const key = document.getElementById('lvRuleCol').value, op = document.getElementById('lvRuleOp').value;
        const input = document.getElementById('lvRuleVal');
        const typed = parseFloat(input.value);
        if (!UNITS[key] || !Number.isFinite(typed)) { input.focus(); return; }
        const next = window.Metrics.normalizeRules([...state.rules, { key, op, value: typed * UNITS[key].unit }], RULE_KEYS);
        if (next.length === state.rules.length) return;       // дубль або перевищено ліміт правил
        state.rules = next; input.value = '';
        save(); renderRules(); render();
    }
    function removeRule(i) {
        state.rules = state.rules.filter((_, idx) => idx !== i);
        save(); renderRules(); render();
    }

    function renderSource() {
        document.querySelectorAll('#lvSource [data-src]').forEach(b => { b.classList.toggle('lv-on', b.dataset.src === state.source); b.setAttribute('aria-pressed', String(b.dataset.src === state.source)); });
        const okx = isSnap();
        document.getElementById('lvTitle').textContent = '📡 Скринер: ' + SOURCES[state.source].name;
        document.getElementById('lvCryptoOnly').disabled = okx;
        for (const id of ['lvMinNatr', 'lvMinSpike']) document.getElementById(id).disabled = okx;
        const age = isSnap() ? state.snaps[state.source].ageMs : null;
        document.getElementById('lvNote').textContent = okx
            ? `Усі USDT-перпетуали ${state.source.toUpperCase()} (разом із токенізованими акціями, якщо вони є на біржі) зі знімка, який збирач на GitHub Actions оновлює раз на 5 хв${age === null ? '' : ` (зараз знімку ${Math.max(0, Math.round(age / 60000))} хв)`}. «Стіна» — найбільша заявка стакана в межах ±3% (лише для топ-30 за обсягом; глибина стакана обмежена біржею, для великих монет це лише біля ціни). Хвилинних метрик, NATR і сплеску тут немає: пошук і мінімальний обсяг працюють. Клік по рядку відкриває графік Binance Futures (якщо такої монети там немає, графік не завантажиться).${state.source === 'mexc' ? ' Увага: колонка «24г» у MEXC — зміна від початку доби за UTC+8, а не за ковзні 24 години, тож з іншими біржами її порівнювати не можна.' : ''} Це аналітика, а не рекомендація.`
            : "Топ-40 USDT-ф'ючерсів за обсягом. Дані Binance Futures по WebSocket, метрики оновлюються раз на 2 с. Підсвітка — за правилами над таблицею. Клік по рядку відкриває графік. Це аналітика, а не рекомендація.";
    }

    let snapFeed = null;                  // опитуємо знімок лише активної біржі
    function stopSnap() { if (snapFeed) { snapFeed.stop(); snapFeed = null; } }
    function startSnap(ex) {
        stopSnap();
        const slot = state.snaps[ex];
        snapFeed = window.OkxSource.createExchangeFeed({
            ex, fetchImpl: (u, o) => fetch(u, o), now: () => Date.now(),
            onRows: (rows, ageMs) => { slot.rows = rows; slot.ageMs = ageMs; render(); },
            onStatus: (s, detail) => { slot.status = s; slot.detail = s === 'live' ? '' : detail; render(); }
        });
        snapFeed.start();
    }
    function setSource(src) {
        if (!SOURCES[src] || src === state.source) return;
        state.source = src;
        if (!columns().some(c => c.key === state.sortKey)) { state.sortKey = SOURCES[src].defaultSort; state.sortDir = 'desc'; }
        if (isSnap()) startSnap(src); else stopSnap();
        save(); renderRules(); render();
    }

    function openSymbol(sym) {
        const sel = document.getElementById('coinSelect');
        if (![...sel.options].some(o => o.value === sym)) sel.add(new Option(sym.replace('USDT', ' / USDT'), sym));
        window.changeSymbol(sym, { futures: true });   // ціна, свічки й стакан — ті самі ф'ючерси, що й у таблиці
        window.openTab('terminal', document.getElementById('nav-terminal'));
    }

    window.openFuturesChart = openSymbol;      // спільно з вкладкою «Плотності»

    function bind() {
        document.getElementById('lvHead').addEventListener('click', e => {
            const th = e.target.closest('th[data-k]');
            if (!th) return;
            const key = th.dataset.k;
            state.sortDir = key === state.sortKey ? (state.sortDir === 'desc' ? 'asc' : 'desc') : (key === 'symbol' ? 'asc' : 'desc');
            state.sortKey = key;
            save(); render();
        });
        document.getElementById('lvRuleAdd').addEventListener('click', addRule);
        document.getElementById('lvRuleVal').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } });
        document.getElementById('lvRuleList').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) removeRule(+b.dataset.rm); });
        document.getElementById('lvSource').addEventListener('click', e => { const b = e.target.closest('[data-src]'); if (b) setSource(b.dataset.src); });
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

    function startFeed() {
        if (window.liveFeed) window.liveFeed.stop();
        state.rows = []; state.status = 'connecting'; state.detail = ''; state.notice = '';
        const feed = window.Feed.createFeed({
            Metrics: window.Metrics,
            fetchImpl: (u, o) => fetch(u, o),
            WebSocketImpl: window.WebSocket,
            now: () => Date.now(),
            includeTradfi: !state.cryptoOnly,
            onRows: rows => { state.rows = rows; render(); },
            onStatus: (s, detail) => { state.status = s; state.detail = s === 'live' ? '' : (detail || state.detail); render(); },
            onNotice: msg => { state.notice = msg; render(); }
        });
        window.liveFeed = feed;
        feed.start();
        render();
    }

    function start() {
        load();
        bind();
        const crypto = document.getElementById('lvCryptoOnly');
        crypto.checked = state.cryptoOnly;
        crypto.addEventListener('change', () => { state.cryptoOnly = crypto.checked; save(); startFeed(); });
        renderRules();
        window.renderLive = render;      // викликається при відкритті вкладки
        startFeed();
        if (isSnap()) startSnap(state.source);
    }

    window.addEventListener('DOMContentLoaded', start);
})();
