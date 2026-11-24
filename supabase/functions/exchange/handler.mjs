// Логіка функції `exchange` без Deno і мережі: усі залежності передаються ззовні (index.ts звʼязує їх із Supabase).
// Тести: tests/exchange-function.test.mjs.
import { parseRequest } from './guard.mjs';

export const MOVE_GAP_MS = 2000;           // order/close: не частіше одного на 2 с (атомарно, у базі) і лише поки попередній не завершився
export const READ_GAP_MS = 1000;           // check/positions/status: не частіше одного на секунду (захист спільної IP-адреси сервера)
const MAX_ERROR = 300;
const GENERIC = 'exchange request failed';

const cors = (origin, allowed) => (origin && allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'POST, OPTIONS' }
    : { vary: 'Origin' });
const reply = (status, body, headers) => ({ status, body, headers });
// Дослівно віддаємо лише повідомлення бірж (ExErr.expose); усе інше (мережа, база, стек) — загальний текст
const publicMessage = e => (e && e.expose === true ? String(e.message ?? '').slice(0, MAX_ERROR) : GENERIC);
const quietly = async fn => { try { await fn(); } catch (e) { console.error('non-fatal:', e && e.message); } };

// req: { method, origin, hasAuth, readBody() }; deps — див. tests/exchange-function.test.mjs (deps())
export async function handle(req, deps) {
    const headers = cors(req.origin, deps.allowedOrigins);
    if (req.method === 'OPTIONS') return reply(204, undefined, headers);
    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' }, headers);
    try {
        const user = await deps.getUser();
        if (!user) return reply(401, { error: 'unauthorized' }, headers);
        // 2FA обовʼязкова для будь-якої дії, включно з читанням (суворіше за Orbix)
        if (!(await deps.mfaOk())) return reply(403, { error: 'mfa required' }, headers);

        const parsed = parseRequest(await req.readBody());     // тіло читаємо лише після автентифікації
        if (!parsed.ok) return reply(parsed.status, { error: parsed.error }, headers);
        const r = parsed.req;

        const keys = await deps.secretsFor(user.id, r.exchange);
        if (!keys) return reply(404, { error: 'keys not configured' }, headers);
        // Ключ, що не пройшов перевірку (check), крім самої перевірки ні для чого не використовується
        if (r.action !== 'check' && keys.status !== 'active') return reply(403, { error: 'key not verified' }, headers);
        const ex = deps.makeExchange(r.exchange, keys.key, keys.secret);

        return await run(r, user, keys, ex, deps, headers);
    } catch (e) {
        console.error('exchange handler failed:', e && e.message);   // деталі лише в журналі сервера
        return reply(500, { error: 'internal error' }, headers);
    }
}

async function run(r, user, keys, ex, deps, headers) {
    const moves = r.action === 'order' || r.action === 'close';
    const logId = await deps.claim({ user_id: user.id, exchange: r.exchange, action: r.action, symbol: r.symbol ?? null, side: r.side ?? null,
        notional: r.notional ?? null, leverage: r.leverage ?? null, link: r.link ?? null, gapMs: moves ? MOVE_GAP_MS : READ_GAP_MS });
    if (logId === null) return reply(429, { error: 'too many requests' }, headers);

    // результат уже відомий — збій журналу не може змінити відповідь
    const done = async (status, body) => { await quietly(() => deps.finish(logId, status < 400, status < 400 ? null : body.error)); return reply(status, body, headers); };
    try {
        if (r.action === 'check') {
            const a = await ex.check();
            // ключ із правом виведення відхиляється, сервер його більше не використовує (збій запису статусу відповідь не змінює)
            if (a.withdraw) { await quietly(() => deps.setStatus(keys.connId, 'revoked', false)); return await done(403, { error: 'withdraw permission', code: 'withdraw' }); }
            await quietly(() => deps.setStatus(keys.connId, 'active', a.canTrade));
            return await done(200, { ok: true, ...a });
        }
        if (r.action === 'positions') return await done(200, { ok: true, positions: await ex.positions() });
        if (r.action === 'status') return await done(200, { ok: true, order: await ex.byLink(r.symbol, r.link) });
        if (r.action === 'order') return await done(200, { ok: true, order: await deps.marketNotional(ex, r.symbol, r.side, r.notional, r.leverage, r.link) });
        const order = await deps.closePosition(ex, r.symbol);
        return await done(200, order ? { ok: true, closed: true, order } : { ok: true, closed: false });
    } catch (e) {
        const code = e && e.code !== undefined ? e.code : null;
        if (!(e && e.expose === true)) console.error('exchange call failed:', e && e.message);   // сирий текст лише в журналі сервера
        if (ex.invalid(code)) await quietly(() => deps.setStatus(keys.connId, 'invalid', false));
        else if (ex.noPerm(code)) await quietly(() => deps.setStatus(keys.connId, 'active', false));
        return await done(502, { error: publicMessage(e), code: e && e.expose === true ? code : null });
    }
}
