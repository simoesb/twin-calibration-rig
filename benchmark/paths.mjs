// Where the harness keeps its data.
//
// Bulky data — the reconstruction cache (cache/) and rendered outputs (out/) — sits beside the code
// (benchmark/cache, benchmark/out), and the reference parts in the kit's parts/. An optional
// data-location.json next to this file moves them elsewhere; relative paths in it resolve from this
// folder:  { "data": "<dir holding cache/ and out/>", "parts": "<reference parts dir>" }
// The small results the manuscript inputs (LaTeX tables, pgfplots data) go to paper-data/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(HERE, 'data-location.json');
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};

export const DATA = path.resolve(HERE, config.data ?? '.');
export const CACHE = path.join(DATA, 'cache');
export const OUT = path.join(DATA, 'out');
export const PAPER = path.join(HERE, 'paper-data');
/** Reference parts (CAD-derived GLB + part.json): configured, or the kit's parts/. */
export const PARTS_DIR = path.resolve(HERE, config.parts ?? path.join('..', 'parts'));
for (const d of [CACHE, OUT, PAPER]) fs.mkdirSync(d, { recursive: true });
