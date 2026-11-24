// Вкладка «Торгівля» (Demo/Testnet). Власний проєкт Supabase скрінера (за схемою Orbix):
//  • вхід: пошта + пароль, 2FA (TOTP) обовʼязкова для ключів і ордерів;
//  • ключі біржі вводяться тут один раз і йдуть у Supabase Vault; у браузері не зберігаються й не повертаються;
//  • ордери надсилає серверна функція `exchange` (лише Bybit Demo / Binance Futures Testnet).
// Паролі й секрети читаються з полів форми лише в момент натискання і ніколи не потрапляють у стан програми.
(function () {
    'use strict';

    // Публічні дані проєкту (anon-ключ призначений для браузера; доступ обмежують RLS, вхід і 2FA)
    const SB_URL = 'https://ozffbhmfyoerdiosbfqq.supabase.co';
    const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96ZmZiaG1meW9lcmRpb3NiZnFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1NDg1MDMsImV4cCI6MjExMTEyNDUwM30.InOSUIPvZIJk_oeE7zmbv7JZF8foo7iUptB0sjz9tvk';
    const CALL_TIMEOUT_MS = 20000;
    const MIN_ORDER_GAP_MS = 3000;
    const BLOCK_KEY = 'cs_trade_block_v1';
    const TC = window.TradeCore;

    const state = { ex: 'bybit', signedIn: false, aal: null, conns: {}, balance: null, positions: null, busy: false, msg: '', authMsg: '',
        lastOrderAt: 0, hint: '', symbol: undefined, notional: '100', lev: '3', timeoutMs: CALL_TIMEOUT_MS, mfa: null, factorId: null };
    let SB = null;

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const $ = id => document.getElementById(id);
    const visible = () => { const el = $('view-trade'); return !!el && !el.classList.contains('hidden'); };
    const n2 = (v, d = 2) => (Number.isFinite(+v) ? (+v).toFixed(d) : '—');
    const makeLink = () => 'cs' + Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join('');

    function client() {
        if (SB) return SB;
        if (window.supabase && window.supabase.createClient) SB = window.supabase.createClient(SB_URL, SB_KEY, { auth: { detectSessionInUrl: false } });
        return SB;
    }

    // ---------- стан входу, 2FA, ключів ----------
    async function refresh() {
        const sb = client();
        if (!sb) { state.authMsg = 'Бібліотека входу не завантажилась. Перезавантажте сторінку.'; syncUi(); return; }
        try {
            const s = await sb.auth.getSession();
            state.signedIn = !!(s.data && s.data.session);
            state.aal = null; state.conns = {};
            if (state.signedIn) {
                const a = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
                state.aal = a.data || null;
                if (state.aal && state.aal.currentLevel === 'aal2') {
                    const c = await sb.from('exchange_connections').select('id,exchange,status,key_hint,can_trade,last_checked_at');
                    if (!c.error) for (const x of c.data || []) state.conns[x.exchange] = x;
                }
            } else { state.mfa = null; state.factorId = null; state.balance = null; state.positions = null; }
        } catch (e) {
            state.authMsg = 'Не вдалося прочитати стан входу: ' + (e && e.message ? e.message : e);
        }
        syncUi();
    }

    const gate = () => TC.canTrade({ signedIn: state.signedIn, aal: state.aal, conn: state.conns[state.ex] || null });

    // ---------- акаунт ----------
    async function authAction(fn) {
        if (state.busy) return;
        state.busy = true; syncUi();
        try { await fn(); } catch (e) { state.authMsg = TC.mapAuthError(e && e.message); } finally { state.busy = false; await refresh(); }
    }
    const credentials = () => ({ email: $('trEmail').value.trim(), password: $('trPass').value });
    const signIn = () => authAction(async () => {
        const c = credentials(); if (!c.email || !c.password) throw new Error('Введіть пошту й пароль.');
        const r = await client().auth.signInWithPassword(c);
        $('trPass').value = '';
        if (r.error) throw r.error;
        state.authMsg = '';
    });
    const signUp = () => authAction(async () => {
        const c = credentials(); if (!c.email || !c.password) throw new Error('Введіть пошту й пароль.');
        const r = await client().auth.signUp(c);
        $('trPass').value = '';
        if (r.error) throw r.error;
        state.authMsg = r.data && r.data.session ? 'Акаунт створено.' : 'Акаунт створено. Підтвердіть пошту (лист від Supabase) і натисніть «Увійти».';
    });
    const signOut = () => authAction(async () => { await client().auth.signOut(); state.authMsg = 'Ви вийшли.'; });

    // 2FA: або підтвердження існуючого TOTP, або вмикання нового
    const mfaStart = () => authAction(async () => {
        const sb = client();
        const list = await sb.auth.mfa.listFactors();
        for (const f of (list.data && list.data.all) || []) if (f.factor_type === 'totp' && f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
        const r = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'CryptoScreener ' + new Date().toISOString().slice(0, 16) });
        if (r.error) throw r.error;
        const qr = String(r.data.totp.qr_code || '');
        $('trQr').src = /^data:image\/svg\+xml/.test(qr) ? qr : '';       // секрет живе лише в DOM, не в стані
        $('trSecretTxt').textContent = r.data.totp.secret || '';
        state.mfa = true; state.factorId = r.data.id;
        state.authMsg = 'Скануйте QR-код у Google Authenticator (або введіть ключ вручну) і впишіть 6-значний код.';
    });
    const mfaVerify = () => authAction(async () => {
        const code = TC.cleanTotp($('trTotp').value); if (!code) throw new Error('Введіть 6 цифр.');
        let factorId = state.factorId;
        if (!factorId) {
            const l = await client().auth.mfa.listFactors();
            const f = ((l.data && l.data.totp) || []).find(x => x.status === 'verified');
            if (!f) throw new Error('Спершу ввімкніть 2FA.');
            factorId = f.id;
        }
        const r = await client().auth.mfa.challengeAndVerify({ factorId, code });
        $('trTotp').value = '';
        if (r.error) throw r.error;
        state.mfa = null; state.factorId = null; state.authMsg = '2FA підтверджено.';
    });

    // ---------- ключі ----------
    const keysAction = fn => guarded(fn);
    const saveKeys = () => keysAction(async () => {
        const g = gate0(); if (!g.ok) throw new Error(g.reason);
        const key = $('trKey').value.trim(), secret = $('trSecret').value.trim();
        $('trKey').value = ''; $('trSecret').value = '';                  // поля очищаємо одразу, до будь-яких запитів
        if (!key || !secret) throw new Error('Вставте обидва ключі: API Key і Secret.');
        state.msg = 'Зберігаю на сервері…'; render();
        const r = await client().rpc('ex_save', { p_key: key, p_secret: secret, p_exchange: state.ex });
        if (r.error) throw new Error(TC.mapError(r.error.message, null, state.ex));
        await refresh();
        const a = await call('check');
        state.balance = { wallet: a.wallet, available: a.available, unrealized: a.unrealized, canTrade: a.canTrade };
        await refresh();
        state.msg = a.canTrade ? 'Ключі збережено й перевірено: торгівля дозволена.' : 'Ключі збережено, але торгівля для ключа вимкнена.';
    });
    const deleteKeys = () => keysAction(async () => {
        const g = gate0(); if (!g.ok) throw new Error(g.reason);
        if (!window.confirm(`Видалити ключі ${TC.EXCHANGES[state.ex].short} з сервера?`)) { state.msg = 'Скасовано.'; return; }
        const r = await client().rpc('ex_delete', { p_exchange: state.ex });
        if (r.error) throw new Error(TC.mapError(r.error.message, null, state.ex));
        state.balance = null; state.positions = null; state.msg = 'Ключі видалено.';
        await refresh();
    });
    // для збереження ключів достатньо входу й 2FA (ключа ще може не бути)
    const gate0 = () => TC.canTrade({ signedIn: state.signedIn, aal: state.aal, conn: { status: 'active', can_trade: true } });

    // ---------- виклики біржі ----------
    // Один виклик серверної функції. Лише власна JSON-відповідь функції з `error` — «точно відмова»;
    // обрив, 5xx платформи й таймаут — невідомий результат (e.unknown).
    async function call(action, params) {
        const body = TC.buildBody(state.ex, action, params);
        const sb = client();
        if (!sb || !state.signedIn) throw new Error(TC.mapError('unauthorized', null, state.ex));
        let timer;
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Відповідь не отримано вчасно.'), { unknown: true })), state.timeoutMs); });
        try {
            let r;
            try { r = await Promise.race([sb.functions.invoke('exchange', { body }), timeout]); }
            catch (e) { throw e.unknown ? e : Object.assign(new Error('Звʼязок із сервером перервано.'), { unknown: true }); }
            if (r.error) {
                let j = null;
                try { j = await r.error.context.json(); } catch (e) { /* тіло не JSON */ }
                if (j && typeof j.error === 'string') throw Object.assign(new Error(TC.mapError(j.error, j.code === undefined ? null : j.code, state.ex)), { definite: true });
                throw Object.assign(new Error('Сервер відповів без пояснення (' + (r.error.name || 'помилка') + ').'), { unknown: true });
            }
            if (r.data && typeof r.data.error === 'string') throw Object.assign(new Error(TC.mapError(r.data.error, r.data.code === undefined ? null : r.data.code, state.ex)), { definite: true });
            return r.data;
        } finally { clearTimeout(timer); }
    }

    function setBusy(on) { state.busy = on; document.querySelectorAll('#view-trade [data-act], #trView button').forEach(b => { b.disabled = on; }); }
    async function guarded(fn) {
        if (state.busy) return;
        setBusy(true);
        try { await fn(); } catch (e) { state.msg = 'Помилка: ' + e.message; } finally { setBusy(false); render(); }
    }

    const doCheck = () => guarded(async () => {
        state.msg = 'Перевіряю…'; render();
        const r = await call('check');
        state.balance = { wallet: r.wallet, available: r.available, unrealized: r.unrealized, canTrade: r.canTrade };
        await refresh();
        state.msg = r.canTrade ? 'Ключі працюють, торгівля дозволена.' : 'Ключі працюють, але торгівля для ключа вимкнена.';
    });
    const loadPositions = async () => { state.positions = (await call('positions')).positions || []; };
    const doPositions = () => guarded(async () => { state.msg = 'Завантажую…'; render(); await loadPositions(); state.msg = ''; });

    const blocklist = () => TC.parseBlocklist($('trBlock') ? $('trBlock').value : '');
    const blockedMsg = symbol => `Пару ${symbol} додано до «Не торгувати вручну»: ордери й закриття тут заблоковано (біржа веде одну позицію на пару, ручна угода зіллється з позицією бота).`;

    // Доля ордера після невідомого результату: читання за ідентифікатором (без повторної відправки)
    async function lookup(body) {
        try { return { order: (await call('status', { symbol: body.symbol, link: body.link })).order || null }; }
        catch (e) { return null; }
    }
    const fill = o => `${o.side === 'BUY' ? 'купівля' : 'продаж'} ${o.qty} ${o.symbol} за ${o.approx ? '≈' : ''}${n2(o.price, 4)}`;

    const doOrder = side => guarded(async () => {
        const g = gate();
        if (!g.ok) throw new Error(g.reason);
        const body = TC.buildBody(state.ex, 'order', { symbol: String(state.symbol || '').trim().toUpperCase(), side, notional: state.notional, leverage: state.lev, link: makeLink() });
        if (TC.isBlocked(body.symbol, blocklist())) throw new Error(blockedMsg(body.symbol));
        if (Date.now() - state.lastOrderAt < MIN_ORDER_GAP_MS) throw new Error('Занадто часто: зачекайте кілька секунд.');
        if (!window.confirm(TC.describeOrder(body))) { state.msg = 'Скасовано.'; return; }
        state.lastOrderAt = Date.now();
        state.msg = 'Надсилаю ордер…'; render();
        try {
            const r = await call('order', body);
            state.msg = `Виконано: ${fill(r.order || {})} (біржа: ${TC.EXCHANGES[state.ex].short}). Стопу на біржі немає.`;
        } catch (e) {
            if (e.unknown) {
                // повторно НЕ надсилаємо: питаємо біржу за ідентифікатором ордера й показуємо справжні позиції
                const f = await lookup(body);
                if (f && f.order) state.msg = `Відповідь не дійшла, але біржа підтвердила: ордер виконано — ${fill(f.order)}. Стопу на біржі немає.`;
                else if (f) state.msg = 'Відповідь не дійшла. Біржа поки не бачить цього ордера, але запит міг ще виконуватись. Звірте позиції нижче й зачекайте щонайменше хвилину, перш ніж повторювати.';
                else state.msg = 'Результат невідомий: ' + e.message + ' Ордер МІГ виконатись — перевірте позиції нижче.';
            } else {
                const f = await lookup(body);
                state.msg = f && f.order ? `Сервер повернув помилку, але біржа показує ордер — ${fill(f.order)}. Перевірте позиції нижче.` : 'Помилка: ' + e.message + ' Біржа ордер не виконала.';
            }
            try { await loadPositions(); }
            catch (e2) { if (e.unknown) state.msg += ' Позиції теж не вдалося отримати: перевірте їх на біржі вручну.'; }
            return;
        }
        try { await loadPositions(); } catch (e) { /* ордер виконано; позиції оновіть кнопкою */ }
    });

    const doClose = symbol => guarded(async () => {
        const g = gate();
        if (!g.ok) throw new Error(g.reason);
        if (TC.isBlocked(symbol, blocklist())) throw new Error(blockedMsg(symbol));
        if (!window.confirm(`${TC.EXCHANGES[state.ex].short.toUpperCase()}: закрити ВСЮ позицію ${symbol} за ринком?`)) { state.msg = 'Скасовано.'; return; }
        state.msg = 'Закриваю позицію…'; render();
        try {
            const r = await call('close', { symbol });
            state.msg = r.closed ? `Позицію закрито за ${n2(r.order && r.order.price, 4)}.` : 'Позиції за цією парою немає.';
        } catch (e) {
            state.msg = (e.unknown ? 'Результат невідомий: ' : 'Помилка: ') + e.message + (e.unknown ? ' Закриття МОГЛО виконатись — перевірте позиції нижче.' : '');
        }
        try { await loadPositions(); } catch (e2) { state.msg += ' Позиції не вдалося оновити.'; }
    });

    function switchEx(ex) {
        if (state.busy || !TC.EXCHANGES[ex]) return;
        state.ex = ex; state.balance = null; state.positions = null; state.msg = '';
        refresh();
    }

    // ---------- відображення ----------
    function posTable() {
        if (!state.positions) return '';
        if (!state.positions.length) return '<p class="lv-note">Відкритих позицій немає.</p>';
        const blocked = blocklist();
        const rows = state.positions.map(p => {
            const isBlocked = TC.isBlocked(p.symbol, blocked);
            const action = isBlocked ? '<span class="lv-mu">(заблоковано вами)</span>'
                : `<button type="button" class="lv-btn" data-act="close" data-sym="${esc(p.symbol)}">Закрити</button>`;
            return `<tr><td>${esc(p.symbol)}<br>${action}</td><td class="${p.amt > 0 ? 'lv-up' : 'lv-dn'}">${esc(p.amt)}</td><td>${n2(p.entry, 4)}</td><td>${n2(p.mark, 4)}</td>`
                + `<td class="${p.pnl >= 0 ? 'lv-up' : 'lv-dn'}">${n2(p.pnl)}</td><td>${p.liq ? n2(p.liq, 4) : '—'}</td></tr>`;
        }).join('');
        return `<div class="lv-wrap"><table class="lv-table"><thead><tr><th>Пара</th><th>К-сть</th><th>Вхід</th><th>Mark</th><th>PnL</th><th>Ліквідація</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    // Статичні форми (вхід, 2FA, ключі) лише показуємо/ховаємо: поля пароля й секрету не перемальовуються
    function syncUi() {
        if (!$('trLogin')) return;
        const aal2 = !!(state.aal && state.aal.currentLevel === 'aal2');
        $('trLogin').hidden = state.signedIn;
        $('trMfa').hidden = !(state.signedIn && !aal2);
        $('trKeys').hidden = !(state.signedIn && aal2);
        $('trSignOut').hidden = !state.signedIn;
        $('trAcct').textContent = !state.signedIn ? 'не ввійшли' : aal2 ? '2FA ✓' : 'потрібна 2FA';
        $('trAcct').dataset.s = aal2 ? 'live' : state.signedIn ? 'reconnecting' : 'connecting';
        const hasFactor = !!(state.aal && state.aal.nextLevel === 'aal2');
        $('trMfaStart').hidden = hasFactor || !!state.mfa;
        $('trMfaForm').hidden = !(hasFactor || state.mfa);
        $('trMfaEnroll').hidden = !state.mfa;
        if (!state.mfa) { $('trQr').removeAttribute('src'); $('trSecretTxt').textContent = ''; }
        $('trAuthMsg').textContent = state.authMsg;
        $('trKeysTitle').textContent = TC.EXCHANGES[state.ex].name;
        document.querySelectorAll('#trLogin button, #trMfa button, #trKeys button, #trSignOut').forEach(b => { b.disabled = state.busy; });
        render();
    }

    function render() {
        const el = $('trBody');
        if (!el || !visible()) return;
        const ex = TC.EXCHANGES[state.ex], g = gate();
        const symbols = (window.liveFeed ? window.liveFeed.getRows() : []).map(r => r.symbol);
        const exBtns = Object.entries(TC.EXCHANGES).map(([k, v]) => `<button type="button" class="lv-btn${k === state.ex ? ' lv-on' : ''}" data-ex="${k}">${esc(v.name)}</button>`).join('');
        const conn = state.conns[state.ex];
        let html = `<div class="lv-row">${exBtns}</div>`
            + `<p class="lv-note">Вхід: <b>${state.signedIn ? 'так' : 'ні'}</b> · 2FA: <b>${state.aal && state.aal.currentLevel === 'aal2' ? 'підтверджено' : 'ні'}</b> · Ключ ${esc(ex.short)}: <b>${conn ? esc(conn.status) + (conn.key_hint ? ' …' + esc(conn.key_hint) : '') : 'не збережено'}</b></p>`;
        if (!g.ok) {
            html += `<p class="lv-note lv-warn" role="status">${esc(g.reason)}</p>`;
        } else {
            const pre = state.hint ? `<p class="lv-note">Сигнал: <b>${esc(state.hint)}</b> — це лише підказка, ордер не надсилається автоматично.</p>` : '';
            html += `<div class="lv-row"><button type="button" class="lv-btn" data-act="check">Баланс і перевірка ключа</button><button type="button" class="lv-btn" data-act="positions">Позиції</button></div>`;
            if (state.balance) html += `<p class="lv-note">Гаманець: <b>${n2(state.balance.wallet)}</b> USDT · доступно: <b>${n2(state.balance.available)}</b> · нереалізований PnL: <b>${n2(state.balance.unrealized)}</b></p>`;
            if (state.symbol === undefined) state.symbol = window.app ? window.app.sym : 'BTCUSDT';      // лише початкове значення
            html += `${pre}<div class="lv-filters"><label>Пара<input id="trSym" list="trSyms" value="${esc(state.symbol)}" autocomplete="off" spellcheck="false"></label>`
                + `<datalist id="trSyms">${symbols.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>`
                + `<label>Сума, USDT (з плечем)<input id="trNotional" type="number" min="${TC.LIMITS.minNotional}" max="${TC.LIMITS.maxNotional}" step="10" inputmode="decimal" value="${esc(state.notional)}"></label>`
                + `<label>Плече, ×<input id="trLev" type="number" min="1" max="${TC.LIMITS.maxLeverage}" step="1" inputmode="numeric" value="${esc(state.lev)}"></label></div>`
                + `<div class="lv-row"><button type="button" class="lv-btn lv-buy" id="trBuy" data-act="buy">Купити (Long)</button><button type="button" class="lv-btn lv-sell" id="trSell" data-act="sell">Продати (Short)</button></div>`
                + `<p class="lv-note">Ринковий ордер без стопа й тейку на біржі. Макс. сума ${TC.LIMITS.maxNotional} USDT, плече до ${TC.LIMITS.maxLeverage}×, не частіше одного ордера на 3 с (сервер додатково перевіряє 2 с).</p>`;
        }
        html += posTable();
        html += `<p class="lv-note" id="trMsg" role="status">${esc(state.msg)}</p>`;
        el.innerHTML = html;
        document.querySelectorAll('#trBody [data-act]').forEach(b => { b.disabled = state.busy; });
    }

    function loadBlock() {
        try { $('trBlock').value = localStorage.getItem(BLOCK_KEY) || ''; } catch (e) { /* сховище недоступне */ }
        $('trBlock').addEventListener('input', () => {
            try { localStorage.setItem(BLOCK_KEY, $('trBlock').value); } catch (e) { /* приватний режим: не збережеться */ }
            render();
        });
    }

    function bind() {
        $('trBody').addEventListener('input', e => {
            if (e.target.id === 'trSym') state.symbol = e.target.value.trim().toUpperCase();
            else if (e.target.id === 'trNotional') state.notional = e.target.value;
            else if (e.target.id === 'trLev') state.lev = e.target.value;
        });
        $('trBody').addEventListener('click', e => {
            const ex = e.target.closest('[data-ex]');
            if (ex) return switchEx(ex.dataset.ex);
            const b = e.target.closest('[data-act]');
            if (!b || state.busy) return;
            const a = b.dataset.act;
            if (a === 'check') doCheck();
            else if (a === 'positions') doPositions();
            else if (a === 'buy') doOrder('BUY');
            else if (a === 'sell') doOrder('SELL');
            else if (a === 'close') doClose(b.dataset.sym);
        });
        $('trLogin').addEventListener('submit', e => { e.preventDefault(); signIn(); });
        $('trSignUp').addEventListener('click', signUp);
        $('trSignOut').addEventListener('click', signOut);
        $('trMfaStart').addEventListener('click', mfaStart);
        $('trMfaForm').addEventListener('submit', e => { e.preventDefault(); mfaVerify(); });
        $('trKeyForm').addEventListener('submit', e => { e.preventDefault(); saveKeys(); });
        $('trKeyDel').addEventListener('click', deleteKeys);
        loadBlock();
    }

    // Підказка з формації: заповнює пару, але нічого не надсилає
    window.openTrade = function (opts) {
        state.symbol = opts && opts.symbol ? String(opts.symbol).toUpperCase() : state.symbol;
        state.hint = opts && opts.symbol ? `${state.symbol} ${opts.side === 'short' ? 'SHORT' : 'LONG'}` : '';
        window.openTab('trade', document.getElementById('nav-trade'));
    };
    window.renderTrade = function () { syncUi(); refresh(); };      // спершу синхронно (пара в полі = пара в стані), потім стан із сервера
    window.tradeState = state;          // для тестів і діагностики; токенів і секретів тут немає

    window.addEventListener('DOMContentLoaded', () => { bind(); syncUi(); });
})();
