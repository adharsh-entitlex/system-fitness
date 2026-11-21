/* ======================================================================
   THE SYSTEM — hosted backend (Cloudflare Worker + D1)
   ----------------------------------------------------------------------
   Same API as server/server.mjs, so the app runs unchanged in the cloud:

     GET /api/health  -> { ok: true }
     GET /api/state   -> { revision, updatedAt, savedAt, state } | 404
     PUT /api/state   <- { state, updatedAt }
                         200 { ok, revision, updatedAt, savedAt }
                         409 + the stored record when the incoming copy is
                             older than the one in D1

   Everything else is served from the static assets in public/.
   ====================================================================== */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const MAX_BODY = 4 * 1024 * 1024;

const SCHEMA = `CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  saved_at TEXT NOT NULL,
  state TEXT NOT NULL
)`;

async function ensureSchema(db) {
  await db.prepare(SCHEMA).run();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

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
  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    const record = await readRecord(env.DB);
    return record ? json(record) : json({ error: 'no saved record yet' }, 404);
  }

  if (request.method === 'PUT') {
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/health') return json({ ok: true });

    if (pathname === '/api/state') {
      try {
        return await handleState(request, env);
      } catch (err) {
        console.error('[system] state failed:', err);
        return json({ error: 'internal error' }, 500);
      }
    }

    if (pathname.startsWith('/api/')) return json({ error: 'unknown endpoint' }, 404);

    return env.ASSETS.fetch(request);
  }
};
