// MEXC USDT-перпетуали (публічний API контрактів, без ключів). Розмір у контрактах: монет у контракті = contractSize.
import { collectGeneric, makeGet, num } from './common.mjs';

export const MEXC = 'https://contract.mexc.com';
export const validate = j => { if (!j || j.success !== true) throw new Error(`code ${j && j.code}`); return j.data; };
const toSymbol = s => s.replace(/_USDT$/, '') + 'USDT';

export function parseContractSizes(data) {
    const out = {};
    for (const c of data) if (/^[A-Z0-9]+_USDT$/.test(c.symbol) && c.state === 0 && num(c.contractSize) > 0) out[c.symbol] = num(c.contractSize);
    return out;
}

export function parseTickers(data, sizes) {
    const rows = [];
    for (const t of data) {
        const mult = sizes[t.symbol], last = num(t.lastPrice), rate = num(t.riseFallRate), vol = num(t.amount24);
        if (!mult || !(last > 0) || rate === null || vol === null) continue;
        const hold = num(t.holdVol);
        rows.push({ s: toSymbol(t.symbol), contract: t.symbol, mult, last, chg24h: Math.round(rate * 10000) / 100, volUsd: Math.round(vol), oiUsd: hold === null ? null : Math.round(hold * mult * last), fund: num(t.fundingRate) });
    }
    return rows.sort((a, b) => b.volUsd - a.volUsd);
}

export const collect = (opts = {}) => {
    const get = makeGet(MEXC, validate, opts.fetchFn);
    return collectGeneric({
        ...opts, ex: 'mexc',
        loadTickers: async () => {
            const [detail, tick] = await Promise.all([get('/api/v1/contract/detail'), get('/api/v1/contract/ticker')]);
            return parseTickers(tick, parseContractSizes(detail));
        },
        loadBook: async row => { const d = await get(`/api/v1/contract/depth/${row.contract}?limit=200`); return { bids: d.bids, asks: d.asks, mult: row.mult }; }
    });
};
