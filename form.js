// Вкладка «Формації»: запускає детектор (formations.js) на живих 1m-свічках, веде історію сигналів у браузері
// й показує статистику відпрацювання за 24 год, 7 днів і весь час.
(function () {
    'use strict';

    const STORE_KEY = 'cs_form_v1';
    const SCAN_MS = 5000;
    const DAY = 24 * 60 * 60000;
    const TYPE_NAMES = { breakout: 'Пробій рівня', retest: 'Ретест рівня', surge: 'Сплеск обсягу', bounce: 'Відскок від плотності' };
    const state = { signals: [], type: 'all', onlyOpen: false, sound: false };

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const visible = id => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden'); };
    const STATUSES = ['open', 'win', 'loss', 'expired', 'unknown'];
    const validSignal = s => s && typeof s.id === 'string' && TYPE_NAMES[s.type] && (s.side === 'long' || s.side === 'short')
        && ['time', 'entry', 'stop', 'take'].every(k => Number.isFinite(s[k])) && STATUSES.includes(s.status);

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (saved && Array.isArray(saved.signals)) state.signals = saved.signals.filter(validSignal);   // пошкоджені записи відкидаємо
            if (saved && typeof saved.sound === 'boolean') state.sound = saved.sound;
            if (saved && typeof saved.onlyOpen === 'boolean') state.onlyOpen = saved.onlyOpen;
            if (saved && (saved.type === 'all' || TYPE_NAMES[saved.type])) state.type = saved.type;
        } catch (e) { /* сховище недоступне або пошкоджене — починаємо з порожньої історії */ }
    }
    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ signals: state.signals, sound: state.sound, onlyOpen: state.onlyOpen, type: state.type })); }
        catch (e) { /* приватний режим або переповнення: історія не збережеться, це не критично */ }
    }

    // Один прохід: нові формації по всіх монетах, потім результат для відкритих сигналів
    function scan() {
        const feed = window.liveFeed;
        if (!feed) return;
        const now = Date.now();
        const candlesBy = new Map();
        const fresh = [];
        for (const row of feed.getRows()) {
            const cs = feed.getCandles(row.symbol);
            candlesBy.set(row.symbol, cs);
            const walls = window.densFeed ? window.densFeed.forSymbol(row.symbol) : [];
            fresh.push(...window.Formations.detect(row.symbol, cs, { walls }));
        }
        const before = state.signals;
        let next = window.Formations.addSignals({ signals: before }, fresh).signals;
        const added = next.filter(s => !before.some(b => b.id === s.id));
        next = next.map(s => {
            if (s.status !== 'open') return s;
            const cs = candlesBy.get(s.symbol) || [];
            const res = window.Formations.evaluate(s, cs.slice(0, -1), now);
            return res.status === s.status ? s : { ...s, ...res };
        });
        const changed = added.length > 0 || next.some((s, i) => s !== before[i] && !added.includes(s));
        if (!changed) return;
        state.signals = next;
        save();
        if (added.length && state.sound && window.beep) window.beep(added.some(s => s.side === 'long') ? 740 : 520);
        render();
    }

    const fmtTime = t => {
        const d = new Date(t), today = new Date();
        const hm = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        return d.toDateString() === today.toDateString() ? hm : d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
    };
    const rText = r => (r > 0 ? '+' : '') + r.toFixed(1) + 'R';
    function statusCell(s) {
        if (s.status === 'open') return '<span class="lv-mu">⏳ відкрита</span>';
        if (s.status === 'win') return `<span class="lv-up">✅ ${rText(s.r)}</span>`;
        if (s.status === 'loss') return `<span class="lv-dn">❌ ${rText(s.r)}</span>`;
        if (s.status === 'expired') return `<span class="${s.r >= 0 ? 'lv-up' : 'lv-dn'}">⏱ ${rText(s.r)}</span>`;
        return '<span class="lv-mu">? невідомо</span>';
    }
    function statCell(t) {
        if (!t) return '<td class="lv-mu">—</td>';
        const wr = t.winrate === null ? '—' : t.winrate.toFixed(0) + '%';
        const r = t.avgR === null ? '' : ` · ${rText(t.avgR)}`;
        const open = t.open ? `<span class="lv-mu"> (${t.open} відкр.)</span>` : '';
        return `<td>${t.n}${open}<span class="lv-mu"> · </span>${wr}${r}</td>`;
    }

    function render() {
        if (!visible('view-form')) return;
        const now = Date.now();
        const day = window.Formations.stats(state.signals, DAY, now), week = window.Formations.stats(state.signals, 7 * DAY, now), all = window.Formations.stats(state.signals, Infinity, now);
        document.getElementById('fmStats').innerHTML = Object.entries(TYPE_NAMES).map(([k, name]) =>
            `<tr><td>${name}</td>${statCell(day[k])}${statCell(week[k])}${statCell(all[k])}</tr>`).join('');

        const list = state.signals.filter(s => (state.type === 'all' || s.type === state.type) && (!state.onlyOpen || s.status === 'open')).slice().reverse();
        document.getElementById('fmBody').innerHTML = list.length
            ? list.map(s => `<tr data-sym="${esc(s.symbol)}" tabindex="0"><td>${esc(fmtTime(s.time))}</td><td>${esc(s.symbol.replace(/USDT$/, ''))}<span class="lv-mu"> /USDT</span></td>`
                + `<td>${esc(TYPE_NAMES[s.type])}</td><td class="${s.side === 'long' ? 'lv-up' : 'lv-dn'}">${s.side === 'long' ? 'LONG ▲' : 'SHORT ▼'}</td>`
                + `<td>$${esc(window.fmt(s.entry))}</td><td class="lv-dn">$${esc(window.fmt(s.stop))}</td><td class="lv-up">$${esc(window.fmt(s.take))}</td><td>${statusCell(s)}</td></tr>`).join('')
            : `<tr><td colspan="8" class="lv-empty">${state.signals.length ? 'Немає сигналів за цими фільтрами.' : 'Поки що формацій не знайдено. Детектор працює, поки відкрита сторінка: перший сигнал зʼявиться, коли закриється відповідна свічка.'}</td></tr>`;
        document.getElementById('fmCount').textContent = `${list.length} з ${state.signals.length} сигналів`;
    }

    function bind() {
        const type = document.getElementById('fmType'), open = document.getElementById('fmOpen'), sound = document.getElementById('fmSound');
        type.value = state.type; open.checked = state.onlyOpen; sound.checked = state.sound;
        type.addEventListener('change', () => { state.type = type.value; save(); render(); });
        open.addEventListener('change', () => { state.onlyOpen = open.checked; save(); render(); });
        sound.addEventListener('change', () => { state.sound = sound.checked; save(); if (state.sound && window.beep) window.beep(660); });
        const body = document.getElementById('fmBody');
        body.addEventListener('click', e => { const tr = e.target.closest('tr[data-sym]'); if (tr) window.openFuturesChart(tr.dataset.sym); });
        body.addEventListener('keydown', e => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-sym]'); if (tr) window.openFuturesChart(tr.dataset.sym); } });
        document.getElementById('fmClear').addEventListener('click', () => {
            if (!window.confirm('Видалити всю історію формацій і статистику?')) return;
            state.signals = []; save(); render();
        });
    }

    function start() {
        load();
        bind();
        window.formationsScan = scan;        // використовується тестами
        window.renderForm = render;
        setInterval(scan, SCAN_MS);
        render();
    }

    window.addEventListener('DOMContentLoaded', start);
})();
