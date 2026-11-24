// Калібрування формацій на реальних 1m-свічках Binance Futures (скользяче вікно: детектор + оцінка результату).
//   curl -s 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=1000' > BTCUSDT.json
//   node tools/calibrate.js BTCUSDT.json ETHUSDT.json …        (MINRISK=0.3 — відкинути сигнали з ризиком < 0.3% ціни)
// Назва файлу = символ. Детектор «відскоку від плотності» тут не перевіряється (немає історії книги ордерів).
const fs = require('fs');
const F = require('../formations.js');
const MIN = 60000;

function loadSeries(file) {
    const text = fs.readFileSync(file, 'utf8');
    const raw = text.trim().startsWith('[[') ? text : JSON.parse(text).rawHtml.match(/\[\[.*\]\]/s)[0];   // чистий масив або обгортка скрейпера
    return JSON.parse(raw).map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5], quote: +k[7] }));
}
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const FEES = [0.0008, 0.001];       // кругова комісія тейкера ≈ 0.08–0.10% позиції

const all = [];
let symbolHours = 0;
for (const file of process.argv.slice(2)) {
    const series = loadSeries(file);
    const sym = file.split('/').pop().replace(/\.json$/, '');
    const span = (series[series.length - 1].time - series[0].time) / (60 * MIN);
    symbolHours += span;
    let state = { signals: [] };
    for (let i = 130; i < series.length; i++) {
        const window = series.slice(i - 130, i + 1);                // остання свічка — та, що формується
        state = F.addSignals(state, F.detect(sym, window, { walls: [] }));
    }
    const closed = series.slice(0, -1), end = series[series.length - 1].time;
    for (const s of state.signals) {
        if (end - s.time < 62 * MIN) continue;                       // результат ще не визрів
        const res = F.evaluate(s, closed, s.time + 61 * MIN);
        all.push({ ...s, ...res, riskPct: Math.abs(s.entry - s.stop) / s.entry * 100, sym });
    }
    console.log(sym, 'годин історії:', span.toFixed(1), 'сигналів (з результатом):', all.filter(x => x.sym === sym).length);
}

const MINRISK = +(process.env.MINRISK || 0);
for (let i = all.length - 1; i >= 0; i--) if (all[i].riskPct < MINRISK) all.splice(i, 1);
console.log('Фільтр: ризик ≥', MINRISK, '% ціни');
const types = [...new Set(all.map(s => s.type))];
console.log('\nВсього сигналів:', all.length, '| симбол-годин:', symbolHours.toFixed(1), '| ≈', (all.length / symbolHours).toFixed(2), 'на монету за годину');
for (const t of ['all', ...types]) {
    const xs = t === 'all' ? all : all.filter(s => s.type === t);
    const risks = xs.map(s => s.riskPct), dec = xs.filter(s => s.status === 'win' || s.status === 'loss');
    const wins = xs.filter(s => s.status === 'win').length, avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
    const rs = xs.filter(s => typeof s.r === 'number');
    const net = fee => avg(rs.map(s => s.r - (fee * 100) / s.riskPct));
    console.log(`\n[${t}] n=${xs.length} win=${wins} loss=${xs.filter(s => s.status === 'loss').length} exp=${xs.filter(s => s.status === 'expired').length} unk=${xs.filter(s => s.status === 'unknown').length}`
        + `\n  ризик % ціни: p25=${pct(risks, 0.25)?.toFixed(3)} медіана=${pct(risks, 0.5)?.toFixed(3)} p75=${pct(risks, 0.75)?.toFixed(3)}`
        + `\n  winrate=${dec.length ? (wins / dec.length * 100).toFixed(0) : '—'}%  avgR брутто=${avg(rs.map(s => s.r)).toFixed(2)}  нетто(0.08%)=${net(FEES[0]).toFixed(2)}  нетто(0.10%)=${net(FEES[1]).toFixed(2)}`);
}
