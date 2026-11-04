// Downloads the stored reconstructions (benchmark/cache/parts-recon/*.glb, benchmark/cache/recon/*.glb)
// from the v1.0 release, checks them and unpacks them in place. The meshes are not in the repository
// because of their size (about 4.2 GB).
//   node fetch-meshes.mjs                 download from the release
//   node fetch-meshes.mjs --from <dir>    use release files already downloaded to <dir>
// Requires Node.js >= 20 and a `tar` on the path (Windows 10+, macOS and Linux ship one).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE = 'https://github.com/simoesb/twin-calibration-rig/releases/download/v1.0';
const MANIFEST = 'meshes-v1.0.sha256';
const fromArg = process.argv.indexOf('--from');
const from = fromArg > 0 ? path.resolve(process.argv[fromArg + 1]) : null;
const work = from ?? path.join(HERE, '.meshes-download');
fs.mkdirSync(work, { recursive: true });

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
async function get(name) {
  const dest = path.join(work, name);
  if (from || fs.existsSync(dest)) return dest;
  console.log(`downloading ${name}`);
  const res = await fetch(`${RELEASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const tmp = `${dest}.tmp`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

// 1. Parts, each checked against the release manifest.
const manifest = fs.readFileSync(await get(MANIFEST), 'utf8').trim().split('\n')
  .map((l) => l.match(/^([0-9a-f]{64}) \*?(\S+)/)).filter(Boolean).map(([, hash, name]) => ({ hash, name }));
const parts = manifest.filter((m) => /\.part\d+$/.test(m.name)).sort((a, b) => a.name.localeCompare(b.name));
for (const p of parts) {
  const file = await get(p.name);
  if ((await sha256(file)) !== p.hash) throw new Error(`${p.name}: checksum mismatch`);
  console.log(`ok ${p.name}`);
}

// 2. Unpack at the repository root: the parts are streamed, in order, into `tar` (no temporary archive,
// and no file path on tar's command line, which some tar builds read as host:path on Windows).
const tar = spawn('tar', ['xf', '-'], { cwd: HERE, stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((resolve, reject) => tar.on('error', reject).on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)))));
for (const p of parts) await pipeline(fs.createReadStream(path.join(work, p.name)), tar.stdin, { end: false });
tar.stdin.end();
await done;

// 3. Every unpacked mesh against the repository's checksum list.
const sums = fs.readFileSync(path.join(HERE, 'SHA256SUMS'), 'utf8').trim().split('\n')
  .map((l) => l.match(/^([0-9a-f]{64}) \*?\.\/(.+)$/)).filter(Boolean).filter(([, , f]) => /^benchmark\/cache\/(parts-recon|recon)\/[^/]+\.glb$/.test(f));
let bad = 0;
for (const [, hash, f] of sums) if ((await sha256(path.join(HERE, f))) !== hash) { bad++; console.error(`mismatch ${f}`); }
console.log(`${sums.length - bad}/${sums.length} meshes verified`);
if (bad) process.exit(1);
if (!from) fs.rmSync(work, { recursive: true, force: true });
