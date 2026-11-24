// Ядро оповіщень: правила над рядками скринера, спрацьовування по переходу «умова стала істинною» (tests/alerts-core.test.js).
// Правило: { id, key, op: '>=' | '<=', value (сирі одиниці), symbol: '' (усі монети) | 'BTCUSDT' }.
(function (root) {
    'use strict';

    const KEYS = ['price', 'chg5', 'chg15', 'chg60', 'chg24', 'vol1h', 'vol24', 'spike', 'natr5', 'funding'];
    const OPS = { '>=': (v, x) => v >= x, '<=': (v, x) => v <= x };
    const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;
    const COOLDOWN_MS = 10 * 60000;      // одне й те саме правило на тій самій монеті не частіше ніж раз на 10 хв
    const MAX_RULES = 20;
    const MAX_LOG = 100;

    const ruleId = r => `${r.key}${r.op}${r.value}@${r.symbol}`;

    // Лишає лише коректні унікальні правила (відомі колонки, >= чи <=, скінченне число, монета порожня або на кшталт BTCUSDT)
    function normalizeRules(list, validKeys = KEYS) {
        if (!Array.isArray(list)) return [];
        const out = [], seen = new Set();
        for (const r of list) {
            if (!r || !validKeys.includes(r.key) || !OPS[r.op]) continue;
            const value = Number(r.value);
            const symbol = String(r.symbol || '').trim().toUpperCase();
            if (!Number.isFinite(value) || (symbol && !SYMBOL_RE.test(symbol))) continue;
            const rule = { key: r.key, op: r.op, value, symbol };
            rule.id = ruleId(rule);
            if (seen.has(rule.id)) continue;
            seen.add(rule.id); out.push(rule);
            if (out.length >= MAX_RULES) break;
        }
        return out;
    }

    // Рушій зберігає стан між викликами. Перший прохід правила лише «заряджає» стан (без подій): інакше при запуску
    // чи додаванні правила, що вже виконується для десятків монет, прийшов би шквал сповіщень.
    function createEngine({ cooldownMs = COOLDOWN_MS, now = Date.now } = {}) {
        const active = new Map(), lastFired = new Map(), primed = new Set();

        function evaluate(rules, rows) {
            const events = [], seen = new Set();
            for (const rule of rules) {
                const priming = !primed.has(rule.id);
                for (const row of rows) {
                    if (rule.symbol && row.symbol !== rule.symbol) continue;
                    const v = row[rule.key], k = rule.id + '|' + row.symbol;
                    seen.add(k);
                    const hit = typeof v === 'number' && Number.isFinite(v) && OPS[rule.op](v, rule.value);
                    const was = active.get(k) === true;
                    active.set(k, hit);
                    if (!hit || was || priming) continue;
                    const last = lastFired.get(k), t = now();
                    if (last !== undefined && t - last < cooldownMs) continue;
                    lastFired.set(k, t);
                    events.push({ ruleId: rule.id, symbol: row.symbol, key: rule.key, op: rule.op, value: rule.value, actual: v, at: t });
                }
                primed.add(rule.id);
            }
            for (const k of [...active.keys()]) if (!seen.has(k)) active.delete(k);          // монета зникла зі списку або правило видалено
            const ids = new Set(rules.map(r => r.id));
            for (const id of [...primed]) if (!ids.has(id)) primed.delete(id);
            return events;
        }
        return { evaluate };
    }

    const api = { KEYS, COOLDOWN_MS, MAX_RULES, MAX_LOG, normalizeRules, createEngine, ruleId };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AlertsCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
