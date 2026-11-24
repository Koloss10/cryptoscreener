// Перевірка запиту до функції `exchange`: чисті функції без мережі (тести: tests/exchange-function.test.mjs).
// Обмеження суворіші за Orbix (у нього до 100000 USDT і плече 20×): це серверні межі, а не лише клієнтські.
export const LIMITS = { minNotional: 5, maxNotional: 5000, maxLeverage: 10 };

const EXCHANGES = ['bybit', 'binance'];
const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;
const LINK = /^cs[0-9a-f]{20}$/;         // ідентифікатор ордера клієнта: дозволяє дізнатись долю ордера (action: status)
const bad = (error, status = 400) => ({ ok: false, status, error });

// { ok: true, req } або { ok: false, status, error }. «balance» — синонім «check».
export function parseRequest(body) {
    if (!body || typeof body !== 'object') return bad('invalid request');
    const exchange = body.exchange;
    if (!EXCHANGES.includes(exchange)) return bad('unsupported exchange');
    const action = body.action === 'balance' ? 'check' : body.action;
    if (!['check', 'positions', 'order', 'close', 'status'].includes(action)) return bad('unknown action');
    if (action === 'check' || action === 'positions') return { ok: true, req: { exchange, action } };

    const symbol = body.symbol;
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) return bad('invalid symbol');
    if (action === 'close') return { ok: true, req: { exchange, action, symbol } };

    const link = body.link;
    if (typeof link !== 'string' || !LINK.test(link)) return bad('invalid link');
    if (action === 'status') return { ok: true, req: { exchange, action, symbol, link } };

    const side = body.side;
    if (side !== 'BUY' && side !== 'SELL') return bad('invalid side');
    const notional = Number(body.notional);
    if (!Number.isFinite(notional) || notional < LIMITS.minNotional || notional > LIMITS.maxNotional) return bad('invalid notional');
    const leverage = Number(body.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > LIMITS.maxLeverage) return bad('invalid leverage');
    return { ok: true, req: { exchange, action, symbol, side, notional: Math.round(notional * 100) / 100, leverage, link } };
}
