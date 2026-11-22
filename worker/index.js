/* ======================================================================
   THE SYSTEM — hosted backend (Cloudflare Worker + D1)
   ----------------------------------------------------------------------
   Per-user accounts, per-user records, an AI meal planner and device
   push notifications.

     GET  /api/health                  public
     GET  /api/auth/config             public: which sign-in methods exist
     POST /api/auth/signup             { email, password, name }
     POST /api/auth/login              { email, password }
     POST /api/auth/logout
     GET  /api/auth/session            { user } | { user: null }
     GET  /api/auth/google/start       (303 to Google when configured)
     GET  /api/auth/google/callback
     GET  /api/state                   this account's record
     PUT  /api/state                   { state, updatedAt }  (409 = stale)
     POST /api/ai/suggest              pantry-aware meal plan
     GET  /api/push/config             { publicKey } | { publicKey: null }
     POST /api/push/subscribe          { endpoint, keys }
     POST /api/push/unsubscribe        { endpoint }
     POST /api/push/test
     POST /api/push/tick               { drank, goal, hour, tzOffset }
     GET  /.well-known/assetlinks.json (public, for the Android app)

   Every /api route except auth and health requires a session, and every
   record is keyed by the session's user id, so one hunter can never read
   another hunter's record.
   ====================================================================== */

import {
  clearCookie,
  createSession,
  createUser,
  currentUser,
  destroySession,
  emailProblem,
  findUserByEmail,
  googleAuthUrl,
  googleConfigured,
  googleProfile,
  linkGoogle,
  normalizeEmail,
  oauthCookie,
  OAUTH_COOKIE,
  passwordProblem,
  readCookie,
  sessionCookie,
  verifyPassword
} from './auth.js';
import { pushConfigured, pushUser } from './push.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const PUBLIC_JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const MAX_BODY = 4 * 1024 * 1024;
const AI_DAILY_LIMIT = 40;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     pass_salt TEXT,
     pass_hash TEXT,
     google_sub TEXT,
     avatar TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS records (
     user_id TEXT PRIMARY KEY,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     saved_at TEXT NOT NULL,
     state TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id)`,
  `CREATE TABLE IF NOT EXISTS push_prefs (
     user_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL,
     every_min INTEGER NOT NULL,
     tz_offset INTEGER NOT NULL,
     last_sent_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
     user_id TEXT NOT NULL,
     day TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (user_id, day)
   )`
];

let schemaReady = false;

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function publicJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: PUBLIC_JSON_HEADERS });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders } });
}

async function ensureSchema(db) {
  if (schemaReady) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  schemaReady = true;
}

/* The hosted origin comes from APP_ORIGIN when set, otherwise from the
   request itself, so a deployment without that variable still works. */
function appOrigin(request, env) {
  const configured = String(env.APP_ORIGIN || '').trim().replace(/\/$/, '');
  return configured || new URL(request.url).origin;
}

/* Cookies are SameSite=Lax, so a cross-site POST cannot carry them; the
   Origin check is the second lock on every write. */
function sameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // same-origin form posts and curl rarely send it
  const allowed = new Set([appOrigin(request, env), new URL(request.url).origin]);
  return allowed.has(origin.replace(/\/$/, ''));
}

async function readBody(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return { error: 'body too large', status: 413 };
  try {
    return { body: await request.json() };
  } catch {
    return { error: 'invalid JSON', status: 400 };
  }
}

/* ---------------- accounts ---------------- */

async function adoptLegacyRecord(env, userId) {
  // The single-record era kept its data in `record`. The first account to be
  // created inherits it so nothing that was already logged is lost.
  try {
    const legacy = await env.DB.prepare(
      'SELECT revision, updated_at, saved_at, state FROM record WHERE id = ?'
    )
      .bind('main')
      .first();
    if (!legacy) return;
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (Number(count && count.n) !== 1) return;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO records (user_id, revision, updated_at, saved_at, state)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(userId, legacy.revision, legacy.updated_at, legacy.saved_at, legacy.state)
      .run();
  } catch {
    /* no legacy table on a fresh database */
  }
}

async function handleSignup(request, env) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 60);

  const badEmail = emailProblem(email);
  if (badEmail) return json({ error: badEmail }, 400);
  const badPassword = passwordProblem(password);
  if (badPassword) return json({ error: badPassword }, 400);

  if (await findUserByEmail(env, email)) {
    return json({ error: 'An account with that email already exists. Sign in instead.' }, 409);
  }

  const user = await createUser(env, { email, name, password });
  await adoptLegacyRecord(env, user.id);
  const token = await createSession(env, user.id);
  return json({ user }, 200, { 'Set-Cookie': sessionCookie(env, token, 30 * 24 * 3600) });
}

async function handleLogin(request, env) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password) return json({ error: 'Enter your email and password.' }, 400);

  const row = await findUserByEmail(env, email);
  if (!row || !row.pass_hash) {
    return json({ error: 'No account matches that email and password.' }, 401);
  }
  if (!(await verifyPassword(password, row.pass_salt, row.pass_hash))) {
    return json({ error: 'No account matches that email and password.' }, 401);
  }

  const token = await createSession(env, row.id);
  return json(
    { user: { id: row.id, email: row.email, name: row.name, avatar: row.avatar, hasPassword: true, google: !!row.google_sub } },
    200,
    { 'Set-Cookie': sessionCookie(env, token, 30 * 24 * 3600) }
  );
}

async function handleLogout(request, env) {
  await destroySession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(env, 'sys_session') });
}

async function handleGoogleStart(request, env) {
  if (!googleConfigured(env)) {
    return json({ error: 'Google sign-in is not configured on this deployment.' }, 503);
  }
  const state = crypto.randomUUID();
  return redirect(googleAuthUrl(env, state, appOrigin(request, env)), { 'Set-Cookie': oauthCookie(env, state) });
}

async function handleGoogleCallback(request, env, url) {
  if (!googleConfigured(env)) return redirect('/?auth=google-unavailable');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const expected = readCookie(request, OAUTH_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return redirect('/?auth=state-mismatch');
  }
  try {
    const profile = await googleProfile(env, code, appOrigin(request, env));
    let row = await findUserByEmail(env, profile.email);
    if (!row) {
      const created = await createUser(env, {
        email: profile.email,
        name: profile.name,
        googleSub: profile.sub,
        avatar: profile.avatar
      });
      await adoptLegacyRecord(env, created.id);
      row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(created.id).first();
    } else if (!row.google_sub) {
      await linkGoogle(env, row.id, profile.sub, profile.avatar);
    }
    const token = await createSession(env, row.id);
    return redirect('/', {
      'Set-Cookie': [sessionCookie(env, token, 30 * 24 * 3600), clearCookie(env, OAUTH_COOKIE)]
    });
  } catch (err) {
    console.error('[system] google callback failed:', err);
    return redirect('/?auth=google-failed');
  }
}

/* ---------------- record ---------------- */

async function readRecord(db, userId) {
  const row = await db
    .prepare('SELECT revision, updated_at, saved_at, state FROM records WHERE user_id = ?')
    .bind(userId)
    .first();
  if (!row) return null;
  return {
    revision: row.revision,
    updatedAt: row.updated_at,
    savedAt: row.saved_at,
    state: JSON.parse(row.state)
  };
}

async function handleState(request, env, user) {
  if (request.method === 'GET') {
    const record = await readRecord(env.DB, user.id);
    return record ? json(record) : json({ error: 'no saved record yet' }, 404);
  }

  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);

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
    `INSERT INTO records (user_id, revision, updated_at, saved_at, state) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       revision = revision + 1,
       updated_at = excluded.updated_at,
       saved_at = excluded.saved_at,
       state = excluded.state
     WHERE excluded.updated_at >= records.updated_at`
  )
    .bind(user.id, updatedAt, savedAt, JSON.stringify(nextState))
    .run();

  if (!result.meta.changes) {
    const current = await readRecord(env.DB, user.id);
    return current ? json(current, 409) : json({ error: 'write rejected' }, 409);
  }

  const revision = (
    await env.DB.prepare('SELECT revision FROM records WHERE user_id = ?').bind(user.id).first()
  ).revision;
  return json({ ok: true, revision, updatedAt, savedAt });
}

/* ---------------- AI meal planner ---------------- */

function aiBase(env) {
  const raw = String(env.AI_BASE_URL || 'https://freebuff.com/api/v1/paid').replace(/\/$/, '');
  return /\/chat\/completions$/.test(raw) ? raw : `${raw}/chat/completions`;
}

function cleanMeals(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .slice(0, 4)
    .map((meal, index) => ({
      name: String((meal && meal.name) || `Meal ${index + 1}`).slice(0, 90),
      kcal: Math.max(0, Math.round(Number(meal && meal.kcal) || 0)),
      protein: Math.max(0, Math.round(Number(meal && meal.protein) || 0)),
      carbs: Math.max(0, Math.round(Number(meal && meal.carbs) || 0)),
      ingredients: (Array.isArray(meal && meal.ingredients) ? meal.ingredients : [])
        .map((item) => String(item).slice(0, 40))
        .slice(0, 12),
      steps: (Array.isArray(meal && meal.steps) ? meal.steps : [])
        .map((item) => String(item).slice(0, 200))
        .slice(0, 5),
      why: String((meal && (meal.why || meal.note)) || '').slice(0, 260)
    }))
    .filter((meal) => meal.name && (meal.kcal > 0 || meal.protein > 0));
}

async function handleAiSuggest(request, env, user) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);

  const pantry = (Array.isArray(body.pantry) ? body.pantry : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 40))
    .slice(0, 60);
  if (!pantry.length) {
    return json({ error: 'Add a few pantry ingredients first, then ask for a plan.' }, 400);
  }

  if (!env.OPENAI_API_KEY) {
    return json(
      {
        error: 'ai not configured',
        hint: 'Add an OPENAI_API_KEY secret in Sites → Secrets (any OpenAI-compatible key), then ask again.'
      },
      503
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  const used = await env.DB.prepare('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?')
    .bind(user.id, day)
    .first();
  if (Number(used && used.count) >= AI_DAILY_LIMIT) {
    return json({ error: `Daily AI limit reached (${AI_DAILY_LIMIT} plans). Try again tomorrow.` }, 429);
  }

  const goals = body.goals || {};
  const eaten = body.eaten || {};
  const remainingKcal = Math.max(0, (Number(goals.kcal) || 2200) - (Number(eaten.kcal) || 0));
  const remainingProtein = Math.max(0, (Number(goals.protein) || 140) - (Number(eaten.protein) || 0));
  const diet = String(body.diet || 'balanced').slice(0, 40);
  const notes = String(body.notes || '').slice(0, 300);
  const mealSlot = String(body.meal || 'lunch').slice(0, 20);

  const system = [
    'You are a sports nutrition coach inside a fitness app used in Kerala, India.',
    'Build meals from the ingredients the user actually has, plus water, salt and common spices.',
    'Respect the remaining calorie and protein budget and the diet preference.',
    'Reply with JSON only, no prose, shaped exactly like:',
    '{"meals":[{"name":"...","kcal":420,"protein":28,"carbs":45,"ingredients":["..."],"steps":["short step"],"why":"one sentence"}]}',
    'Return 3 meals. kcal and protein are integers for one serving. Keep steps to 3 short entries.'
  ].join(' ');

  const prompt = [
    `Pantry: ${pantry.join(', ')}.`,
    `Remaining today: ${remainingKcal} kcal, ${remainingProtein} g protein.`,
    `Diet preference: ${diet}. Meal slot: ${mealSlot}.`,
    notes ? `Extra notes: ${notes}.` : ''
  ]
    .filter(Boolean)
    .join(' ');

  let payload;
  try {
    const res = await fetch(aiBase(env), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.AI_MODEL || 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error('[system] ai request failed:', res.status, detail);
      return json({ error: `AI request failed (${res.status}).`, detail }, 502);
    }
    payload = await res.json();
  } catch (err) {
    return json({ error: `AI request failed: ${(err && err.message) || err}` }, 502);
  }

  await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`
  )
    .bind(user.id, day)
    .run();

  const content = (((payload || {}).choices || [])[0] || {}).message || {};
  let parsed = null;
  try {
    parsed = JSON.parse(content.content || '');
  } catch {
    const text = String(content.content || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  const meals = cleanMeals((parsed && parsed.meals) || (Array.isArray(parsed) ? parsed : []));
  if (!meals.length) return json({ error: 'The AI reply had no usable meals. Try again.' }, 502);

  return json({
    meals,
    model: env.AI_MODEL || 'gpt-4o-mini',
    remaining: { kcal: remainingKcal, protein: remainingProtein },
    usedToday: Number(used && used.count) + 1,
    limit: AI_DAILY_LIMIT
  });
}

/* ---------------- push ---------------- */

async function handlePush(request, env, user, pathname) {
  if (pathname === '/api/push/config' && request.method === 'GET') {
    return json({
      configured: pushConfigured(env),
      publicKey: env.VAPID_PUBLIC_KEY || null
    });
  }

  if (pathname === '/api/push/subscribe' && request.method === 'POST') {
    const { body, error, status } = await readBody(request);
    if (error) return json({ error }, status);
    const sub = body && body.subscription ? body.subscription : body;
    const endpoint = String((sub && sub.endpoint) || '');
    const keys = (sub && sub.keys) || {};
    if (!/^https?:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) {
      return json({ error: 'That push subscription is incomplete.' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    )
      .bind(endpoint, user.id, String(keys.p256dh), String(keys.auth), new Date().toISOString())
      .run();
    return json({ ok: true });
  }

  if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
    const { body } = await readBody(request);
    const endpoint = String((body && body.endpoint) || '');
    if (endpoint) {
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?')
        .bind(endpoint, user.id)
        .run();
    }
    return json({ ok: true });
  }

  if (pathname === '/api/push/test' && request.method === 'POST') {
    if (!pushConfigured(env)) return json({ error: 'Push is not configured on this deployment.' }, 503);
    const result = await pushUser(env, user.id, {
      title: 'SYSTEM ONLINE',
      body: 'Device notifications are working. Reminders will arrive here.',
      tag: 'system-test',
      url: '/'
    });
    return json({ ok: result.sent > 0, ...result });
  }

  if (pathname === '/api/push/tick' && request.method === 'POST') {
    const { body } = await readBody(request);
    const hour = Number(body && body.hour);
    const tzOffset = Number(body && body.tzOffset) || 0;
    const drank = Number(body && body.drank) || 0;
    const goal = Number(body && body.goal) || 2500;

    const prefs = await env.DB.prepare('SELECT * FROM push_prefs WHERE user_id = ?').bind(user.id).first();
    if (!prefs || !Number(prefs.enabled)) return json({ sent: false, reason: 'reminders off' });
    if (!pushConfigured(env)) return json({ sent: false, reason: 'push not configured' });

    const localHour = Number.isFinite(hour) ? hour : new Date(Date.now() + tzOffset * 60000).getUTCHours();
    if (localHour < 8 || localHour >= 22) return json({ sent: false, reason: 'quiet hours' });

    const everyMs = Math.max(15, Number(prefs.every_min) || 90) * 60000;
    if (Date.now() - Number(prefs.last_sent_at || 0) < everyMs) {
      return json({ sent: false, reason: 'not due yet' });
    }

    const left = Math.max(0, goal - drank);
    const result = await pushUser(env, user.id, {
      title: 'HYDRATION QUEST',
      body: left > 0 ? `${left} ml left today. Drink 250 ml now.` : 'Hydration goal met — keep sipping.',
      tag: 'system-water',
      url: '/'
    });
    await env.DB.prepare('UPDATE push_prefs SET last_sent_at = ? WHERE user_id = ?')
      .bind(Date.now(), user.id)
      .run();
    return json({ sent: result.sent > 0, ...result });
  }

  if (pathname === '/api/push/prefs' && request.method === 'POST') {
    const { body } = await readBody(request);
    const enabled = body && body.enabled ? 1 : 0;
    const everyMin = Math.min(360, Math.max(15, Number(body && body.everyMin) || 90));
    const tzOffset = -new Date().getTimezoneOffset();
    await env.DB.prepare(
      `INSERT INTO push_prefs (user_id, enabled, every_min, tz_offset, last_sent_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, every_min = excluded.every_min, tz_offset = excluded.tz_offset`
    )
      .bind(user.id, enabled, everyMin, tzOffset, Date.now())
      .run();
    return json({ ok: true, enabled: !!enabled, everyMin });
  }

  return json({ error: 'unknown endpoint' }, 404);
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

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/.well-known/assetlinks.json') return assetLinks(env);
  if (pathname === '/api/health') return publicJson({ ok: true });

  if (pathname === '/api/auth/config') {
    return publicJson({
      google: googleConfigured(env),
      email: true,
      push: pushConfigured(env)
    });
  }

  // Signed out is a normal answer here, not an error: the client asks on boot.
  if (pathname === '/api/auth/session') {
    await ensureSchema(env.DB);
    return json({ user: await currentUser(request, env) });
  }

  if (pathname === '/api/auth/google/start') return handleGoogleStart(request, env);
  if (pathname === '/api/auth/google/callback') return handleGoogleCallback(request, env, url);

  if (pathname === '/api/auth/signup' || pathname === '/api/auth/login' || pathname === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!sameOrigin(request, env)) return json({ error: 'cross-origin request blocked' }, 403);
    if (pathname === '/api/auth/signup') return handleSignup(request, env);
    if (pathname === '/api/auth/login') return handleLogin(request, env);
    return handleLogout(request, env);
  }

  if (pathname.startsWith('/api/')) {
    await ensureSchema(env.DB);
    const user = await currentUser(request, env);
    if (!user) return json({ error: 'sign in required' }, 401);

    if (request.method !== 'GET' && !sameOrigin(request, env)) {
      return json({ error: 'cross-origin request blocked' }, 403);
    }

    if (pathname === '/api/state') return handleState(request, env, user);
    if (pathname === '/api/ai/suggest') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return handleAiSuggest(request, env, user);
    }
    if (pathname === '/api/push/config') return handlePush(request, env, user, pathname);
    if (pathname.startsWith('/api/push/')) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return handlePush(request, env, user, pathname);
    }
    return json({ error: 'unknown endpoint' }, 404);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env.DB);
      return await handle(request, env);
    } catch (err) {
      console.error('[system] request failed:', err);
      return json({ error: 'internal error' }, 500);
    }
  },

  /* Cron (wrangler.jsonc) sends water reminders while the app is closed.
     The client also calls /api/push/tick on open, so reminders still work on
     hosts that do not run the scheduled trigger. */
  async scheduled(event, env) {
    try {
      await ensureSchema(env.DB);
      if (!pushConfigured(env)) return;
      const rows = await env.DB.prepare('SELECT * FROM push_prefs WHERE enabled = 1').all();
      const now = Date.now();
      for (const prefs of rows.results || []) {
        const everyMs = Math.max(15, Number(prefs.every_min) || 90) * 60000;
        if (now - Number(prefs.last_sent_at || 0) < everyMs) continue;
        const localHour = new Date(now + Number(prefs.tz_offset || 0) * 60000).getUTCHours();
        if (localHour < 8 || localHour >= 22) continue;
        await pushUser(env, prefs.user_id, {
          title: 'HYDRATION QUEST',
          body: 'Time to drink 250 ml. The System is watching your streak.',
          tag: 'system-water',
          url: '/'
        });
        await env.DB.prepare('UPDATE push_prefs SET last_sent_at = ? WHERE user_id = ?')
          .bind(now, prefs.user_id)
          .run();
      }
    } catch (err) {
      console.error('[system] scheduled reminder failed:', err);
    }
  }
};
