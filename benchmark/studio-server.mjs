// Figure studio — renders the demo-twin assets into print-resolution PNGs.
//
//   node studio-server.mjs [port]      (default 8070), then open
//     http://localhost:8070/?shot=hero          one shot (preview + save)
//     http://localhost:8070/?all=1              every shot in studio.js
//   PNGs land in figures/out/<shot>.png.
//
// Serves studio.html/studio.js and bench.html/bench.js, three.js from
// ../assets/node_modules, the generated GLBs from ../assets/out, reconstructions
// from figures/cache/recon, and the environment HDR (fetched once from the platform,
// http://localhost:8050/hdr/…, and cached in figures/cache). Pages render off screen
// and POST PNGs to /save/<name> and results to /save-json/<name>.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? 8070);
const PLATFORM = process.env.DT_BASE ?? 'http://localhost:8050';
import { OUT, CACHE, PARTS_DIR } from './paths.mjs';
/** A save name with optional sub-folders, each segment reduced to [\w.-]. */
const safePath = (p) => p.split('/').filter((x) => x && x !== '..').map((x) => x.replace(/[^\w.-]/g, '_')).join('/');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

const ROUTES = [
  ['/three/', path.join(HERE, '..', 'assets', 'node_modules', 'three')],
  ['/nm/', path.join(HERE, '..', 'assets', 'node_modules')],
  ['/assets/', path.join(HERE, '..', 'assets', 'out')],
  ['/parts/', PARTS_DIR],
  ['/out/', OUT],
  ['/cache/', CACHE],
  ['/', HERE],
];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream', '.png': 'image/png' };

async function hdr(name, res) {
  const file = path.join(CACHE, path.basename(name));
  if (!fs.existsSync(file)) {
    const r = await fetch(`${PLATFORM}/hdr/${path.basename(name)}`);
    if (!r.ok) { res.writeHead(502).end(`HDR ${name}: platform answered ${r.status}`); return; }
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  res.writeHead(200, { 'Content-Type': TYPES['.hdr'] }).end(fs.readFileSync(file));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'POST' && url.pathname.startsWith('/save/')) {
    const name = safePath(url.pathname.slice(6));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
    const data = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`saved out/${name}.png`);
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/save-json/')) {
    const name = safePath(url.pathname.slice(11));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.json`), Buffer.concat(chunks));
    console.log(`saved out/${name}.json`);
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname.startsWith('/hdr/')) return hdr(url.pathname.slice(5), res);
  const p = url.pathname === '/' ? '/studio.html' : decodeURIComponent(url.pathname);
  for (const [prefix, dir] of ROUTES) {
    if (!p.startsWith(prefix)) continue;
    const file = path.join(dir, p.slice(prefix.length));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`figure studio on http://localhost:${PORT}  (data: ${OUT}, parts: ${PARTS_DIR})`));
