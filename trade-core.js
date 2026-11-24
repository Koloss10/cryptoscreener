// Ядро торгової панелі: перевірки, тіло запитів до серверної функції `exchange`, тексти помилок.
// Чисті функції без DOM і мережі. Тести: tests/trade-core.test.js.
// ВАЖЛИВО: ключі бірж у браузері не зберігаються. Їх вводять у форму один раз, вони йдуть у Supabase Vault (власний проєкт
// скрінера) і до браузера не повертаються; ордери надсилає серверна функція `exchange` (Bybit Demo / Binance Futures
// Testnet — адреси зашиті на сервері).
(function (root) {
    'use strict';

    // Лише ці дії (сервер ті самі й приймає).
    const ALLOWED_ACTIONS = ['check', 'positions', 'order', 'close', 'status'];
    // Суворіше за сервер (він дозволяє до 100000 USDT і плече до 20×)
    const LIMITS = { minNotional: 5, maxNotional: 5000, maxLeverage: 10 };
    const EXCHANGES = {
        bybit: { name: 'Bybit Demo Trading', short: 'Bybit Demo' },
        binance: { name: 'Binance Futures Testnet', short: 'тестнет Binance' }
    };
    const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;          // як на сервері (exchanges.ts)
    const LINK = /^cs[0-9a-f]{20}$/;                // ідентифікатор ордера: за ним можна дізнатись долю ордера (action: status)

    // Пари Orbix (BTC/USDT, 1000PEPE/USDT) і символи біржі (BTCUSDT, 1000PEPEUSDT) приводимо до одного вигляду
    const normSymbol = s => String(s || '').replace('/', '').toUpperCase().replace(/^1000+/, '');

    // Пари, якими користувач заборонив торгувати вручну (наприклад, де працює бот Orbix на тих самих демо-ключах).
    // Біржа веде одну позицію на пару, тож ручна угода зіллється з ботовою.
    function parseBlocklist(text) {
        return new Set(String(text || '').split(/[\s,;]+/).filter(Boolean).map(normSymbol));
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
        if (typeof p.link !== 'string' || !LINK.test(p.link)) throw new Error('Неправильний ідентифікатор ордера.');
        if (action === 'status') return { exchange, action, symbol, link: p.link };
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
        return { exchange, action, symbol, side, notional: Math.round(notional * 100) / 100, leverage, link: p.link };
    }

    // Чи можна торгувати: перший блокер із підказкою, що зробити на цій сторінці
    function canTrade(ctx) {
        if (!ctx.signedIn) return { ok: false, reason: 'Увійдіть або створіть акаунт нижче: ключі й ордери доступні лише після входу.' };
        const a = ctx.aal || {};
        if (a.currentLevel !== 'aal2') {
            return { ok: false, reason: a.nextLevel === 'aal2'
                ? 'Підтвердіть вхід: введіть код з Google Authenticator нижче.'
                : 'Увімкніть двофакторний вхід (2FA) нижче: торгова панель працює лише з 2FA.' };
        }
        if (!ctx.conn) return { ok: false, reason: 'Збережіть ключі біржі (форма «Ключі біржі» нижче): ключі йдуть на сервер, у браузері не лишаються.' };
        if (ctx.conn.status !== 'active') return { ok: false, reason: 'Біржа не приймає збережені ключі (статус: ' + ctx.conn.status + '). Натисніть «Баланс і перевірка ключа» або збережіть нові.' };
        if (!ctx.conn.can_trade) return { ok: false, reason: 'У ключа немає дозволу на торгівлю контрактами. Збережіть ключ із правом торгівлі.' };
        return { ok: true };
    }

    // Тексти помилок: ті самі формулювання, що в Orbix (src/js/19-testnet.js)
    const KNOWN = {
        'invalid key format': 'Ключі мають вигляд довгого рядка з латинських літер і цифр.',
        'mfa required': 'Спершу підтвердьте вхід кодом з Google Authenticator.',
        'too many requests': 'Занадто часто: зачекайте кілька секунд між ордерами.',
        'unsupported exchange': 'Невідома біржа.',
        'not authenticated': 'Увійдіть в акаунт.',
        unauthorized: 'Увійдіть в акаунт.',
        'keys not configured': 'Спершу збережіть ключі біржі.',
        'symbol not on testnet': 'Цієї пари немає на цій біржі.',
        'invalid symbol': 'Неправильна пара.',
        'leverage 1..20': 'Плече: від 1 до 20×.'
    };
    function mapError(message, code, exchange) {
        const m = String(message || '');
        if (KNOWN[m]) return KNOWN[m];
        if (code === 'withdraw') return 'У ключа ввімкнено право на виведення коштів — скринер такий ключ не використовує. Створіть на біржі новий ключ без цього дозволу.';
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

    // Тексти помилок входу Supabase Auth (повідомлення не вставляємо в HTML: екранування — на стороні виводу)
    function mapAuthError(message) {
        const m = String(message || '');
        if (/Invalid login credentials/i.test(m)) return 'Невірна пошта або пароль.';
        if (/Email not confirmed/i.test(m)) return 'Підтвердіть пошту (лист від Supabase) і спробуйте знову.';
        if (/already registered|already been registered/i.test(m)) return 'Такий акаунт уже існує: натисніть «Увійти».';
        if (/Signups? not allowed|signups are disabled/i.test(m)) return 'Реєстрацію вимкнено: акаунт уже створено власником. Натисніть «Увійти».';
        if (/Password should be at least|weak password|at least \d+ characters/i.test(m)) return 'Пароль: щонайменше 8 символів.';
        if (/Invalid TOTP|invalid.*code|expired/i.test(m)) return 'Невірний код 2FA. Спробуйте новий код із застосунку.';
        if (/rate limit|too many|over_.*_rate_limit/i.test(m)) return 'Забагато спроб: зачекайте хвилину.';
        return 'Помилка входу: ' + m;
    }
    const cleanTotp = s => { const c = String(s || '').replace(/\s+/g, ''); return /^\d{6}$/.test(c) ? c : null; };

    function describeOrder(b) {
        const ex = EXCHANGES[b.exchange];
        return `${ex.short.toUpperCase()} — ${b.side === 'BUY' ? 'КУПИТИ (Long)' : 'ПРОДАТИ (Short)'} ${b.symbol}\n`
            + `Сума: ${b.notional} USDT з плечем ${b.leverage}× (маржа ≈ ${(b.notional / b.leverage).toFixed(2)} USDT)\n\n`
            + 'Ринковий ордер, БЕЗ СТОПА І ТЕЙКУ на біржі: позицію треба буде закрити вручну.\nДемо-кошти, але ордер справжній для демо-рахунку. Надіслати?';
    }

    const api = { ALLOWED_ACTIONS, LIMITS, EXCHANGES, normSymbol, parseBlocklist, isBlocked, buildBody, canTrade, mapError, mapAuthError, cleanTotp, describeOrder };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TradeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
