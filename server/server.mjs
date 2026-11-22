#!/usr/bin/env node
/* ======================================================================
   THE SYSTEM — local backend
   ----------------------------------------------------------------------
   Zero dependencies. Serves public/ and mirrors the hosted Worker API so
   `npm start` behaves like production:

     GET  /api/health
     GET  /api/auth/config
     POST /api/auth/signup | /api/auth/login | /api/auth/logout
     GET  /api/auth/session
     GET  /api/state  -> { revision, updatedAt, savedAt, state } | 404
     PUT  /api/state  <- { state, updatedAt }   (409 + the stored record)
     POST /api/ai/suggest
     GET  /api/push/config
     POST /api/push/subscribe | /unsubscribe | /test | /prefs | /tick

   Accounts, sessions and records live in data/db.json. Google sign-in and
   Web Push need deployment secrets, so locally they report "not configured"
   unless VAPID keys are in .dev.vars / the environment.

   Run:  npm start        (PORT=3000, HOST=0.0.0.0 by default)
   ====================================================================== */

import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const DATA_FILE = resolve(ROOT, 'data', 'db.json');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 4 * 1024 * 1024;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const AI_DAILY_LIMIT = 40;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- .env (optional, zero-dep) ---------------- */

async function loadEnvFile() {
  try {
    const raw = await readFile(resolve(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      if (process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env is fine */
  }
  try {
    const raw = await readFile(resolve(ROOT, '.dev.vars'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      if (process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .dev.vars either */
  }
}

/* ---------------- store ---------------- */

const EMPTY_DB = { users: [], sessions: {}, records: {}, pushSubs: [], pushPrefs: {}, aiUsage: {} };
let db = null;
let writeChain = Promise.resolve();

async function readDb() {
  if (db) return db;
  try {
    db = { ...EMPTY_DB, ...JSON.parse(await readFile(DATA_FILE, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = JSON.parse(JSON.stringify(EMPTY_DB));
  }
  return db;
}

function queueWrite() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, DATA_FILE);
    });
  return writeChain;
}

/* ---------------- auth helpers ---------------- */

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  const hash = pbkdf2Sync(password, Buffer.from(salt, 'base64url'), 120000, 32, 'sha256').toString('base64url');
  return { salt, hash };
}

function passwordMatches(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const candidate = pbkdf2Sync(password, Buffer.from(user.salt, 'base64url'), 120000, 32, 'sha256');
  const expected = Buffer.from(user.hash, 'base64url');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar || null,
    hasPassword: !!user.hash,
    google: !!user.googleSub
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sys_session;
  if (!token) return null;
  const session = db.sessions[hashToken(token)];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete db.sessions[hashToken(token)];
    queueWrite();
    return null;
  }
  return db.users.find((u) => u.id === session.userId) || null;
}

function startSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  db.sessions[hashToken(token)] = { userId, expiresAt: Date.now() + SESSION_MS };
  res.setHeader('Set-Cookie', `sys_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
  queueWrite();
}

/* ---------------- http helpers ---------------- */

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) fail(Object.assign(new Error('body too large'), { status: 413 }));
      else ok(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

async function jsonBody(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch (err) {
    return { __error: err.status === 413 ? 'body too large' : 'invalid JSON' };
  }
}

async function serveStatic(pathname, req, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
  if (rel.endsWith('/')) rel += 'index.html';

  const file = resolve(PUBLIC_DIR, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    return sendJson(res, 404, { error: 'not found' });
  }

  try {
    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return sendJson(res, 404, { error: 'not found' });
    throw err;
  }
}

/* ---------------- push ---------------- */

async function pushModule() {
  try {
    return await import('../worker/push.js');
  } catch {
    return null;
  }
}

function pushEnv() {
  return {
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT
  };
}

async function sendPush(userId, payload) {
  const mod = await pushModule();
  const env = pushEnv();
  if (!mod || !mod.pushConfigured(env)) return { sent: 0, total: 0 };
  const subs = db.pushSubs.filter((s) => s.userId === userId);
  let sent = 0;
  for (const sub of subs) {
    const result = await mod.sendPush(env, sub, payload);
    if (result.ok) sent++;
    if (result.expired) db.pushSubs = db.pushSubs.filter((s) => s.endpoint !== sub.endpoint);
  }
  queueWrite();
  return { sent, total: subs.length };
}

/* ---------------- AI ---------------- */

function aiBase() {
  const raw = String(process.env.AI_BASE_URL || 'https://freebuff.com/api/v1/paid').replace(/\/$/, '');
  return /\/chat\/completions$/.test(raw) ? raw : `${raw}/chat/completions`;
}

function cleanMeals(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 4)
    .map((meal, i) => ({
      name: String((meal && meal.name) || `Meal ${i + 1}`).slice(0, 90),
      kcal: Math.max(0, Math.round(Number(meal && meal.kcal) || 0)),
      protein: Math.max(0, Math.round(Number(meal && meal.protein) || 0)),
      carbs: Math.max(0, Math.round(Number(meal && meal.carbs) || 0)),
      ingredients: (Array.isArray(meal && meal.ingredients) ? meal.ingredients : []).map((x) => String(x).slice(0, 40)).slice(0, 12),
      steps: (Array.isArray(meal && meal.steps) ? meal.steps : []).map((x) => String(x).slice(0, 200)).slice(0, 5),
      why: String((meal && (meal.why || meal.note)) || '').slice(0, 260)
    }))
    .filter((meal) => meal.name && (meal.kcal > 0 || meal.protein > 0));
}

/* ---------------- routes ---------------- */

async function handleAi(req, res, user) {
  const body = await jsonBody(req);
  if (body.__error) return sendJson(res, 400, { error: body.__error });

  const pantry = (Array.isArray(body.pantry) ? body.pantry : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 40))
    .slice(0, 60);
  if (!pantry.length) return sendJson(res, 400, { error: 'Add a few pantry ingredients first, then ask for a plan.' });
  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 503, {
      error: 'ai not configured',
      hint: 'Put OPENAI_API_KEY in .env (and in Sites → Secrets once hosted) to turn the planner on.'
    });
  }

  const day = new Date().toISOString().slice(0, 10);
  const used = db.aiUsage[`${user.id}:${day}`] || 0;
  if (used >= AI_DAILY_LIMIT) return sendJson(res, 429, { error: `Daily AI limit reached (${AI_DAILY_LIMIT} plans). Try again tomorrow.` });

  const goals = body.goals || {};
  const eaten = body.eaten || {};
  const remainingKcal = Math.max(0, (Number(goals.kcal) || 2200) - (Number(eaten.kcal) || 0));
  const remainingProtein = Math.max(0, (Number(goals.protein) || 140) - (Number(eaten.protein) || 0));

  const system = [
    'You are a sports nutrition coach inside a fitness app used in Kerala, India.',
    'Build meals from the ingredients the user actually has, plus water, salt and common spices.',
    'Respect the remaining calorie and protein budget and the diet preference.',
    'Reply with JSON only, shaped exactly like:',
    '{"meals":[{"name":"...","kcal":420,"protein":28,"carbs":45,"ingredients":["..."],"steps":["short step"],"why":"one sentence"}]}',
    'Return 3 meals. kcal and protein are integers for one serving. Keep steps to 3 short entries.'
  ].join(' ');

  const prompt = [
    `Pantry: ${pantry.join(', ')}.`,
    `Remaining today: ${remainingKcal} kcal, ${remainingProtein} g protein.`,
    `Diet preference: ${String(body.diet || 'balanced').slice(0, 40)}. Meal slot: ${String(body.meal || 'lunch').slice(0, 20)}.`,
    body.notes ? `Extra notes: ${String(body.notes).slice(0, 300)}.` : ''
  ]
    .filter(Boolean)
    .join(' ');

  let payload;
  try {
    const response = await fetch(aiBase(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return sendJson(res, 502, { error: `AI request failed (${response.status}).`, detail });
    }
    payload = await response.json();
  } catch (err) {
    return sendJson(res, 502, { error: `AI request failed: ${err.message}` });
  }

  db.aiUsage[`${user.id}:${day}`] = used + 1;
  queueWrite();

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
  if (!meals.length) return sendJson(res, 502, { error: 'The AI reply had no usable meals. Try again.' });
  return sendJson(res, 200, {
    meals,
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    remaining: { kcal: remainingKcal, protein: remainingProtein },
    usedToday: used + 1,
    limit: AI_DAILY_LIMIT
  });
}

async function handleState(req, res, user) {
  if (req.method === 'GET') {
    const record = db.records[user.id];
    return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: 'no saved record yet' });
  }

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const payload = await jsonBody(req);
  if (payload.__error) return sendJson(res, payload.__error === 'body too large' ? 413 : 400, { error: payload.__error });
  const nextState = payload && payload.state;
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    return sendJson(res, 400, { error: 'body must contain a state object' });
  }

  const updatedAt = Number(payload.updatedAt) || Date.now();
  const existing = db.records[user.id];
  if (existing && Number(existing.updatedAt) > updatedAt) return sendJson(res, 409, existing);

  const record = {
    revision: ((existing && existing.revision) || 0) + 1,
    updatedAt,
    savedAt: new Date().toISOString(),
    state: nextState
  };
  db.records[user.id] = record;
  queueWrite();
  return sendJson(res, 200, { ok: true, revision: record.revision, updatedAt, savedAt: record.savedAt });
}

async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/config') {
    return sendJson(res, 200, {
      google: false,
      email: true,
      push: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    });
  }

  if (pathname === '/api/auth/session') {
    const user = currentUser(req);
    return sendJson(res, 200, { user: user ? publicUser(user) : null });
  }

  if (pathname === '/api/auth/signout' || pathname === '/api/auth/logout') {
    const token = parseCookies(req).sys_session;
    if (token) delete db.sessions[hashToken(token)];
    queueWrite();
    res.setHeader('Set-Cookie', 'sys_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  const body = await jsonBody(req);
  if (body.__error) return sendJson(res, 400, { error: body.__error });

  if (pathname === '/api/auth/signup') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return sendJson(res, 400, { error: 'That email address does not look right.' });
    if (password.length < 8) return sendJson(res, 400, { error: 'Use a password with at least 8 characters.' });
    if (db.users.some((u) => u.email === email)) {
      return sendJson(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
    }
    const creds = hashPassword(password);
    const user = {
      id: `u_${randomBytes(9).toString('hex')}`,
      email,
      name: String(body.name || '').trim().slice(0, 60) || email.split('@')[0],
      salt: creds.salt,
      hash: creds.hash,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    startSession(res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/auth/login') {
    const email = String(body.email || '').trim().toLowerCase();
    const user = db.users.find((u) => u.email === email);
    if (!user || !passwordMatches(String(body.password || ''), user)) {
      return sendJson(res, 401, { error: 'No account matches that email and password.' });
    }
    startSession(res, user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

async function handlePush(req, res, user, pathname) {
  const mod = await pushModule();
  const env = pushEnv();
  const configured = !!(mod && mod.pushConfigured(env));

  if (pathname === '/api/push/config') {
    return sendJson(res, 200, { configured, publicKey: configured ? env.VAPID_PUBLIC_KEY : null });
  }
  if (pathname === '/api/push/subscribe') {
    const body = await jsonBody(req);
    const sub = body.subscription || body;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh) return sendJson(res, 400, { error: 'That push subscription is incomplete.' });
    db.pushSubs = db.pushSubs.filter((s) => s.endpoint !== sub.endpoint);
    db.pushSubs.push({ endpoint: sub.endpoint, userId: user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    queueWrite();
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/push/unsubscribe') {
    const body = await jsonBody(req);
    db.pushSubs = db.pushSubs.filter((s) => !(s.endpoint === body.endpoint && s.userId === user.id));
    queueWrite();
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/push/prefs') {
    const body = await jsonBody(req);
    db.pushPrefs[user.id] = {
      enabled: !!body.enabled,
      everyMin: Math.min(360, Math.max(15, Number(body.everyMin) || 90)),
      lastSentAt: Date.now()
    };
    queueWrite();
    return sendJson(res, 200, { ok: true, enabled: !!body.enabled });
  }
  if (pathname === '/api/push/test') {
    if (!configured) return sendJson(res, 503, { error: 'Push is not configured on this server.' });
    const result = await sendPush(user.id, {
      title: 'SYSTEM ONLINE',
      body: 'Device notifications are working. Reminders will arrive here.',
      tag: 'system-test',
      url: '/'
    });
    return sendJson(res, 200, { ok: result.sent > 0, ...result });
  }
  if (pathname === '/api/push/tick') {
    const body = await jsonBody(req);
    const prefs = db.pushPrefs[user.id];
    if (!prefs || !prefs.enabled) return sendJson(res, 200, { sent: false, reason: 'reminders off' });
    if (!configured) return sendJson(res, 200, { sent: false, reason: 'push not configured' });
    const hour = Number(body.hour);
    if (Number.isFinite(hour) && (hour < 8 || hour >= 22)) return sendJson(res, 200, { sent: false, reason: 'quiet hours' });
    if (Date.now() - prefs.lastSentAt < prefs.everyMin * 60000) return sendJson(res, 200, { sent: false, reason: 'not due yet' });
    const left = Math.max(0, (Number(body.goal) || 2500) - (Number(body.drank) || 0));
    const result = await sendPush(user.id, {
      title: 'HYDRATION QUEST',
      body: left > 0 ? `${left} ml left today. Drink 250 ml now.` : 'Hydration goal met — keep sipping.',
      tag: 'system-water',
      url: '/'
    });
    prefs.lastSentAt = Date.now();
    queueWrite();
    return sendJson(res, 200, { sent: result.sent > 0, ...result });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

/* ---------------- server ---------------- */

await loadEnvFile();
await readDb();

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (pathname === '/.well-known/assetlinks.json') {
      const prints = String(process.env.TWA_FINGERPRINT || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!prints.length) return sendJson(res, 404, { error: 'no fingerprint configured' });
      return sendJson(res, 200, [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: process.env.TWA_PACKAGE_ID || 'site.freebuff.thesystem',
          sha256_cert_fingerprints: prints
        }
      }]);
    }

    if (pathname.startsWith('/api/auth/')) {
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      return await handleAuth(req, res, pathname);
    }

    if (pathname.startsWith('/api/')) {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: 'sign in required' });
      if (pathname === '/api/state') return await handleState(req, res, user);
      if (pathname === '/api/ai/suggest') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        return await handleAi(req, res, user);
      }
      if (pathname.startsWith('/api/push/')) {
        if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        return await handlePush(req, res, user, pathname);
      }
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return await serveStatic(pathname, req, res);
  } catch (err) {
    console.error('[system] request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`THE SYSTEM backend on http://${HOST}:${PORT}`);
  console.log(`accounts + records: ${DATA_FILE}`);
});
