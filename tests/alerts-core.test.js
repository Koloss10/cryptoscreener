const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRules, createEngine, MAX_RULES, COOLDOWN_MS } = require('../alerts-core.js');

const rule = (over = {}) => normalizeRules([{ key: 'chg5', op: '>=', value: 1, symbol: '', ...over }])[0];
const rows = (...pairs) => pairs.map(([symbol, v]) => ({ symbol, chg5: v }));

test('normalizeRules keeps valid unique rules, uppercases the symbol and drops the rest', () => {
    const list = normalizeRules([
        { key: 'chg5', op: '>=', value: '1', symbol: 'btcusdt' },
        { key: 'chg5', op: '>=', value: 1, symbol: 'BTCUSDT' },           // дубль
        { key: 'nope', op: '>=', value: 1 }, { key: 'chg5', op: '==', value: 1 }, { key: 'chg5', op: '>=', value: 'x' },
        { key: 'chg5', op: '>=', value: 1, symbol: 'BTC' },               // не схоже на пару
        null, { key: 'spike', op: '<=', value: -2, symbol: '' }
    ]);
    assert.deepEqual(list.map(r => [r.key, r.op, r.value, r.symbol]), [['chg5', '>=', 1, 'BTCUSDT'], ['spike', '<=', -2, '']]);
    assert.ok(list.every(r => typeof r.id === 'string' && r.id));
    assert.deepEqual(normalizeRules('x'), []);
    const many = Array.from({ length: 50 }, (_, i) => ({ key: 'chg5', op: '>=', value: i }));
    assert.equal(normalizeRules(many).length, MAX_RULES);
});

test('the first pass only primes: a rule that is already true fires nothing', () => {
    const e = createEngine({ now: () => 1 });
    assert.deepEqual(e.evaluate([rule()], rows(['AAAUSDT', 5], ['BBBUSDT', 0])), []);
});

test('a rule fires once when the condition turns true, not while it stays true', () => {
    let t = 0;
    const e = createEngine({ now: () => t });
    const r = rule();
    e.evaluate([r], rows(['AAAUSDT', 0.5]));
    t = 1000; const ev = e.evaluate([r], rows(['AAAUSDT', 1.5]));
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].symbol, ev[0].key, ev[0].op, ev[0].value, ev[0].actual, ev[0].at], ['AAAUSDT', 'chg5', '>=', 1, 1.5, 1000]);
    t = 2000; assert.deepEqual(e.evaluate([r], rows(['AAAUSDT', 2])), []);
});

test('after the condition drops and returns it fires again only once the cooldown has passed', () => {
    let t = 0;
    const e = createEngine({ now: () => t });
    const r = rule();
    e.evaluate([r], rows(['AAAUSDT', 0]));
    t = 1; assert.equal(e.evaluate([r], rows(['AAAUSDT', 2])).length, 1);
    t = 2; e.evaluate([r], rows(['AAAUSDT', 0]));
    t = 3; assert.equal(e.evaluate([r], rows(['AAAUSDT', 2])).length, 0);                       // пауза ще триває
    t = 4; e.evaluate([r], rows(['AAAUSDT', 0]));
    t = COOLDOWN_MS + 10; assert.equal(e.evaluate([r], rows(['AAAUSDT', 2])).length, 1);
});

test('a symbol rule only looks at its own coin; a general rule tracks every coin independently', () => {
    const e = createEngine({ now: () => 5 });
    const own = rule({ symbol: 'AAAUSDT' }), all = rule({ key: 'chg5', op: '<=', value: -1, symbol: '' });
    e.evaluate([own, all], rows(['AAAUSDT', 0], ['BBBUSDT', 0]));
    const ev = e.evaluate([own, all], rows(['AAAUSDT', 3], ['BBBUSDT', 3]));
    assert.deepEqual(ev.map(x => x.symbol), ['AAAUSDT']);                                       // BUSDT не підпадає під власне правило AUSDT
    const ev2 = e.evaluate([own, all], rows(['AAAUSDT', 3], ['BBBUSDT', -2]));
    assert.deepEqual(ev2.map(x => [x.symbol, x.op]), [['BBBUSDT', '<=']]);
});

test('missing values never fire; a gap resets the state so the next valid hit can fire', () => {
    let t = 0;
    const e = createEngine({ cooldownMs: 0, now: () => t });
    const r = rule();
    e.evaluate([r], rows(['AAAUSDT', 0]));
    t = 1; assert.deepEqual(e.evaluate([r], [{ symbol: 'AAAUSDT', chg5: null }]), []);
    t = 2; assert.equal(e.evaluate([r], rows(['AAAUSDT', 2])).length, 1);
    t = 3; e.evaluate([r], [{ symbol: 'AAAUSDT', chg5: NaN }]);
    t = 4; assert.equal(e.evaluate([r], rows(['AAAUSDT', 2])).length, 1);
});

test('a rule added later is primed on its own (no burst), others keep their state; removed rules are forgotten', () => {
    let t = 0;
    const e = createEngine({ now: () => t });
    const a = rule(), b = rule({ value: 5 });
    e.evaluate([a], rows(['AAAUSDT', 0]));
    t = 1; const ev = e.evaluate([a, b], rows(['AAAUSDT', 6]));
    assert.deepEqual(ev.map(x => x.ruleId), [a.id]);                                          // a спрацювало, b лише заряджене
    t = 2; e.evaluate([b], rows(['AAAUSDT', 6]));                                                // a видалили
    t = 3; assert.deepEqual(e.evaluate([a, b], rows(['AAAUSDT', 6])), []);                       // a повернулось: знову лише заряджається
});
