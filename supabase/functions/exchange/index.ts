// CryptoScreener: торгівля на ДЕМО/ТЕСТНЕТІ біржі від імені користувача (за схемою Orbix).
//   exchange = "bybit"   → Bybit Demo Trading (віртуальні кошти, реальні ринкові ціни): https://api-demo.bybit.com
//   exchange = "binance" → Binance Futures Testnet: https://testnet.binancefuture.com
// Ключі API лежать у Supabase Vault і до браузера не потрапляють. Адреси бірж зашиті в exchanges.ts:
// функція фізично не може надіслати ордер на реальний рахунок.
// POST /functions/v1/exchange { exchange, action: "check" | "positions" | "order" | "close" | "status", ... }
// Уся логіка — в handler.mjs (тестується без Deno); тут лише зʼєднання з Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { binance, bybit, closePosition, marketNotional } from "./exchanges.ts";
import { handle } from "./handler.mjs";

const ALLOWED_ORIGINS = ["https://koloss10.github.io"];
const MAX_BODY_BYTES = 4096;
const noSession = { persistSession: false, autoRefreshToken: false };

const env = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

Deno.serve(async (req: Request) => {
  // Клієнти створюємо лише коли справді потрібні: preflight і відмови не залежать від змінних середовища
  let asUserClient: ReturnType<typeof createClient> | null = null;
  let adminClient: ReturnType<typeof createClient> | null = null;
  const authHeader = req.headers.get("Authorization");
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : "";
  const asUser = () => asUserClient ??= createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authHeader ?? "" } }, auth: noSession });
  const admin = () => adminClient ??= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: noSession });

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "payload too large" }), { status: 413, headers: { "content-type": "application/json" } });
  }

  const out = await handle({
    method: req.method,
    origin: req.headers.get("Origin"),
    hasAuth: !!authHeader,
    readBody: async () => {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return null;
      try { return JSON.parse(text); } catch { return null; }
    },
  }, {
    allowedOrigins: ALLOWED_ORIGINS,
    getUser: async () => {
      if (!token) return null;
      const { data, error } = await asUser().auth.getUser(token);
      return error || !data?.user ? null : { id: data.user.id };
    },
    mfaOk: async () => {
      const { data, error } = await asUser().rpc("mfa_ok_now");
      if (error) throw new Error(error.message);
      return data === true;
    },
    secretsFor: async (uid: string, exchange: string) => {
      const { data, error } = await admin().rpc("ex_secret_for", { p_uid: uid, p_exchange: exchange });
      if (error) throw new Error(error.message);
      const k = Array.isArray(data) ? data[0] : data;
      return k?.api_key && k?.api_secret
        ? { connId: k.conn_id as string, key: k.api_key as string, secret: k.api_secret as string, status: k.status as string }
        : null;
    },
    makeExchange: (name: string, key: string, secret: string) => (name === "bybit" ? bybit(key, secret) : binance(key, secret)),
    marketNotional,
    closePosition,
    setStatus: async (connId: string, status: string, canTrade: boolean) => {
      const now = new Date().toISOString();
      const { error } = await admin().from("exchange_connections").update({ status, can_trade: canTrade, last_checked_at: now, updated_at: now }).eq("id", connId);
      if (error) throw new Error(error.message);
    },
    claim: async (e: { user_id: string; exchange: string; action: string; symbol: string | null; side: string | null; notional: number | null; leverage: number | null; link: string | null; gapMs: number }) => {
      const { data, error } = await admin().rpc("trade_claim", {
        p_user: e.user_id, p_exchange: e.exchange, p_action: e.action, p_symbol: e.symbol, p_side: e.side,
        p_notional: e.notional, p_leverage: e.leverage, p_link: e.link, p_gap_ms: e.gapMs,
      });
      if (error) throw new Error(error.message);
      return data ?? null;
    },
    finish: async (id: number, ok: boolean, error: string | null) => {
      const r = await admin().rpc("trade_finish", { p_id: id, p_ok: ok, p_error: error });
      if (r.error) throw new Error(r.error.message);
    },
  });
  return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
    status: out.status,
    headers: out.body === undefined ? out.headers : { ...out.headers, "content-type": "application/json" },
  });
});
