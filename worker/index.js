/* ======================================================================
   THE SYSTEM — hosted backend (Cloudflare Worker + D1)
   ----------------------------------------------------------------------
   Same API as server/server.mjs, plus Sign in with Freebuff:

     GET  /api/health  -> { ok: true }                     (public)
     GET  /api/state   -> { revision, updatedAt, savedAt, state } | 404
     PUT  /api/state   <- { state, updatedAt }
                         200 ok | 409 + stored record | 401 | 403
     GET  /auth/freebuff/session -> { user } | { user: null }
     GET  /.well-known/assetlinks.json  (public, for the Android app)

   The first account to sign in claims the record; every other account
   gets 403. The claim lives in the `owner` row in D1.
   ====================================================================== */

import { createFreebuffAuth, isSameOriginRequest } from '@freebuff/auth';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const PUBLIC_JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const MAX_BODY = 4 * 1024 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS record (
     id TEXT PRIMARY KEY,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     saved_at TEXT NOT NULL,
     state TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS owner (
     id TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     email TEXT,
     created_at TEXT NOT NULL
   )`
];

let auth;
let app;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function publicJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: PUBLIC_JSON_HEADERS });
}

function setup(env) {
  auth ??= createFreebuffAuth({
    clientId: env.FREEBUFF_CLIENT_ID,
    issuer: env.FREEBUFF_ISSUER,
    baseUrl: env.APP_ORIGIN,
    // Only ever true for a loopback development origin.
    allowInsecureLocalhost: /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(env.APP_ORIGIN || '')
  });
  const instance = auth;
  app ??= instance.wrap((request, env) => handle(request, env, instance));
  return app;
}

async function ensureSchema(db) {
  for (const statement of SCHEMA) await db.prepare(statement).run();
}

/* ---------------- owner ---------------- */

function ownerOnly(owner) {
  return json({ error: 'owner only', owner: owner?.email || null }, 403);
}

async function requireOwner(request, env, instance) {
  const user = await instance.getUser(request);
  if (!user) return { response: json({ error: 'sign in required' }, 401) };

  await ensureSchema(env.DB);
  const read = () => env.DB.prepare('SELECT sub, email FROM owner WHERE id = ?').bind('main').first();
  const owner = await read();

  if (!owner) {
    // First sign-in claims the installation. INSERT OR IGNORE keeps a
    // simultaneous second sign-in from taking it.
    await env.DB.prepare('INSERT OR IGNORE INTO owner (id, sub, email, created_at) VALUES (?, ?, ?, ?)')
      .bind('main', user.sub, user.email || null, new Date().toISOString())
      .run();
    const claimed = await read();
    if (!claimed || claimed.sub !== user.sub) return { response: ownerOnly(claimed) };
    return { user };
  }

  if (owner.sub !== user.sub) return { response: ownerOnly(owner) };
  return { user };
}

/* ---------------- record ---------------- */

async function readRecord(db) {
  const row = await db
    .prepare('SELECT revision, updated_at, saved_at, state FROM record WHERE id = ?')
    .bind('main')
    .first();
  if (!row) return null;
  return {
    revision: row.revision,
    updatedAt: row.updated_at,
    savedAt: row.saved_at,
    state: JSON.parse(row.state)
  };
}

async function handleState(request, env) {
  if (request.method === 'GET') {
    const record = await readRecord(env.DB);
    return record ? json(record) : json({ error: 'no saved record yet' }, 404);
  }

  if (request.method === 'PUT') {
    if (!isSameOriginRequest(request, env.APP_ORIGIN)) {
      return json({ error: 'cross-origin write blocked' }, 403);
    }
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) {
      return json({ error: 'body too large' }, 413);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }

    const nextState = payload && payload.state;
    if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
      return json({ error: 'body must contain a state object' }, 400);
    }

    const updatedAt = Number(payload.updatedAt) || Date.now();
    const savedAt = new Date().toISOString();

    // The WHERE clause is the conflict guard: a stale copy changes nothing.
    const result = await env.DB.prepare(
      `INSERT INTO record (id, revision, updated_at, saved_at, state) VALUES ('main', 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         revision = revision + 1,
         updated_at = excluded.updated_at,
         saved_at = excluded.saved_at,
         state = excluded.state
       WHERE excluded.updated_at >= record.updated_at`
    )
      .bind(updatedAt, savedAt, JSON.stringify(nextState))
      .run();

    if (!result.meta.changes) {
      const current = await readRecord(env.DB);
      return current ? json(current, 409) : json({ error: 'write rejected' }, 409);
    }

    const revision = (await env.DB.prepare('SELECT revision FROM record WHERE id = ?').bind('main').first()).revision;
    return json({ ok: true, revision, updatedAt, savedAt });
  }

  return json({ error: 'method not allowed' }, 405);
}

/* ---------------- android app links ---------------- */

function assetLinks(env) {
  const prints = String(env.TWA_FINGERPRINT || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!prints.length) return new Response('no fingerprint configured', { status: 404 });

  return new Response(
    JSON.stringify([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: env.TWA_PACKAGE_ID || 'site.freebuff.thesystem',
          sha256_cert_fingerprints: prints
        }
      }
    ]),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
  );
}

/* ---------------- router ---------------- */

async function handle(request, env, instance) {
  const { pathname } = new URL(request.url);

  if (pathname === '/.well-known/assetlinks.json') return assetLinks(env);
  if (pathname === '/api/health') return publicJson({ ok: true });

  if (pathname.startsWith('/api/')) {
    const access = await requireOwner(request, env, instance);
    if (access.response) return access.response;
    if (pathname === '/api/state') return handleState(request, env);
    return json({ error: 'unknown endpoint' }, 404);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await setup(env)(request, env);
    } catch (err) {
      console.error('[system] request failed:', err);
      return json({ error: 'internal error' }, 500);
    }
  }
};
