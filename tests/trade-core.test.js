// Юніт-тести ядра торгової панелі (без мережі й DOM): node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../trade-core.js');
const LINK = 'cs0123456789abcdef0123';

test('only check, positions, order, close and status can be sent to the exchange function', () => {
    for (const a of ['flat', 'ex_save', 'ex_delete', 'cancel', 'withdraw', '', undefined]) {
        assert.throws(() => T.buildBody('bybit', a, {}), /не дозволена/);
    }
    assert.deepEqual(T.buildBody('bybit', 'check', {}), { exchange: 'bybit', action: 'check' });
    assert.deepEqual(T.buildBody('binance', 'positions', {}), { exchange: 'binance', action: 'positions' });
    assert.deepEqual(T.buildBody('bybit', 'close', { symbol: 'ETHUSDT' }), { exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' });
    assert.deepEqual(T.buildBody('bybit', 'status', { symbol: 'ETHUSDT', link: LINK }), { exchange: 'bybit', action: 'status', symbol: 'ETHUSDT', link: LINK });
});

test('order body has exactly the fields the server expects, rounded to cents', () => {
    const b = T.buildBody('bybit', 'order', { symbol: 'BTCUSDT', side: 'BUY', notional: '150.456', leverage: '5', link: LINK });
    assert.deepEqual(b, { exchange: 'bybit', action: 'order', symbol: 'BTCUSDT', side: 'BUY', notional: 150.46, leverage: 5, link: LINK });
});

test('order validation rejects bad exchange, symbol, side, size and leverage', () => {
    const ok = { symbol: 'BTCUSDT', side: 'BUY', notional: 100, leverage: 3, link: LINK };
    assert.throws(() => T.buildBody('okx', 'order', ok), /біржа/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, symbol: 'btcusdt' }), /пара/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, symbol: 'BTC/USDT' }), /пара/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, side: 'HOLD' }), /напрям/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, notional: 0 }), /сума/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, notional: T.LIMITS.maxNotional + 1 }), /сума/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, notional: 'abc' }), /сума/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, leverage: 0 }), /плече/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, leverage: T.LIMITS.maxLeverage + 1 }), /плече/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, leverage: 2.5 }), /плече/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, link: '' }), /ідентифікатор/i);
    assert.throws(() => T.buildBody('bybit', 'order', { ...ok, link: 'cs123' }), /ідентифікатор/i);
    assert.throws(() => T.buildBody('bybit', 'status', { symbol: 'BTCUSDT' }), /ідентифікатор/i);
});

test('the client cap is stricter than the server cap (server allows 100000 and leverage 20)', () => {
    assert.ok(T.LIMITS.maxNotional <= 5000);
    assert.ok(T.LIMITS.maxLeverage <= 10);
});

test('normSymbol makes Orbix pairs (BTC/USDT) and exchange symbols (BTCUSDT, 1000PEPEUSDT) comparable', () => {
    assert.equal(T.normSymbol('BTC/USDT'), 'BTCUSDT');
    assert.equal(T.normSymbol('btcusdt'), 'BTCUSDT');
    assert.equal(T.normSymbol('1000PEPEUSDT'), 'PEPEUSDT');
    assert.equal(T.normSymbol('PEPE/USDT'), 'PEPEUSDT');
});

test('parseBlocklist reads pairs separated by commas, spaces or new lines, in any case and with slashes', () => {
    const set = T.parseBlocklist('btc/usdt, ETHUSDT\n 1000pepeusdt;;  ');
    assert.deepEqual([...set].sort(), ['BTCUSDT', 'ETHUSDT', 'PEPEUSDT']);
    assert.equal(T.parseBlocklist('').size, 0);
    assert.equal(T.parseBlocklist(undefined).size, 0);
});

test('isBlocked matches by normalised symbol', () => {
    const set = T.parseBlocklist('BTC/USDT');
    assert.equal(T.isBlocked('BTCUSDT', set), true);
    assert.equal(T.isBlocked('ETHUSDT', set), false);
});

const ready = () => ({ signedIn: true, aal: { currentLevel: 'aal2', nextLevel: 'aal2' }, conn: { status: 'active', can_trade: true } });

test('canTrade passes only when signed in, 2FA done, key active with trading rights and bots are known', () => {
    assert.deepEqual(T.canTrade(ready()), { ok: true });
});

test('canTrade explains every blocker with an instruction for this page', () => {
    const no = ctx => T.canTrade(ctx);
    assert.match(no({ ...ready(), signedIn: false }).reason, /Увійдіть або створіть акаунт/);
    assert.match(no({ ...ready(), aal: { currentLevel: 'aal1', nextLevel: 'aal1' } }).reason, /Увімкніть двофакторний/);
    assert.match(no({ ...ready(), aal: { currentLevel: 'aal1', nextLevel: 'aal2' } }).reason, /код з Google Authenticator/);
    assert.match(no({ ...ready(), conn: null }).reason, /Збережіть ключі/);
    assert.match(no({ ...ready(), conn: { status: 'invalid', can_trade: false } }).reason, /не приймає/);
    assert.match(no({ ...ready(), conn: { status: 'active', can_trade: false } }).reason, /дозволу на торгівлю/);
});

test('mapAuthError translates Supabase auth messages and never echoes raw HTML', () => {
    assert.match(T.mapAuthError('Invalid login credentials'), /Невірна пошта або пароль/);
    assert.match(T.mapAuthError('Email not confirmed'), /Підтвердіть пошту/);
    assert.match(T.mapAuthError('User already registered'), /уже існує/);
    assert.match(T.mapAuthError('Signups not allowed for this instance'), /Реєстрацію вимкнено/);
    assert.match(T.mapAuthError('Password should be at least 8 characters'), /щонайменше 8/);
    assert.match(T.mapAuthError('Invalid TOTP code entered'), /Невірний код/);
    assert.match(T.mapAuthError('email rate limit exceeded'), /Забагато спроб/);
    assert.match(T.mapAuthError('weird <b>x</b>'), /weird/);
});

test('isValidTotp accepts exactly 6 digits (spaces ignored)', () => {
    assert.equal(T.cleanTotp('123 456'), '123456');
    assert.equal(T.cleanTotp('12345'), null);
    assert.equal(T.cleanTotp('1234567'), null);
    assert.equal(T.cleanTotp('12a456'), null);
});

test('mapError returns Orbix wording for known server errors and never leaks raw HTML', () => {
    assert.match(T.mapError('mfa required', null, 'bybit'), /Google Authenticator/);
    assert.match(T.mapError('keys not configured', null, 'bybit'), /ключі/i);
    assert.match(T.mapError('too many requests', null, 'bybit'), /Занадто часто/);
    assert.match(T.mapError('order too small: min 5.00 USDT', null, 'bybit'), /мінімум 5.00 USDT/);
    assert.match(T.mapError('x', 'withdraw', 'bybit'), /право на виведення/);
    assert.match(T.mapError('API-key is invalid', -2015, 'bybit'), /Demo Trading/);
    assert.match(T.mapError('API-key is invalid', -2015, 'binance'), /testnet/);
    assert.match(T.mapError('ab not enough', null, 'bybit'), /Недостатньо коштів/);
    assert.match(T.mapError('something odd', null, 'bybit'), /^Біржа: something odd/);
    assert.match(T.mapError('unauthorized', null, 'bybit'), /Увійдіть/);
});

test('describeOrder produces the confirmation text with exchange, side, pair, size, leverage and the no-stop warning', () => {
    const t = T.describeOrder({ exchange: 'bybit', symbol: 'BTCUSDT', side: 'BUY', notional: 150, leverage: 5 });
    for (const part of ['Bybit Demo', 'КУПИТИ', 'BTCUSDT', '150', '5×', 'без стопа']) assert.ok(t.toLowerCase().includes(part.toLowerCase()), part + ' in: ' + t);
});

test('normSymbol and the blocklist accept the common ways of writing a pair', () => {
    for (const v of ['BTC', 'btc-usdt', 'BTC_USDT', 'BTCUSDT.P', 'BINANCE:BTCUSDT', 'BTC/USDT:USDT', ' BTCUSDT ']) assert.equal(T.normSymbol(v), 'BTCUSDT', v);
    assert.equal(T.normSymbol('1MBABYDOGE'), 'BABYDOGEUSDT');
    assert.equal(T.normSymbol('1000PEPE/USDT'), 'PEPEUSDT');
    assert.equal(T.isBlocked('ETHUSDT', T.parseBlocklist('BTC, eth')), true);
    assert.equal(T.isBlocked('SOLUSDT', T.parseBlocklist('BTC, eth')), false);
});
