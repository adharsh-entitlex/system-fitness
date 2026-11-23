#!/usr/bin/env node
/* Bundles worker/index.js and its dependencies into deploy/index.js, which is
   what the hosting deploy manifest uploads. Run: npm run build:worker */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

mkdirSync(resolve(ROOT, 'deploy'), { recursive: true });

/* The bundle carries the commit it was made from, so /api/version can prove
   which build a deployment is serving. `npm run check:live` compares them. */
function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

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
  define: {
    __SYSTEM_COMMIT__: JSON.stringify(commit()),
    __SYSTEM_BUILT__: JSON.stringify(new Date().toISOString())
  },
  logLevel: 'info'
});
