#!/usr/bin/env node
/* Bundles worker/index.js and its dependencies into deploy/index.js, which is
   what the hosting deploy manifest uploads. Run: npm run build:worker */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

mkdirSync(resolve(ROOT, 'deploy'), { recursive: true });

await build({
  entryPoints: [resolve(ROOT, 'worker', 'index.js')],
  outfile: resolve(ROOT, 'deploy', 'index.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['worker', 'import', 'default'],
  legalComments: 'none',
  logLevel: 'info'
});
