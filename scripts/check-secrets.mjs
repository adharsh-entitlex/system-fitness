#!/usr/bin/env node
/* ======================================================================
   Refuses to let a credentials file (or a key pasted into a tracked file)
   reach a commit.

   `node scripts/check-secrets.mjs`          checks every tracked file
   `node scripts/check-secrets.mjs --staged` checks what git is about to commit

   Runs from .githooks/pre-commit and from the secret-guard workflow.
   ====================================================================== */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const staged = process.argv.includes('--staged');

/* Files that hold credentials, or are the local env of some tool. Anything
   that is clearly a template stays allowed so onboarding still works. */
const FORBIDDEN_PATHS = [
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(local|production|development|test)$/,
  /(^|\/)\.secrets?\//,
  /\.(keystore|jks|p12|pfx|pem|key)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)google-services\.json$/,
  /(^|\/)firebase-adminsdk[^/]*\.json$/
];

/* Values that are obviously a real credential rather than a placeholder. */
const SECRET_PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-(?!test-|example|your|xxx)[A-Za-z0-9_-]{20,}/ },
  { name: 'Groq key', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'OpenRouter key', re: /\bsk-or-v1-[A-Za-z0-9]{40,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'VAPID private key assignment', re: /VAPID_PRIVATE_KEY\s*=\s*[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack webhook', re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: 'plaintext password assignment', re: /\b(password|secret|api_key|apikey)\s*[:=]\s*["'][^"'\s]{16,}["']/i }
];

/* Placeholder values keep the README and .dev.vars.example readable. */
const PLACEHOLDER = /(<[^>]*>|your[-_ ]|example|placeholder|changeme|xxxx|\.\.\.|redacted|dummy)/i;

function listFiles() {
  try {
    const args = staged
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
      : ['ls-files'];
    return execFileSync('git', args, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    console.error(`check-secrets: could not list files (${err.message}).`);
    process.exit(0); // never block work because git was unavailable
  }
}

function scanned(file) {
  try {
    if (statSync(file).size > 512 * 1024) return '';
    return readFileSync(file, 'utf8');
  } catch {
    return ''; // deleted, binary or unreadable: nothing to leak here
  }
}

const problems = [];

for (const file of listFiles()) {
  if (FORBIDDEN_PATHS.some((re) => re.test(file))) {
    problems.push(`${file}: a credentials file must never be committed (gitignore it and keep it local)`);
    continue;
  }
  const text = scanned(file);
  if (!text) continue;
  for (const { name, re } of SECRET_PATTERNS) {
    const match = text.match(re);
    if (match && !PLACEHOLDER.test(match[0])) {
      const line = text.slice(0, match.index).split('\n').length;
      // The value itself is never printed — a log is not a secret store.
      problems.push(`${file}:${line}: looks like a real ${name}; use a placeholder or a secret store`);
    }
  }
}

if (problems.length) {
  console.error('\nBLOCKED: credentials found.\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nRemove them from the commit, keep the real values in .dev.vars locally');
  console.error('and in Sites → Secrets once deployed, then commit again.\n');
  process.exit(1);
}

console.log(`check-secrets: ${staged ? 'staged files' : 'tracked files'} clean.`);
