// Bitget USDT-перпетуали (публічний API v2, без ключів). Усе потрібне — в тікерах; розмір у стакані — в монетах.
import { collectGeneric, makeGet, num } from './common.mjs';

export const BITGET = 'https://api.bitget.com';
export const validate = j => { if (j.code !== '00000') throw new Error(`code ${j.code} ${j.msg || ''}`); return j.data; };

export function parseTickers(data) {
    const rows = [];
    for (const t of data) {
        const last = num(t.lastPr), chg = num(t.change24h), vol = num(t.usdtVolume ?? t.quoteVolume);
        if (!/^[A-Z0-9]+USDT$/.test(t.symbol) || (t.deliveryTime !== null && t.deliveryTime !== undefined && t.deliveryTime !== '') || !(last > 0) || chg === null || vol === null) continue;
        const hold = num(t.holdingAmount);
        rows.push({ s: t.symbol, last, chg24h: Math.round(chg * 10000) / 100, volUsd: Math.round(vol), oiUsd: hold === null ? null : Math.round(hold * last), fund: num(t.fundingRate) });
    }
    return rows.sort((a, b) => b.volUsd - a.volUsd);
}

export const collect = (opts = {}) => {
    const get = makeGet(BITGET, validate, opts.fetchFn);
    return collectGeneric({
        ...opts, ex: 'bitget',
        loadTickers: async () => parseTickers(await get('/api/v2/mix/market/tickers?productType=USDT-FUTURES')),
        loadBook: async row => { const d = await get(`/api/v2/mix/market/merge-depth?productType=USDT-FUTURES&symbol=${row.s}&limit=max`); return { bids: d.bids, asks: d.asks, mult: 1 }; }
    });
};
