// Запуск одного збирача: node collector/run.mjs <okx|bitget|gate|mexc> <каталог>
// Пише <каталог>/<біржа>.json (повний знімок) і <біржа>.compact.json (топ-100 монет для добових архівів).
import { writeFileSync } from 'node:fs';
import { collect as okx } from './okx.mjs';
import { collect as bitget } from './bitget.mjs';
import { collect as gate } from './gate.mjs';
import { collect as mexc } from './mexc.mjs';

const COLLECTORS = { okx, bitget, gate, mexc };
const COMPACT_COINS = 100;
const [ex, dir] = process.argv.slice(2);
if (!COLLECTORS[ex] || !dir) { console.error('usage: node collector/run.mjs <okx|bitget|gate|mexc> <dir>'); process.exit(2); }

const snap = await COLLECTORS[ex]();
if (!snap.coins.length) { console.error(ex + ': no data'); process.exit(1); }
writeFileSync(`${dir}/${ex}.json`, JSON.stringify(snap) + '\n');
writeFileSync(`${dir}/${ex}.compact.json`, JSON.stringify({ ...snap, coins: snap.coins.slice(0, COMPACT_COINS) }) + '\n');
console.error(`${ex}: ${snap.coins.length} coins, ${Object.keys(snap.walls).length} books, errors ${snap.errors}`);
