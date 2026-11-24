// Підпис запиту Binance (HMAC-SHA256 рядка параметрів секретом API). Працює в Deno і Node (Web Crypto).
export async function sign(query, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(query));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Округлення кількості вниз до кроку біржі
export function floorStep(q, step) {
  if (!(step > 0)) return q;
  const d = (String(step).split(".")[1] || "").replace(/0+$/, "").length;
  return Number((Math.floor(q / step + 1e-9) * step).toFixed(d));
}
// Рядок для підпису Bybit v5: timestamp + apiKey + recvWindow + (query-рядок для GET | тіло JSON для POST)
export function bybitPayload(ts, apiKey, recvWindow, payload) {
  return String(ts) + apiKey + String(recvWindow) + payload;
}
