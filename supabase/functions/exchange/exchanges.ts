// Адаптери бірж скопійовано з Orbix (Koloss10/Orbix, supabase/functions/_shared/exchanges.ts). Відмінності від оригіналу:
// xfetch (таймаут 10 с, без редиректів), ExErr.expose (дослівно клієнту віддаються лише повідомлення бірж),
// збій опитування історії Bybit після створення ордера не вважається помилкою ордера.
// Адреси зашиті: лише Bybit Demo Trading і Binance Futures Testnet — реальний рахунок недоступний.
import { bybitPayload, floorStep, sign } from "./sign.js";

export const BINANCE = "https://testnet.binancefuture.com";
export const BYBIT = "https://api-demo.bybit.com";
export const SYM = /^[A-Z0-9]{2,20}USDT$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 10000;
const xfetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
type Filt = { step: number; minQty: number; minN: number; tick: number };
type Pos = { symbol: string; amt: number; entry: number; mark: number; pnl: number; lev: number; liq: number; tp?: number; sl?: number; ts?: number };
type Fill = { id: string | number; symbol: string; side: string; qty: number; price: number; status: string; link?: string };
export class ExErr extends Error { code: number | null; expose = true; constructor(m: string, c: number | null = null) { super(m); this.code = c; } }   // expose: текст безпечно віддати клієнту

let bnInfo: { at: number; f: Record<string, Filt> } | null = null;

// ---------- Binance Futures Testnet ----------
export function binance(key: string, secret: string) {
  const call = async (method: string, path: string, params: Record<string, string | number | boolean> = {}) => {
    const q = new URLSearchParams(Object.entries({ ...params, recvWindow: 5000, timestamp: Date.now() }).map(([a, b]) => [a, String(b)])).toString();
    const r = await xfetch(`${BINANCE}${path}?${q}&signature=${await sign(q, secret)}`, { method, headers: { "X-MBX-APIKEY": key } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && typeof j.code === "number" && j.code < 0)) {
      console.warn("binance testnet rejected", path, r.status, j?.code, j?.msg);
      throw new ExErr(j?.msg || `HTTP ${r.status}`, j?.code ?? null);
    }
    return j;
  };
  const filters = async () => {
    if (bnInfo && Date.now() - bnInfo.at < 3600e3) return bnInfo.f;
    const j = await xfetch(`${BINANCE}/fapi/v1/exchangeInfo`).then((r) => r.json());
    const f: Record<string, Filt> = {};
    for (const s of j.symbols ?? []) {
      const F: Record<string, any> = {};
      for (const x of s.filters ?? []) F[x.filterType] = x;
      f[s.symbol] = { step: +(F.MARKET_LOT_SIZE?.stepSize || F.LOT_SIZE?.stepSize || 0), minQty: +(F.MARKET_LOT_SIZE?.minQty || F.LOT_SIZE?.minQty || 0), minN: +(F.MIN_NOTIONAL?.notional || 0), tick: +(F.PRICE_FILTER?.tickSize || 0) };
    }
    bnInfo = { at: Date.now(), f };
    return f;
  };
  return {
    native: false, // TP/SL і докупівлі веде сервер (умовні ордери Binance на тестнеті не перевірені)
    invalid: (c: number | null) => c === -2014 || c === -2015 || c === -1022,
    noPerm: (_c: number | null) => false,
    async check() {
      const a = await call("GET", "/fapi/v2/account");
      return { canTrade: !!a.canTrade, withdraw: false, wallet: +a.totalWalletBalance, available: +a.availableBalance, unrealized: +a.totalUnrealizedProfit };
    },
    async positions(symbol?: string): Promise<Pos[]> {
      const p = await call("GET", "/fapi/v2/positionRisk", symbol ? { symbol } : {});
      return p.filter((x: any) => +x.positionAmt !== 0).map((x: any) => ({ symbol: x.symbol, amt: +x.positionAmt, entry: +x.entryPrice, mark: +x.markPrice, pnl: +x.unRealizedProfit, lev: +x.leverage, liq: +x.liquidationPrice }));
    },
    async filt(symbol: string) { return (await filters())[symbol]; },
    async mark(symbol: string) { return +(await xfetch(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`).then((r) => r.json())).markPrice; },
    async leverage(symbol: string, lev: number) { await call("POST", "/fapi/v1/leverage", { symbol, leverage: lev }); },
    async market(symbol: string, side: "BUY" | "SELL", qty: number, reduceOnly = false, link = ""): Promise<Fill> {
      const o = await call("POST", "/fapi/v1/order", { symbol, side, type: "MARKET", quantity: qty, ...(reduceOnly ? { reduceOnly: true } : {}), ...(link ? { newClientOrderId: link } : {}), newOrderRespType: "RESULT" });
      return { id: o.orderId, symbol, side, qty: +o.executedQty, price: +o.avgPrice, status: o.status, link: o.clientOrderId };
    },
    // ордер за власним ідентифікатором (null — такого немає)
    async byLink(symbol: string, link: string): Promise<Fill | null> {
      try {
        const o = await call("GET", "/fapi/v1/order", { symbol, origClientOrderId: link });
        return { id: o.orderId, symbol, side: o.side, qty: +o.executedQty, price: +o.avgPrice || +o.price, status: o.status, link };
      } catch (e) { if ((e as ExErr).code === -2013) return null; throw e; }
    },
  };
}

// ---------- Bybit Demo Trading (v5, USDT perpetual) ----------
export function bybit(key: string, secret: string) {
  const recv = 5000;
  const call = async (method: "GET" | "POST", path: string, params: Record<string, unknown> = {}) => {
    const ts = Date.now();
    let url = `${BYBIT}${path}`, payload = "", body: string | undefined;
    if (method === "GET") { payload = new URLSearchParams(Object.entries(params).map(([a, b]) => [a, String(b)])).toString(); if (payload) url += `?${payload}`; }
    else { body = payload = JSON.stringify(params); }
    const headers: Record<string, string> = { "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": String(ts), "X-BAPI-RECV-WINDOW": String(recv), "X-BAPI-SIGN": await sign(bybitPayload(ts, key, recv, payload), secret) };
    if (body) headers["content-type"] = "application/json";
    const r = await xfetch(url, { method, headers, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.retCode !== 0) {
      console.warn("bybit demo rejected", path, r.status, j?.retCode, j?.retMsg);
      throw new ExErr(j?.retMsg || `HTTP ${r.status}`, typeof j?.retCode === "number" ? j.retCode : null);
    }
    return j.result;
  };
  const pub = async (path: string) => { const j = await xfetch(`${BYBIT}${path}`).then((r) => r.json()); if (j?.retCode !== 0) throw new ExErr(j?.retMsg || "market data error"); return j.result; };
  return {
    native: true, // лімітні докупівлі й TP/SL стоять на самій біржі
    invalid: (c: number | null) => c === 10003 || c === 10004 || c === 33004,
    noPerm: (c: number | null) => c === 10005,
    async check() {
      const w = (await call("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).list?.[0] ?? {};
      const k = await call("GET", "/v5/user/query-api");
      const perms = JSON.stringify(k?.permissions ?? {});
      return { canTrade: Number(k?.readOnly) === 0, withdraw: /Withdraw/i.test(perms), wallet: +(w.totalWalletBalance || 0), available: +(w.totalAvailableBalance || 0), unrealized: +(w.totalPerpUPL || 0) };
    },
    async positions(symbol?: string): Promise<Pos[]> {
      const l = (await call("GET", "/v5/position/list", { category: "linear", ...(symbol ? { symbol } : { settleCoin: "USDT" }) })).list ?? [];
      return l.filter((x: any) => +x.size > 0).map((x: any) => ({ symbol: x.symbol, amt: x.side === "Sell" ? -x.size : +x.size, entry: +x.avgPrice, mark: +x.markPrice, pnl: +x.unrealisedPnl, lev: +x.leverage, liq: +(x.liqPrice || 0), tp: +(x.takeProfit || 0), sl: +(x.stopLoss || 0), ts: +(x.trailingStop || 0) }));
    },
    async filt(symbol: string): Promise<Filt | undefined> {
      const s = (await pub(`/v5/market/instruments-info?category=linear&symbol=${symbol}`)).list?.[0];
      return s ? { step: +s.lotSizeFilter.qtyStep, minQty: +s.lotSizeFilter.minOrderQty, minN: +(s.lotSizeFilter.minNotionalValue || 0), tick: +(s.priceFilter?.tickSize || 0) } : undefined;
    },
    async mark(symbol: string) { return +(await pub(`/v5/market/tickers?category=linear&symbol=${symbol}`)).list?.[0]?.markPrice; },
    async leverage(symbol: string, lev: number) {
      try { await call("POST", "/v5/position/set-leverage", { category: "linear", symbol, buyLeverage: String(lev), sellLeverage: String(lev) }); }
      catch (e) { if ((e as ExErr).code !== 110043) throw e; } // 110043: плече вже таке
    },
    async market(symbol: string, side: "BUY" | "SELL", qty: number, reduceOnly = false, link = ""): Promise<Fill> {
      const o = await call("POST", "/v5/order/create", { category: "linear", symbol, side: side === "BUY" ? "Buy" : "Sell", orderType: "Market", qty: String(qty), ...(reduceOnly ? { reduceOnly: true } : {}), ...(link ? { orderLinkId: link } : {}) });
      let h: any = null;
      try { // ордер уже на біржі: збій опитування історії (ліміт, мережа) не може стати «помилкою ордера» — повертаємо Submitted без ціни
        for (let i = 0; i < 3 && !(+h?.avgPrice > 0); i++) { await sleep(300); h = (await call("GET", "/v5/order/history", { category: "linear", orderId: o.orderId })).list?.[0]; }
      } catch (e) { console.warn("bybit order history poll failed after create", (e as Error).message); }
      return { id: o.orderId, symbol, side, qty: +(h?.cumExecQty || qty), price: +(h?.avgPrice || 0), status: h?.orderStatus || "Submitted", link };
    },
    // лімітний ордер (GTC) з власним ідентифікатором
    async limit(symbol: string, side: "BUY" | "SELL", qty: number, price: number, link: string, reduceOnly = false): Promise<Fill> {
      const o = await call("POST", "/v5/order/create", { category: "linear", symbol, side: side === "BUY" ? "Buy" : "Sell", orderType: "Limit", qty: String(qty), price: String(price), timeInForce: "GTC", orderLinkId: link, ...(reduceOnly ? { reduceOnly: true } : {}) });
      return { id: o.orderId, symbol, side, qty, price, status: "New", link };
    },
    // ордер за власним ідентифікатором: спершу активні, потім історія (null — такого немає)
    async byLink(symbol: string, link: string): Promise<Fill | null> {
      const map = (h: any): Fill => ({ id: h.orderId, symbol, side: h.side === "Buy" ? "BUY" : "SELL", qty: +(h.cumExecQty || h.qty || 0), price: +h.avgPrice || +h.price || 0, status: h.orderStatus, link });
      const a = (await call("GET", "/v5/order/realtime", { category: "linear", symbol, orderLinkId: link })).list?.[0];
      if (a) return map(a);
      const h = (await call("GET", "/v5/order/history", { category: "linear", symbol, orderLinkId: link })).list?.[0];
      return h ? map(h) : null;
    },
    async openOrders(symbol: string) {
      const l = (await call("GET", "/v5/order/realtime", { category: "linear", symbol, orderFilter: "Order", limit: 50 })).list ?? [];
      return l.map((o: any) => ({ id: o.orderId, link: o.orderLinkId, side: o.side, price: +o.price, qty: +o.qty, reduceOnly: !!o.reduceOnly }));
    },
    // скасувати один ордер за власним ідентифікатором (якщо його вже немає — не помилка)
    async cancel(symbol: string, link: string) {
      try { await call("POST", "/v5/order/cancel", { category: "linear", symbol, orderLinkId: link }); }
      catch (e) { if ((e as ExErr).code !== 110001) throw e; } // 110001: ордера не існує
    },
    // скасовує лише звичайні (лімітні) ордери; TP/SL позиції лишаються, доки позиція відкрита
    async cancelAll(symbol: string) { await call("POST", "/v5/order/cancel-all", { category: "linear", symbol, orderFilter: "Order" }); },
    // закриття позицій від start (мс) — результат за даними біржі, з її комісіями; Bybit віддає не більше 7 днів за запит
    async closedPnl(symbol: string, start: number) {
      const l = (await call("GET", "/v5/position/closed-pnl", { category: "linear", symbol, startTime: Math.max(Math.floor(start), Date.now() - 7 * 864e5 + 6e4), limit: 50 })).list ?? [];
      return l.map((x: any) => ({ id: String(x.orderId), t: +x.updatedTime, pnl: +x.closedPnl, q: +(x.closedSize || x.qty), px: +x.avgExitPrice }));
    },
    // TP/SL/трейлінг на всю позицію (ринкове виконання за останньою ціною); 0 — прибрати.
    // ts — відстань трейлінгу в ціні, ap — ціна активації (без неї трейлінг діє одразу)
    async tradingStop(symbol: string, { tp, sl, ts = 0, ap = 0 }: { tp: number; sl: number; ts?: number; ap?: number }) {
      try { await call("POST", "/v5/position/trading-stop", { category: "linear", symbol, positionIdx: 0, tpslMode: "Full", takeProfit: String(tp || 0), stopLoss: String(sl || 0), trailingStop: String(ts || 0), ...(ts && ap ? { activePrice: String(ap) } : {}), tpTriggerBy: "LastPrice", slTriggerBy: "LastPrice" }); }
      catch (e) { if ((e as ExErr).code !== 34040) throw e; } // 34040: без змін
    },
  };
}


// Ринковий ордер на суму в USDT (з плечем): округлення за кроком і мінімумом біржі
export async function marketNotional(ex: ReturnType<typeof bybit> | ReturnType<typeof binance>, symbol: string, side: "BUY" | "SELL", notional: number, lev = 0, link = "") {
  if (lev) await ex.leverage(symbol, lev);
  const F = await ex.filt(symbol);
  if (!F) throw new ExErr("symbol not on testnet");
  const px = await ex.mark(symbol), qty = floorStep(notional / px, F.step);
  if (!(qty > 0) || qty < F.minQty || qty * px < F.minN) throw new ExErr(`order too small: min ${Math.max(F.minN, F.minQty * px).toFixed(2)} USDT`);
  const o = await ex.market(symbol, side, qty, false, link);
  return o.price > 0 ? o : { ...o, price: px, approx: true };
}
// Зняти лише ордери Orbix: з префіксом ідентифікатора prefix ("ox<12 hex id бота>" — одного бота, "ox" — будь-якого бота Orbix).
// Ручні ордери користувача на тій самій парі не чіпаються (cancelAll біржі зняв би й їх).
export async function cancelPrefix(ex: ReturnType<typeof bybit>, symbol: string, prefix: string) {
  if (!/^ox[0-9a-f]{0,12}$/.test(prefix)) throw new ExErr("invalid order prefix");
  const mine = (await ex.openOrders(symbol)).filter((o: { link?: string }) => String(o.link || "").startsWith(prefix));
  for (const o of mine) await ex.cancel(symbol, o.link);
  return mine.length;
}
export const botPrefix = (botId: string) => "ox" + String(botId).replace(/-/g, "").slice(0, 12);
export async function closePosition(ex: ReturnType<typeof bybit> | ReturnType<typeof binance>, symbol: string, link = "") {
  const p = (await ex.positions(symbol))[0];
  if (!p) return null;
  return await ex.market(symbol, p.amt > 0 ? "SELL" : "BUY", Math.abs(p.amt), true, link);
}
