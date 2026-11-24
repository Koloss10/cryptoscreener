// Ядро торгової панелі: перевірки, тіло запитів до серверної функції Orbix `exchange`, тексти помилок.
// Чисті функції без DOM і мережі. Тести: tests/trade-core.test.js.
// ВАЖЛИВО: тут немає жодної роботи з ключами бірж. Ключі лежать у Supabase Vault і до браузера не потрапляють;
// ордери надсилає серверна функція Orbix (Bybit Demo / Binance Futures Testnet — адреси зашиті на сервері).
(function (root) {
    'use strict';

    // Лише ці дії. Сервер знає ще `flat` (знімає ордери бота) — його звідси надсилати не можна.
    const ALLOWED_ACTIONS = ['check', 'positions', 'order', 'close'];
    // Суворіше за сервер (він дозволяє до 100000 USDT і плече до 20×)
    const LIMITS = { minNotional: 5, maxNotional: 5000, maxLeverage: 10 };
    const EXCHANGES = {
        bybit: { name: 'Bybit Demo Trading', short: 'Bybit Demo' },
        binance: { name: 'Binance Futures Testnet', short: 'тестнет Binance' }
    };
    const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;          // як на сервері (exchanges.ts)

    // Пари Orbix (BTC/USDT, 1000PEPE/USDT) і символи біржі (BTCUSDT, 1000PEPEUSDT) приводимо до одного вигляду
    const normSymbol = s => String(s || '').replace('/', '').toUpperCase().replace(/^1000+/, '');

    // Пари ботів Orbix, що торгують на біржі (серверний бот або «Тестнет»), незалежно від статусу.
    // Біржа не вказана в конфігу — вважаємо, що бот може бути на будь-якій.
    function botPairs(bots, exchange) {
        const out = new Set();
        for (const b of bots || []) {
            const c = b && b.config ? b.config : {};
            if (!(c._tn || c._srv)) continue;
            if (c._ex && c._ex !== exchange) continue;
            out.add(normSymbol(b.symbol));
        }
        return out;
    }
    const isBlocked = (symbol, pairs) => pairs.has(normSymbol(symbol));

    function validExchange(exchange) {
        if (!EXCHANGES[exchange]) throw new Error('Невідома біржа.');
        return exchange;
    }

    // Єдина точка формування запитів до функції `exchange`: allowlist дій і сувора перевірка параметрів
    function buildBody(exchange, action, p) {
        if (!ALLOWED_ACTIONS.includes(action)) throw new Error(`Дія «${action}» не дозволена.`);
        validExchange(exchange);
        if (action === 'check' || action === 'positions') return { exchange, action };
        const symbol = p && p.symbol;
        if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) throw new Error('Неправильна пара (приклад: BTCUSDT).');
        if (action === 'close') return { exchange, action, symbol };
        const side = p.side;
        if (side !== 'BUY' && side !== 'SELL') throw new Error('Неправильний напрям ордера.');
        const notional = Number(p.notional);
        if (!Number.isFinite(notional) || notional < LIMITS.minNotional || notional > LIMITS.maxNotional) {
            throw new Error(`Сума ордера: від ${LIMITS.minNotional} до ${LIMITS.maxNotional} USDT.`);
        }
        const leverage = Number(p.leverage);
        if (!Number.isInteger(leverage) || leverage < 1 || leverage > LIMITS.maxLeverage) {
            throw new Error(`Плече: ціле число від 1 до ${LIMITS.maxLeverage}×.`);
        }
        return { exchange, action, symbol, side, notional: Math.round(notional * 100) / 100, leverage };
    }

    // Чи можна торгувати: перший блокер із підказкою, що робити в Orbix
    function canTrade(ctx) {
        if (!ctx.signedIn) return { ok: false, reason: 'Увійдіть в Orbix у цьому ж браузері (посилання нижче), потім натисніть «Оновити стан».' };
        const a = ctx.aal || {};
        if (a.currentLevel !== 'aal2') {
            return { ok: false, reason: a.nextLevel === 'aal2'
                ? 'Підтвердьте вхід кодом з Google Authenticator в Orbix, потім натисніть «Оновити стан».'
                : 'Увімкніть двофакторний вхід в Orbix (Профіль → Безпека): торгова панель працює лише з 2FA.' };
        }
        if (!ctx.conn) return { ok: false, reason: 'Додайте ключі біржі в Orbix (Профіль → «Демо-торгівля на біржі»): тут ключі не вводяться.' };
        if (ctx.conn.status !== 'active') return { ok: false, reason: 'Біржа не приймає збережені ключі (статус: ' + ctx.conn.status + '). Перевірте їх в Orbix.' };
        if (!ctx.conn.can_trade) return { ok: false, reason: 'У ключа немає дозволу на торгівлю контрактами. Змініть ключ в Orbix.' };
        if (!ctx.botsLoaded) return { ok: false, reason: 'Не вдалося перевірити ботів Orbix — торгівлю заблоковано, щоб ручна угода не зіллялась з позицією бота.' };
        return { ok: true };
    }

    // Тексти помилок: ті самі формулювання, що в Orbix (src/js/19-testnet.js)
    const KNOWN = {
        'invalid key format': 'Ключі мають вигляд довгого рядка з латинських літер і цифр.',
        'mfa required': 'Спершу підтвердьте вхід кодом з Google Authenticator в Orbix.',
        'not authenticated': 'Увійдіть в Orbix.',
        unauthorized: 'Увійдіть в Orbix у цьому ж браузері.',
        'keys not configured': 'Спершу збережіть ключі в Orbix.',
        'symbol not on testnet': 'Цієї пари немає на цій біржі.',
        'invalid symbol': 'Неправильна пара.',
        'leverage 1..20': 'Плече: від 1 до 20×.'
    };
    function mapError(message, code, exchange) {
        const m = String(message || '');
        if (KNOWN[m]) return KNOWN[m];
        if (code === 'withdraw') return 'У ключа ввімкнено право на виведення коштів — Orbix такий ключ не використовує. Створіть на біржі новий ключ без цього дозволу.';
        if (code === -2015 || code === -2014 || code === -1022 || code === 10003 || code === 10004 || /API-key|Invalid API|Signature|API key is invalid|error sign/i.test(m)) {
            return exchange === 'bybit'
                ? 'Bybit не приймає ключі. Перевірте, що ключ створено в режимі Demo Trading, тип — «згенеровані системою» (не RSA).'
                : 'Тестнет не приймає ключі. Перевірте, що ключ з testnet.binancefuture.com і має дозвіл на торгівлю.';
        }
        if (code === 10005 || /Permission denied/i.test(m)) return 'Ключ не має дозволу на торгівлю контрактами.';
        if (/ab not enough|not enough|insufficient/i.test(m) || code === 110007) return 'Недостатньо коштів на демо-рахунку.';
        if (/order too small/.test(m)) return 'Сума менша за мінімальний ордер біржі: ' + m.replace('order too small: min', 'мінімум') + '.';
        if (/Margin is insufficient|-2019/.test(m) || code === -2019) return 'Недостатньо маржі на тестовому рахунку.';
        if (/ReduceOnly/i.test(m)) return 'Немає позиції, яку можна закрити.';
        if (/Not Found|404/.test(m)) return 'Серверна функція біржі недоступна.';
        return 'Біржа: ' + m;
    }

    function describeOrder(b) {
        const ex = EXCHANGES[b.exchange];
        return `${ex.short.toUpperCase()} — ${b.side === 'BUY' ? 'КУПИТИ (Long)' : 'ПРОДАТИ (Short)'} ${b.symbol}\n`
            + `Сума: ${b.notional} USDT з плечем ${b.leverage}× (маржа ≈ ${(b.notional / b.leverage).toFixed(2)} USDT)\n\n`
            + 'Ринковий ордер, БЕЗ СТОПА І ТЕЙКУ на біржі: позицію треба буде закрити вручну.\nДемо-кошти, але ордер справжній для демо-рахунку. Надіслати?';
    }

    const api = { ALLOWED_ACTIONS, LIMITS, EXCHANGES, normSymbol, botPairs, isBlocked, buildBody, canTrade, mapError, describeOrder };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TradeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
