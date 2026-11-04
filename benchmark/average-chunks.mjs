// Averages path-traced chunks (out/<name>-c<k>.png) in linear light into out/<name>.png,
// without a browser (the GPU-free counterpart of bench.html?stage=average).
//   node average-chunks.mjs <name> [k,k,...]     default: every chunk on disk

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { PNG } = createRequire(path.join(HERE, '..', 'assets', 'package.json'))('pngjs');
import { OUT } from './paths.mjs';
const [name, list] = process.argv.slice(2);
const ks = list ? list.split(',').map(Number) : fs.readdirSync(OUT).map((f) => f.match(new RegExp(`^${name}-c(\\d+)\\.png$`))?.[1]).filter((k) => k !== undefined).map(Number);
if (!name || !ks.length) { console.error('usage: node average-chunks.mjs <name> [k,k,...]'); process.exit(1); }

const toLin = Float32Array.from({ length: 256 }, (_, v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
const toSrgb = (v) => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
const imgs = ks.map((k) => PNG.sync.read(fs.readFileSync(path.join(OUT, `${name}-c${k}.png`))));
const { width, height } = imgs[0];
const out = new PNG({ width, height });
for (let i = 0; i < out.data.length; i++) {
  out.data[i] = i % 4 === 3 ? 255 : toSrgb(imgs.reduce((s, im) => s + toLin[im.data[i]], 0) / imgs.length);
}
fs.writeFileSync(path.join(OUT, `${name}.png`), PNG.sync.write(out));
console.log(`${name}.png ← chunks ${ks.join(', ')}`);
