// Торгівля Demo/Testnet через серверну функцію Orbix `exchange`. Ключів бірж тут НЕМАЄ: їх вносять у формі Orbix, вони лежать
// у Supabase Vault і до браузера не потрапляють. Вхід і 2FA — з сесії Orbix (той самий origin koloss10.github.io, те саме
// сховище). Ордери надсилає лише ця вкладка і лише після явного підтвердження; автоповторів немає.
(function () {
    'use strict';

    // Публічні дані проєкту Orbix (anon-ключ призначений для браузера; доступ обмежує RLS і вхід користувача)
    const SB_URL = 'https://krmnaypaitruhqgaxkfw.supabase.co';
    const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtybW5heXBhaXRydWhxZ2F4a2Z3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NzgwMjIsImV4cCI6MjExMDM1NDAyMn0.g91ptIoKGGXaTiz49Y1ukSFDX-709Vf8LbpuxYzapZU';
    const ORBIX_URL = 'https://koloss10.github.io/Orbix/';
    const CALL_TIMEOUT_MS = 20000;
    const MIN_ORDER_GAP_MS = 3000;
    const TC = window.TradeCore;

    const state = { ex: 'bybit', signedIn: false, aal: null, conns: {}, bots: [], botsLoaded: false, balance: null, positions: null,
        busy: false, msg: '', lastOrderAt: 0, hint: '' };
    let SB = null;

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const $ = id => document.getElementById(id);
    const visible = () => { const el = $('view-trade'); return !!el && !el.classList.contains('hidden'); };
    const n2 = (v, d = 2) => (Number.isFinite(+v) ? (+v).toFixed(d) : '—');

    function client() {
        if (SB) return SB;
        // Налаштування за замовчуванням, як в Orbix, щоб ділити одну сесію; лише без читання токена з адреси
        if (window.supabase && window.supabase.createClient) SB = window.supabase.createClient(SB_URL, SB_KEY, { auth: { detectSessionInUrl: false } });
        return SB;
    }

    // Стан входу, 2FA, ключів і ботів. Жодних запитів до біржі: лише сесія й таблиці Orbix (RLS)
    async function refresh() {
        const sb = client();
        if (!sb) { state.msg = 'Бібліотека входу не завантажилась. Перезавантажте сторінку.'; render(); return; }
        try {
            const s = await sb.auth.getSession();
            state.signedIn = !!(s.data && s.data.session);
            state.aal = null; state.conns = {}; state.bots = []; state.botsLoaded = false;
            if (state.signedIn) {
                const a = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
                state.aal = a.data || null;
                const c = await sb.from('exchange_connections').select('id,exchange,status,key_hint,can_trade,last_checked_at').eq('is_testnet', true);
                if (!c.error) for (const x of c.data || []) state.conns[x.exchange] = x;
                const b = await sb.from('bots').select('id,name,symbol,status,config');
                state.botsLoaded = !b.error;
                state.bots = b.error ? [] : (b.data || []);
            }
        } catch (e) {
            state.msg = 'Не вдалося прочитати стан входу: ' + (e && e.message ? e.message : e);
        }
        render();
    }

    const gate = () => TC.canTrade({ signedIn: state.signedIn, aal: state.aal, conn: state.conns[state.ex] || null, botsLoaded: state.botsLoaded });

    // Один виклик серверної функції; помилки перекладаються як в Orbix. Автоповторів немає.
    async function call(action, params) {
        const body = TC.buildBody(state.ex, action, params);
        const sb = client();
        if (!sb || !state.signedIn) throw new Error(TC.mapError('unauthorized', null, state.ex));
        let timer;
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Відповідь не отримано вчасно.'), { unknown: true })), CALL_TIMEOUT_MS); });
        try {
            const r = await Promise.race([sb.functions.invoke('exchange', { body }), timeout]);
            if (r.error) {
                let m = r.error.message, c = null;
                try { const j = await r.error.context.json(); m = j.error || m; c = j.code === undefined ? null : j.code; } catch (e) { /* тіло не JSON — лишаємо загальне повідомлення */ }
                throw new Error(TC.mapError(m, c, state.ex));
            }
            return r.data;
        } finally { clearTimeout(timer); }
    }

    function setBusy(on) { state.busy = on; document.querySelectorAll('#view-trade [data-act]').forEach(b => { b.disabled = on; }); }
    async function guarded(fn) {
        if (state.busy) return;
        setBusy(true);
        try { await fn(); } catch (e) { state.msg = 'Помилка: ' + e.message; } finally { setBusy(false); render(); }
    }

    const doCheck = () => guarded(async () => {
        state.msg = 'Перевіряю…'; render();
        const r = await call('check');
        state.balance = { wallet: r.wallet, available: r.available, unrealized: r.unrealized, canTrade: r.canTrade };
        state.msg = r.canTrade ? 'Ключі працюють, торгівля дозволена.' : 'Ключі працюють, але торгівля для ключа вимкнена.';
    });
    const loadPositions = async () => { state.positions = (await call('positions')).positions || []; };
    const doPositions = () => guarded(async () => { state.msg = 'Завантажую…'; render(); await loadPositions(); state.msg = ''; });

    const blockedMsg = symbol => `Пара ${symbol}: на ній працює бот Orbix. Ручна угода зіллється з позицією бота (біржа веде одну позицію на пару), тому ордери й закриття тут заблоковано.`;
    function pairBlocked(symbol) { return TC.isBlocked(symbol, TC.botPairs(state.bots, state.ex)); }

    const doOrder = side => guarded(async () => {
        const g = gate();
        if (!g.ok) throw new Error(g.reason);
        const body = TC.buildBody(state.ex, 'order', { symbol: String($('trSym').value || '').trim().toUpperCase(), side, notional: $('trNotional').value, leverage: $('trLev').value });
        if (pairBlocked(body.symbol)) throw new Error(blockedMsg(body.symbol));
        if (Date.now() - state.lastOrderAt < MIN_ORDER_GAP_MS) throw new Error('Занадто часто: зачекайте кілька секунд.');
        if (!window.confirm(TC.describeOrder(body))) { state.msg = 'Скасовано.'; return; }
        state.lastOrderAt = Date.now();
        state.msg = 'Надсилаю ордер…'; render();
        try {
            const r = await call('order', body);
            const o = r.order || {};
            state.msg = `Виконано: ${o.side === 'BUY' ? 'купівля' : 'продаж'} ${o.qty} ${o.symbol} за ${o.approx ? '≈' : ''}${n2(o.price, 4)} (біржа: ${TC.EXCHANGES[state.ex].short}). Стопу на біржі немає.`;
        } catch (e) {
            // Результат ордера міг бути невідомим (таймаут): повторно НЕ надсилаємо, а показуємо справжні позиції
            state.msg = 'Помилка: ' + e.message + (e.unknown ? ' Результат невідомий — перевірте позиції нижче.' : ' Ордер, найімовірніше, не виконано — перевірте позиції.');
            try { await loadPositions(); } catch (e2) { /* позиції недоступні — користувач побачить помилку вище */ }
            return;
        }
        try { await loadPositions(); } catch (e) { /* ордер виконано; позиції оновіть кнопкою */ }
    });

    const doClose = symbol => guarded(async () => {
        const g = gate();
        if (!g.ok) throw new Error(g.reason);
        if (pairBlocked(symbol)) throw new Error(blockedMsg(symbol));
        if (!window.confirm(`${TC.EXCHANGES[state.ex].short.toUpperCase()}: закрити ВСЮ позицію ${symbol} за ринком?`)) { state.msg = 'Скасовано.'; return; }
        state.msg = 'Закриваю позицію…'; render();
        const r = await call('close', { symbol });
        state.msg = r.closed ? `Позицію закрито за ${n2(r.order && r.order.price, 4)}.` : 'Позиції за цією парою немає.';
        await loadPositions();
    });

    function switchEx(ex) {
        if (state.busy || !TC.EXCHANGES[ex]) return;
        state.ex = ex; state.balance = null; state.positions = null; state.msg = '';
        render();
    }

    function posTable() {
        if (!state.positions) return '';
        if (!state.positions.length) return '<p class="lv-note">Відкритих позицій немає.</p>';
        const blocked = TC.botPairs(state.bots, state.ex);
        const rows = state.positions.map(p => {
            const isBot = TC.isBlocked(p.symbol, blocked);
            const action = isBot ? '<span class="lv-mu">(бот Orbix, заблоковано)</span>'
                : `<button type="button" class="lv-btn" data-act="close" data-sym="${esc(p.symbol)}">Закрити</button>`;
            return `<tr><td>${esc(p.symbol)}<br>${action}</td><td class="${p.amt > 0 ? 'lv-up' : 'lv-dn'}">${esc(p.amt)}</td><td>${n2(p.entry, 4)}</td><td>${n2(p.mark, 4)}</td>`
                + `<td class="${p.pnl >= 0 ? 'lv-up' : 'lv-dn'}">${n2(p.pnl)}</td><td>${p.liq ? n2(p.liq, 4) : '—'}</td></tr>`;
        }).join('');
        return `<div class="lv-wrap"><table class="lv-table"><thead><tr><th>Пара</th><th>К-сть</th><th>Вхід</th><th>Mark</th><th>PnL</th><th>Ліквідація</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function render() {
        const el = $('trBody');
        if (!el || !visible()) return;
        const ex = TC.EXCHANGES[state.ex], g = gate();
        const symbols = (window.liveFeed ? window.liveFeed.getRows() : []).map(r => r.symbol);
        const exBtns = Object.entries(TC.EXCHANGES).map(([k, v]) => `<button type="button" class="lv-btn${k === state.ex ? ' lv-on' : ''}" data-ex="${k}">${esc(v.name)}</button>`).join('');
        const conn = state.conns[state.ex];
        let html = `<p class="lv-note lv-warn" role="note">Лише демо-рахунки: <b>${esc(ex.name)}</b>. Ключі тут не вводяться — додайте їх в <a href="${ORBIX_URL}" target="_blank" rel="noopener">Orbix</a> (Профіль → «Демо-торгівля на біржі»). Ордери надсилає сервер Orbix; реальні кошти недоступні.</p>`
            + `<div class="lv-row">${exBtns}<button type="button" class="lv-btn" data-act="refresh">Оновити стан</button></div>`;
        html += `<p class="lv-note">Вхід: <b>${state.signedIn ? 'так' : 'ні'}</b> · 2FA: <b>${state.aal && state.aal.currentLevel === 'aal2' ? 'підтверджено' : 'ні'}</b> · Ключ: <b>${conn ? esc(conn.status) + (conn.key_hint ? ' …' + esc(conn.key_hint) : '') : 'не збережено'}</b> · Ботів Orbix: <b>${state.botsLoaded ? state.bots.length : '?'}</b></p>`;
        if (!g.ok) {
            html += `<p class="lv-note lv-warn" role="status">${esc(g.reason)}</p>`;
        } else {
            const pre = state.hint ? `<p class="lv-note">Сигнал: <b>${esc(state.hint)}</b> — це лише підказка, ордер не надсилається автоматично.</p>` : '';
            html += `<div class="lv-row"><button type="button" class="lv-btn" data-act="check">Баланс і перевірка ключа</button><button type="button" class="lv-btn" data-act="positions">Позиції</button></div>`;
            if (state.balance) html += `<p class="lv-note">Гаманець: <b>${n2(state.balance.wallet)}</b> USDT · доступно: <b>${n2(state.balance.available)}</b> · нереалізований PnL: <b>${n2(state.balance.unrealized)}</b></p>`;
            html += `${pre}<div class="lv-filters"><label>Пара<input id="trSym" list="trSyms" value="${esc(state.symbol || (window.app ? window.app.sym : 'BTCUSDT'))}" autocomplete="off" spellcheck="false"></label>`
                + `<datalist id="trSyms">${symbols.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>`
                + `<label>Сума, USDT (з плечем)<input id="trNotional" type="number" min="${TC.LIMITS.minNotional}" max="${TC.LIMITS.maxNotional}" step="10" inputmode="decimal" value="100"></label>`
                + `<label>Плече, ×<input id="trLev" type="number" min="1" max="${TC.LIMITS.maxLeverage}" step="1" inputmode="numeric" value="3"></label></div>`
                + `<div class="lv-row"><button type="button" class="lv-btn lv-buy" id="trBuy" data-act="buy">Купити (Long)</button><button type="button" class="lv-btn lv-sell" id="trSell" data-act="sell">Продати (Short)</button></div>`
                + `<p class="lv-note">Ринковий ордер без стопа й тейку на біржі. Макс. сума ${TC.LIMITS.maxNotional} USDT, плече до ${TC.LIMITS.maxLeverage}×. Пари з ботами Orbix заблоковано.</p>`;
        }
        html += posTable();
        html += `<p class="lv-note" id="trMsg" role="status">${esc(state.msg)}</p>`;   // повідомлення можуть містити текст із сервера — екрануємо
        el.innerHTML = html;
        document.querySelectorAll('#view-trade [data-act]').forEach(b => { b.disabled = state.busy; });
    }

    function bind() {
        $('trBody').addEventListener('click', e => {
            const ex = e.target.closest('[data-ex]');
            if (ex) return switchEx(ex.dataset.ex);
            const b = e.target.closest('[data-act]');
            if (!b || state.busy) return;
            const a = b.dataset.act;
            if (a === 'refresh') guarded(refresh);
            else if (a === 'check') doCheck();
            else if (a === 'positions') doPositions();
            else if (a === 'buy') doOrder('BUY');
            else if (a === 'sell') doOrder('SELL');
            else if (a === 'close') doClose(b.dataset.sym);
        });
    }

    // Підказка з формації: заповнює пару, але нічого не надсилає
    window.openTrade = function (opts) {
        state.symbol = opts && opts.symbol ? String(opts.symbol).toUpperCase() : state.symbol;
        state.hint = opts && opts.symbol ? `${state.symbol} ${opts.side === 'short' ? 'SHORT' : 'LONG'}` : '';
        window.openTab('trade', document.getElementById('nav-trade'));
    };
    window.renderTrade = function () { refresh(); };
    window.tradeState = state;          // для тестів і діагностики; токенів тут немає

    window.addEventListener('DOMContentLoaded', () => { bind(); render(); });
})();
