// Bundles the grounding module for the figure studio and benchmark.
//   node lib/bundle-grounding.mjs                      bundles the kit's own copy, lib/grounding-src/ (default)
//   node lib/bundle-grounding.mjs <platform checkout>  bundles <checkout>/src/scene/grounding instead, e.g. a
//                                                      Digital-Twin-Visualization checkout of the platform
//   OUT=<file> node lib/bundle-grounding.mjs …         writes elsewhere than lib/grounding.js (for comparisons)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', '..', 'assets');
const require = createRequire(path.join(ASSETS, 'package.json'));
const esbuild = require('esbuild');
const ENTRY = process.argv[2]
  ? path.join(process.argv[2], 'src/scene/grounding/index.ts')
  : path.join(HERE, 'grounding-src', 'index.ts');

await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: process.env.OUT ?? path.join(HERE, 'grounding.js'),
  external: ['three', 'three/*'],
  nodePaths: [path.join(ASSETS, 'node_modules')],
  logLevel: 'info',
});
