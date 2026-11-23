#!/usr/bin/env node
/* ======================================================================
   Deployment drift check

   Two deployments serve this app, and a forgotten deploy used to be
   invisible until a user hit a broken route. Every build now reports the
   commit it was made from, so this script can say which one is behind.

   Run: node scripts/check-live.mjs [url ...]
   Exit code is non-zero when any deployment reports a different commit.
   ====================================================================== */

import { execFileSync } from 'node:child_process';

const DEFAULT_URLS = [
  'https://the-system-fitness-ehtabh.freebuff.site',
  'https://system-fitness.adharsh-bb1.workers.dev'
];

function localCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function versionOf(base) {
  const res = await fetch(`${base.replace(/\/$/, '')}/api/version`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
const commit = localCommit();
let bad = 0;

for (const url of urls) {
  try {
    const info = await versionOf(url);
    const same = commit && info.commit === commit;
    if (!same) bad++;
    const assets = info.assets ? ` · assets ${info.assets}` : '';
    console.log(`${same ? 'ok  ' : 'STALE'} ${url} — ${info.commit || 'unknown'}${info.builtAt ? ` built ${info.builtAt}` : ''}${assets}`);
  } catch (err) {
    bad++;
    console.log(`FAIL ${url} — ${err.message}`);
  }
}

if (!commit) console.log('note: not a git checkout, so no local commit to compare against');
if (bad) {
  console.log(`\n${bad} deployment${bad === 1 ? '' : 's'} behind local ${commit || 'HEAD'} — run the deploy step again.`);
  process.exitCode = 1;
}
