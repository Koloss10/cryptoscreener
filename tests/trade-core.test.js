// Юніт-тести ядра торгової панелі (без мережі й DOM): node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../trade-core.js');

test('only check, positions, order and close can be sent to the exchange function', () => {
    for (const a of ['flat', 'ex_save', 'ex_delete', 'cancel', 'withdraw', '', undefined]) {
        assert.throws(() => T.buildBody('bybit', a, {}), /не дозволена/);
    }
    assert.deepEqual(T.buildBody('bybit', 'check', {}), { exchange: 'bybit', action: 'check' });
    assert.deepEqual(T.buildBody('binance', 'positions', {}), { exchange: 'binance', action: 'positions' });
    assert.deepEqual(T.buildBody('bybit', 'close', { symbol: 'ETHUSDT' }), { exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' });
});

test('order body has exactly the fields the server expects, rounded to cents', () => {
    const b = T.buildBody('bybit', 'order', { symbol: 'BTCUSDT', side: 'BUY', notional: '150.456', leverage: '5' });
    assert.deepEqual(b, { exchange: 'bybit', action: 'order', symbol: 'BTCUSDT', side: 'BUY', notional: 150.46, leverage: 5 });
});

test('order validation rejects bad exchange, symbol, side, size and leverage', () => {
    const ok = { symbol: 'BTCUSDT', side: 'BUY', notional: 100, leverage: 3 };
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

const bot = (symbol, cfg, status = 'running') => ({ symbol, status, config: cfg });

test('botPairs collects pairs of Orbix bots that trade on the exchange, whatever their status', () => {
    const bots = [
        bot('BTC/USDT', { _tn: true, _ex: 'bybit' }),
        bot('ETH/USDT', { _srv: true, _ex: 'bybit' }, 'paused'),
        bot('SOL/USDT', {}),                                   // paper-бот — на біржу не торгує
        bot('XRP/USDT', { _tn: true, _ex: 'binance' }),        // інша біржа
        bot('1000PEPE/USDT', { _srv: true })                   // біржа не вказана — вважаємо будь-якою
    ];
    const set = T.botPairs(bots, 'bybit');
    assert.deepEqual([...set].sort(), ['BTCUSDT', 'ETHUSDT', 'PEPEUSDT']);
    assert.deepEqual([...T.botPairs(bots, 'binance')].sort(), ['PEPEUSDT', 'XRPUSDT']);
});

test('isBlocked matches by normalised symbol', () => {
    const set = T.botPairs([bot('BTC/USDT', { _tn: true, _ex: 'bybit' })], 'bybit');
    assert.equal(T.isBlocked('BTCUSDT', set), true);
    assert.equal(T.isBlocked('ETHUSDT', set), false);
});

const ready = () => ({ signedIn: true, aal: { currentLevel: 'aal2', nextLevel: 'aal2' }, conn: { status: 'active', can_trade: true }, botsLoaded: true });

test('canTrade passes only when signed in, 2FA done, key active with trading rights and bots are known', () => {
    assert.deepEqual(T.canTrade(ready()), { ok: true });
});

test('canTrade explains every blocker with an Orbix instruction', () => {
    const no = ctx => T.canTrade(ctx);
    assert.match(no({ ...ready(), signedIn: false }).reason, /Увійдіть в Orbix/);
    assert.match(no({ ...ready(), aal: { currentLevel: 'aal1', nextLevel: 'aal1' } }).reason, /Увімкніть двофакторний/);
    assert.match(no({ ...ready(), aal: { currentLevel: 'aal1', nextLevel: 'aal2' } }).reason, /кодом з Google Authenticator/);
    assert.match(no({ ...ready(), conn: null }).reason, /ключі/i);
    assert.match(no({ ...ready(), conn: { status: 'invalid', can_trade: false } }).reason, /не приймає/);
    assert.match(no({ ...ready(), conn: { status: 'active', can_trade: false } }).reason, /дозволу на торгівлю/);
    assert.match(no({ ...ready(), botsLoaded: false }).reason, /ботів Orbix/);
});

test('mapError returns Orbix wording for known server errors and never leaks raw HTML', () => {
    assert.match(T.mapError('mfa required', null, 'bybit'), /Google Authenticator/);
    assert.match(T.mapError('keys not configured', null, 'bybit'), /ключі/i);
    assert.match(T.mapError('order too small: min 5.00 USDT', null, 'bybit'), /мінімум 5.00 USDT/);
    assert.match(T.mapError('x', 'withdraw', 'bybit'), /право на виведення/);
    assert.match(T.mapError('API-key is invalid', -2015, 'bybit'), /Demo Trading/);
    assert.match(T.mapError('API-key is invalid', -2015, 'binance'), /testnet/);
    assert.match(T.mapError('ab not enough', null, 'bybit'), /Недостатньо коштів/);
    assert.match(T.mapError('something odd', null, 'bybit'), /^Біржа: something odd/);
    assert.match(T.mapError('unauthorized', null, 'bybit'), /Увійдіть в Orbix/);
});

test('describeOrder produces the confirmation text with exchange, side, pair, size, leverage and the no-stop warning', () => {
    const t = T.describeOrder({ exchange: 'bybit', symbol: 'BTCUSDT', side: 'BUY', notional: 150, leverage: 5 });
    for (const part of ['Bybit Demo', 'КУПИТИ', 'BTCUSDT', '150', '5×', 'без стопа']) assert.ok(t.toLowerCase().includes(part.toLowerCase()), part + ' in: ' + t);
});
