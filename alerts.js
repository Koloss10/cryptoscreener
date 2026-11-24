// Вкладка «Сигнали»: правила над живими метриками Binance Futures (скринер), журнал, звук і сповіщення ПК.
// Працює лише поки сторінка відкрита (серверних сповіщень тут немає). Логіка — alerts-core.js.
(function () {
    'use strict';

    const STORE_KEY = 'cs_signals_v1';
    const TICK_MS = 2000;
    const MAX_NOTIFY_PER_TICK = 3;                 // решту подій того ж такту зводимо в одне сповіщення
    const LABELS = { price: 'Ціна', chg5: '5хв', chg15: '15хв', chg60: '1г', chg24: '24г', vol1h: 'Обсяг 1г', vol24: 'Обсяг 24г', spike: 'Сплеск', natr5: 'NATR 5m', funding: 'Фандинг' };

    const Core = window.AlertsCore, UNITS = window.Metrics.RULE_UNITS;
    const state = { rules: [], sound: true, notify: false, log: [] };
    const engine = Core.createEngine();
    let timer = null, audio = null;

    const $ = id => document.getElementById(id);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // 1 сигнал, 2–4 сигнали, 5+ (і 11–14) сигналів
    const plural = n => (n % 10 === 1 && n % 100 !== 11 ? 'сигнал' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'сигнали' : 'сигналів');
    const fmtTime = t => new Date(t).toLocaleTimeString('uk-UA', { hour12: false });
    const num = (key, raw) => +(raw / UNITS[key].unit).toPrecision(6);
    const condText = r => `${LABELS[r.key]} ${r.op === '>=' ? '≥' : '≤'} ${num(r.key, r.value)} ${UNITS[r.key].hint}`;
    const ruleText = r => `${r.symbol ? r.symbol.replace(/USDT$/, '') : 'Будь-яка монета'}: ${condText(r)}`;
    const eventText = e => `${LABELS[e.key]} ${num(e.key, e.actual)} ${UNITS[e.key].hint} (умова: ${e.op === '>=' ? '≥' : '≤'} ${num(e.key, e.value)})`;

    function load() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (!s || typeof s !== 'object') return;
            state.rules = Core.normalizeRules(s.rules);
            if (typeof s.sound === 'boolean') state.sound = s.sound;
            if (typeof s.notify === 'boolean') state.notify = s.notify;
            if (Array.isArray(s.log)) state.log = s.log.filter(e => e && Core.KEYS.includes(e.key) && typeof e.symbol === 'string' && Number.isFinite(e.at)).slice(0, Core.MAX_LOG);
        } catch (e) { /* сховище недоступне або пошкоджене — починаємо з порожнього */ }
    }
    function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* приватний режим — не критично */ } }

    // ---------- сповіщення ----------
    function beep() {
        if (!state.sound) return;
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            const osc = audio.createOscillator(), gain = audio.createGain();
            osc.type = 'sine'; osc.frequency.value = 880; gain.gain.value = 0.08;
            osc.connect(gain); gain.connect(audio.destination);
            osc.start(); osc.stop(audio.currentTime + 0.18);
        } catch (e) { /* автозвук заблоковано браузером до першого кліку — це нормально */ }
    }
    const canNotify = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';
    function notify(events) {
        if (!state.notify || !canNotify() || !events.length) return;
        try {
            for (const e of events.slice(0, MAX_NOTIFY_PER_TICK)) new Notification(`${e.symbol.replace(/USDT$/, '')}: сигнал`, { body: eventText(e), tag: e.ruleId + e.symbol });
            if (events.length > MAX_NOTIFY_PER_TICK) new Notification('CryptoScreener', { body: `Ще ${events.length - MAX_NOTIFY_PER_TICK} ${plural(events.length - MAX_NOTIFY_PER_TICK)}: дивіться журнал.`, tag: 'cs-more' });
        } catch (e) { /* сповіщення недоступні в цьому контексті */ }
    }

    // ---------- цикл ----------
    function tick() {
        if (!state.rules.length || !window.liveFeed) return;
        const events = engine.evaluate(state.rules, window.liveFeed.getRows());
        if (!events.length) return;
        state.log = [...events.slice().reverse(), ...state.log].slice(0, Core.MAX_LOG);
        save(); beep(); notify(events); render();
    }
    // Для тестів: один прохід без очікування таймера
    window.__signalsTick = tick;
    window.__signalsPlural = plural;

    // ---------- інтерфейс ----------
    function fillColumns() {
        $('sgCol').innerHTML = Core.KEYS.map(k => `<option value="${esc(k)}">${esc(LABELS[k])} (${esc(UNITS[k].hint)})</option>`).join('');
    }
    function render() {
        $('sgRules').innerHTML = state.rules.length
            ? state.rules.map((r, i) => `<button type="button" class="lv-btn" data-rm="${i}" aria-label="Видалити правило: ${esc(ruleText(r))}">${esc(ruleText(r))} ✕</button>`).join('')
            : '<span class="lv-mu" style="font-size:12px">Правил немає. Додайте перше вище.</span>';
        $('sgLog').innerHTML = state.log.length
            ? state.log.map(e => `<tr><td>${esc(fmtTime(e.at))}</td><td>${esc(e.symbol.replace(/USDT$/, ''))}<span class="lv-mu"> /USDT</span></td><td>${esc(eventText(e))}</td></tr>`).join('')
            : '<tr><td colspan="3" class="lv-empty">Сигналів ще не було.</td></tr>';
        $('sgSound').checked = state.sound;
        $('sgNotify').checked = state.notify && canNotify();
        $('sgPerm').textContent = typeof Notification === 'undefined' ? 'Сповіщення ПК цей браузер не підтримує.'
            : Notification.permission === 'denied' ? 'Сповіщення заблоковано в налаштуваннях браузера для цього сайту.' : '';
        $('sgCount').textContent = `${state.rules.length} правил`;
    }
    function addRule() {
        const key = $('sgCol').value, value = parseFloat($('sgVal').value);
        if (!UNITS[key] || !Number.isFinite(value)) { $('sgVal').focus(); return; }
        const typed = $('sgSym').value.trim();
        let symbol = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (typed && !symbol) { $('sgMsg').textContent = 'Невірна назва монети. Приклад: BTC або SOLUSDT; порожнє поле — будь-яка монета.'; $('sgSym').focus(); return; }
        if (symbol && !symbol.endsWith('USDT')) symbol += 'USDT';
        const next = Core.normalizeRules([...state.rules, { key, op: $('sgOp').value, value: value * UNITS[key].unit, symbol }]);
        if (next.length === state.rules.length) { $('sgMsg').textContent = 'Таке правило вже є, помилкова назва монети або досягнуто ліміту правил.'; return; }
        $('sgMsg').textContent = '';
        state.rules = next; $('sgVal').value = '';
        save(); render();
    }
    async function toggleNotify() {
        if ($('sgNotify').checked) {
            if (typeof Notification === 'undefined') { $('sgNotify').checked = false; return render(); }
            let perm = Notification.permission;
            if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; } }
            state.notify = perm === 'granted';
        } else state.notify = false;
        save(); render();
    }

    function bind() {
        $('sgAdd').addEventListener('click', addRule);
        $('sgVal').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } });
        $('sgRules').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (!b) return; state.rules = state.rules.filter((_, i) => i !== +b.dataset.rm); save(); render(); });
        $('sgSound').addEventListener('change', () => { state.sound = $('sgSound').checked; save(); if (state.sound) beep(); });
        $('sgNotify').addEventListener('change', toggleNotify);
        $('sgClear').addEventListener('click', () => { state.log = []; save(); render(); });
    }

    window.renderSignals = render;          // викликається при відкритті вкладки
    window.addEventListener('DOMContentLoaded', () => {
        load(); fillColumns(); bind(); render();
        timer = setInterval(tick, TICK_MS);
    });
})();
