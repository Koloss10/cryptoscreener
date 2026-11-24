// Тести логіки Edge Function `exchange` з підробленими залежностями: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, LIMITS } from '../supabase/functions/exchange/guard.mjs';
import { handle } from '../supabase/functions/exchange/handler.mjs';
import { sign, floorStep } from '../supabase/functions/exchange/sign.js';

const LINK = 'cs0123456789abcdef0123';
const order = (o = {}) => ({ exchange: 'bybit', action: 'order', symbol: 'ETHUSDT', side: 'BUY', notional: 150, leverage: 5, link: LINK, ...o });

test('parseRequest accepts a valid order and normalises numbers', () => {
    const r = parseRequest(order({ notional: '150.456', leverage: '5' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.req, { exchange: 'bybit', action: 'order', symbol: 'ETHUSDT', side: 'BUY', notional: 150.46, leverage: 5, link: LINK });
});

test('parseRequest enforces server-side caps stricter than Orbix (5000 USDT, 10x)', () => {
    assert.equal(LIMITS.maxNotional, 5000); assert.equal(LIMITS.maxLeverage, 10);
    for (const bad of [{ notional: 5001 }, { notional: 0 }, { notional: 'x' }, { leverage: 11 }, { leverage: 0 }, { leverage: 2.5 }, { leverage: undefined }]) {
        const r = parseRequest(order(bad));
        assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.status, 400);
    }
});

test('parseRequest rejects unknown exchange (no silent default), unknown action, bad symbol, bad side, bad link', () => {
    assert.equal(parseRequest(order({ exchange: 'okx' })).ok, false);
    assert.equal(parseRequest(order({ exchange: undefined })).ok, false);
    for (const a of ['flat', 'ex_save', 'withdraw', '', undefined, 'ORDER']) assert.equal(parseRequest(order({ action: a })).ok, false, String(a));
    for (const s of ['btcusdt', 'BTC/USDT', 'BTCUSD', 'USDT', 'A'.repeat(30) + 'USDT', undefined]) assert.equal(parseRequest(order({ symbol: s })).ok, false, String(s));
    assert.equal(parseRequest(order({ side: 'HOLD' })).ok, false);
    for (const l of [undefined, '', 'abc', 'cs' + 'g'.repeat(20), 'cs0123456789abcdef0']) assert.equal(parseRequest(order({ link: l })).ok, false, String(l));
    assert.equal(parseRequest(null).ok, false);
});

test('parseRequest: check/positions need nothing else; close needs a symbol; status needs symbol and link', () => {
    assert.deepEqual(parseRequest({ exchange: 'binance', action: 'check' }).req, { exchange: 'binance', action: 'check' });
    assert.deepEqual(parseRequest({ exchange: 'bybit', action: 'balance' }).req, { exchange: 'bybit', action: 'check' });
    assert.equal(parseRequest({ exchange: 'bybit', action: 'positions' }).ok, true);
    assert.equal(parseRequest({ exchange: 'bybit', action: 'close' }).ok, false);
    assert.deepEqual(parseRequest({ exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' }).req, { exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' });
    assert.equal(parseRequest({ exchange: 'bybit', action: 'status', symbol: 'ETHUSDT' }).ok, false);
    assert.equal(parseRequest({ exchange: 'bybit', action: 'status', symbol: 'ETHUSDT', link: LINK }).ok, true);
});

// ---------- handle(): підроблені залежності ----------
function deps(over = {}) {
    const calls = { claim: [], finish: [], status: [], exchange: [], market: [], close: [] };
    const ex = {
        check: async () => ({ canTrade: true, withdraw: false, wallet: 1000, available: 900, unrealized: 5 }),
        positions: async () => [{ symbol: 'ETHUSDT', amt: 1, entry: 1, mark: 1, pnl: 0, lev: 3, liq: 0 }],
        byLink: async (symbol, link) => ({ id: 1, symbol, side: 'BUY', qty: 0.1, price: 1700, status: 'Filled', link }),
        invalid: code => code === 10003, noPerm: code => code === 10005
    };
    const d = {
        allowedOrigins: ['https://koloss10.github.io'],
        getUser: async () => ({ id: 'u1' }),
        mfaOk: async () => true,
        secretsFor: async (uid, exchange) => { calls.exchange.push(['secrets', uid, exchange]); return { connId: 'c1', key: 'K', secret: 'S', status: 'active' }; },
        makeExchange: () => ex,
        marketNotional: async (e, symbol, side, notional, lev, link) => { calls.market.push({ symbol, side, notional, lev, link }); return { id: 9, symbol, side, qty: 0.08, price: 1712.3, status: 'Filled', link }; },
        closePosition: async (e, symbol) => { calls.close.push(symbol); return { id: 10, symbol, side: 'SELL', qty: 1, price: 1, status: 'Filled' }; },
        setStatus: async (connId, status, canTrade) => { calls.status.push([connId, status, canTrade]); },
        claim: async entry => { calls.claim.push(entry); return 77; },
        finish: async (id, ok, error) => { calls.finish.push([id, ok, error]); },
        ...over
    };
    return { d, calls, ex };
}
const exErr = (message, code = null) => Object.assign(new Error(message), { code, expose: true });   // як ExErr з exchanges.ts
const req = (body, extra = {}) => ({ method: 'POST', origin: 'https://koloss10.github.io', hasAuth: true, readBody: async () => body, ...extra });

test('CORS: preflight answers only for allowed origins; others get no allow-origin header', async () => {
    const { d } = deps();
    const ok = await handle({ method: 'OPTIONS', origin: 'https://koloss10.github.io', hasAuth: false, readBody: async () => null }, d);
    assert.equal(ok.status, 204); assert.equal(ok.body, undefined); assert.equal(ok.headers['access-control-allow-origin'], 'https://koloss10.github.io');
    const bad = await handle({ method: 'OPTIONS', origin: 'https://evil.example', hasAuth: false, readBody: async () => null }, d);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
});

test('only POST is accepted', async () => {
    assert.equal((await handle(req(null, { method: 'GET' }), deps().d)).status, 405);
});

test('no user -> 401 and nothing else is touched', async () => {
    const { d, calls } = deps({ getUser: async () => null });
    const r = await handle(req(order()), d);
    assert.equal(r.status, 401);
    assert.equal(calls.exchange.length, 0); assert.equal(calls.claim.length, 0);
});

test('2FA is mandatory for every action, including read-only ones', async () => {
    for (const body of [order(), { exchange: 'bybit', action: 'positions' }, { exchange: 'bybit', action: 'check' }]) {
        const { d, calls } = deps({ mfaOk: async () => false });
        const r = await handle(req(body), d);
        assert.equal(r.status, 403); assert.equal(r.body.error, 'mfa required');
        assert.equal(calls.exchange.length, 0);
    }
});

test('invalid requests are rejected with 400 before keys are fetched', async () => {
    const { d, calls } = deps();
    const r = await handle(req(order({ notional: 99999 })), d);
    assert.equal(r.status, 400);
    assert.equal(calls.exchange.length, 0);
});

test('missing keys -> 404', async () => {
    const { d } = deps({ secretsFor: async () => null });
    const r = await handle(req({ exchange: 'bybit', action: 'positions' }), d);
    assert.equal(r.status, 404); assert.equal(r.body.error, 'keys not configured');
});

test('order: slot is claimed first, the exchange is called once with the link, and the result is logged as ok', async () => {
    const { d, calls } = deps();
    const r = await handle(req(order()), d);
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.order.price, 1712.3);
    assert.equal(calls.claim.length, 1);
    assert.equal(calls.claim[0].link, LINK); assert.equal(calls.claim[0].action, 'order');
    assert.deepEqual(calls.market, [{ symbol: 'ETHUSDT', side: 'BUY', notional: 150, lev: 5, link: LINK }]);
    assert.deepEqual(calls.finish, [[77, true, null]]);
});

test('order is refused with 429 when the slot is taken, and the exchange is never called', async () => {
    const { d, calls } = deps({ claim: async () => null });
    const r = await handle(req(order()), d);
    assert.equal(r.status, 429);
    assert.equal(calls.market.length, 0);
});

test('order failure is a 502 with the exchange message, logged as failed; invalid key marks the connection', async () => {
    const err = exErr('API key is invalid', 10003);
    const { d, calls } = deps({ marketNotional: async () => { throw err; } });
    const r = await handle(req(order()), d);
    assert.equal(r.status, 502); assert.equal(r.body.error, 'API key is invalid'); assert.equal(r.body.code, 10003);
    assert.deepEqual(calls.status, [['c1', 'invalid', false]]);
    assert.deepEqual(calls.finish, [[77, false, 'API key is invalid']]);
});

test('no-permission errors keep the key active but flag can_trade=false', async () => {
    const err = exErr('Permission denied', 10005);
    const { d, calls } = deps({ marketNotional: async () => { throw err; } });
    await handle(req(order()), d);
    assert.deepEqual(calls.status, [['c1', 'active', false]]);
});

test('close goes through the same slot claim and only closes the requested symbol', async () => {
    const { d, calls } = deps();
    const r = await handle(req({ exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' }), d);
    assert.equal(r.status, 200); assert.equal(r.body.closed, true);
    assert.deepEqual(calls.close, ['ETHUSDT']); assert.equal(calls.claim[0].action, 'close');
});

test('close with no position answers closed:false', async () => {
    const { d } = deps({ closePosition: async () => null });
    const r = await handle(req({ exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' }), d);
    assert.deepEqual(r.body, { ok: true, closed: false });
});

test('check: a key with withdraw permission is revoked and refused', async () => {
    const { d, calls, ex } = deps();
    ex.check = async () => ({ canTrade: true, withdraw: true, wallet: 1, available: 1, unrealized: 0 });
    const r = await handle(req({ exchange: 'bybit', action: 'check' }), d);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'withdraw');
    assert.deepEqual(calls.status, [['c1', 'revoked', false]]);
});

test('check: a healthy key is marked active with its trade permission', async () => {
    const { d, calls } = deps();
    const r = await handle(req({ exchange: 'bybit', action: 'check' }), d);
    assert.equal(r.body.wallet, 1000);
    assert.deepEqual(calls.status, [['c1', 'active', true]]);
});

test('status looks the order up by its link (read-only)', async () => {
    const { d, calls } = deps();
    const r = await handle(req({ exchange: 'bybit', action: 'status', symbol: 'ETHUSDT', link: LINK }), d);
    assert.equal(r.body.order.link, LINK); assert.equal(calls.claim[0].action, 'status');
});

test('status answers order:null when the exchange has no such order', async () => {
    const { d, ex } = deps(); ex.byLink = async () => null;
    const r = await handle(req({ exchange: 'bybit', action: 'status', symbol: 'ETHUSDT', link: LINK }), d);
    assert.deepEqual(r.body, { ok: true, order: null });
});

test('unexpected internal errors give 500 without leaking stack traces', async () => {
    const { d } = deps({ getUser: async () => { throw new Error('db exploded at /srv/secret/path.ts:12'); } });
    const r = await handle(req(order()), d);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'internal error');
});

test('exchange error messages are length-limited', async () => {
    const { d } = deps({ marketNotional: async () => { throw exErr('x'.repeat(2000)); } });
    const r = await handle(req(order()), d);
    assert.ok(r.body.error.length <= 300);
});

test('signing matches the Binance documentation example and floorStep rounds down to the exchange step', async () => {
    const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
    assert.equal(await sign(q, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
    assert.equal(floorStep(0.0171, 0.01), 0.01);
});

test('non-exchange errors (network, database, stack text) are never echoed to the client', async () => {
    const leak = new Error('error sending request for url (https://testnet.binancefuture.com/fapi/v1/order?symbol=X&signature=abc123)');
    const { d, calls } = deps({ marketNotional: async () => { throw leak; } });
    const r = await handle(req(order()), d);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'exchange request failed');
    assert.doesNotMatch(JSON.stringify(r.body), /signature|binancefuture/);
    assert.deepEqual(calls.finish, [[77, false, 'exchange request failed']]);              // і в журнал сирий текст не пишемо
});

test('the body is read only after the user and 2FA are verified', async () => {
    let reads = 0;
    const counted = (extra = {}) => ({ ...req(order()), readBody: async () => { reads++; return order(); }, ...extra });
    await handle(counted(), deps({ getUser: async () => null }).d);
    await handle(counted(), deps({ mfaOk: async () => false }).d);
    assert.equal(reads, 0);
    await handle(counted(), deps().d);
    assert.equal(reads, 1);
});

test('a key that has not passed «check» is not used for anything except check (status must be active)', async () => {
    for (const body of [order(), { exchange: 'bybit', action: 'positions' }, { exchange: 'bybit', action: 'close', symbol: 'ETHUSDT' },
        { exchange: 'bybit', action: 'status', symbol: 'ETHUSDT', link: LINK }]) {
        const { d, calls } = deps({ secretsFor: async () => ({ connId: 'c1', key: 'K', secret: 'S', status: 'pending' }) });
        const r = await handle(req(body), d);
        assert.equal(r.status, 403, JSON.stringify(body)); assert.equal(r.body.error, 'key not verified');
        assert.equal(calls.market.length, 0); assert.equal(calls.close.length, 0);
    }
    const { d } = deps({ secretsFor: async () => ({ connId: 'c1', key: 'K', secret: 'S', status: 'pending' }) });
    assert.equal((await handle(req({ exchange: 'bybit', action: 'check' }), d)).status, 200);     // check — єдина дія для неперевіреного ключа
});

test('read-only actions are throttled too, with a shorter gap, and finish as ok', async () => {
    const { d, calls } = deps();
    await handle(req({ exchange: 'bybit', action: 'positions' }), d);
    assert.equal(calls.claim.length, 1);
    assert.equal(calls.claim[0].action, 'positions'); assert.equal(calls.claim[0].gapMs, 1000);
    assert.deepEqual(calls.finish, [[77, true, null]]);
    const refused = await handle(req({ exchange: 'bybit', action: 'check' }), deps({ claim: async () => null }).d);
    assert.equal(refused.status, 429);
});

test('moves use the longer 2s gap', async () => {
    const { d, calls } = deps();
    await handle(req(order()), d);
    assert.equal(calls.claim[0].gapMs, 2000);
});

test('revoking a withdraw-enabled key still answers 403 even if saving the status fails', async () => {
    const { d, ex } = deps({ setStatus: async () => { throw new Error('db down'); } });
    ex.check = async () => ({ canTrade: true, withdraw: true, wallet: 1, available: 1, unrealized: 0 });
    const r = await handle(req({ exchange: 'bybit', action: 'check' }), d);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'withdraw');
});

test('a logging failure after a successful order cannot turn it into an error response', async () => {
    const { d } = deps({ finish: async () => { throw new Error('log down'); } });
    const r = await handle(req(order()), d);
    assert.equal(r.status, 200); assert.equal(r.body.ok, true);
});
