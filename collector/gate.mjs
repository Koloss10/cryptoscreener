// Gate USDT-перпетуали (публічний API v4, без ключів). Розмір у контрактах: монет у контракті = quanto_multiplier.
import { collectGeneric, makeGet, num } from './common.mjs';

export const GATE = 'https://api.gateio.ws';
export const validate = j => { if (j && j.label) throw new Error(`${j.label} ${j.message || ''}`); return j; };
const toSymbol = contract => contract.replace(/_USDT$/, '') + 'USDT';

export function parseTickers(data) {
    const rows = [];
    for (const t of data) {
        const last = num(t.last), chg = num(t.change_percentage), vol = num(t.volume_24h_quote), mult = num(t.quanto_multiplier);
        if (!/^[A-Z0-9]+_USDT$/.test(t.contract) || !(last > 0) || chg === null || vol === null || !(mult > 0)) continue;
        const size = num(t.total_size), mark = num(t.mark_price) || last;
        rows.push({ s: toSymbol(t.contract), contract: t.contract, mult, last, chg24h: chg, volUsd: Math.round(vol), oiUsd: size === null ? null : Math.round(size * mult * mark), fund: num(t.funding_rate) });
    }
    return rows.sort((a, b) => b.volUsd - a.volUsd);
}

export const collect = (opts = {}) => {
    const get = makeGet(GATE, validate, opts.fetchFn);
    return collectGeneric({
        ...opts, ex: 'gate',
        loadTickers: async () => parseTickers(await get('/api/v4/futures/usdt/tickers')),
        loadBook: async row => {
            const d = await get(`/api/v4/futures/usdt/order_book?contract=${row.contract}&limit=300`);
            const lv = side => (side || []).map(x => [x.p, x.s]);
            return { bids: lv(d.bids), asks: lv(d.asks), mult: row.mult };
        }
    });
};
