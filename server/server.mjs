#!/usr/bin/env node
/* ======================================================================
   THE SYSTEM — backend
   ----------------------------------------------------------------------
   Zero dependencies. Serves the app's static files and stores the whole
   tracker state in a single JSON file (data/state.json).

     GET  /api/health   liveness probe
     GET  /api/state    the saved record: { revision, updatedAt, savedAt, state }
     PUT  /api/state    save { state, updatedAt } and return the new revision

   Run:  npm start            (PORT=3000 by default)
   ====================================================================== */

import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA_DIR = resolve(ROOT, 'data');
const DATA_FILE = resolve(DATA_DIR, 'state.json');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 4 * 1024 * 1024; // 4 MB is far beyond a lifetime of logs

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

const PRIVATE_PREFIXES = ['/data', '/server', '/.git', '/node_modules'];

/* ---------------- record storage ---------------- */

async function readRecord() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return null;
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Writes are serialised and atomic (tmp file + rename), so two tabs saving at
// once can never leave a half-written state.json behind.
let writeChain = Promise.resolve();

function queueWrite(record) {
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, DATA_FILE);
  });
  return writeChain;
}

/* ---------------- helpers ---------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectPromise(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
  });
}

async function serveStatic(pathname, req, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '' || rel === '/') rel = '/index.html';
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'bad path' });
  if (PRIVATE_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) {
    return sendJson(res, 404, { error: 'not found' });
  }

  const file = resolve(ROOT, `.${rel}`);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return sendJson(res, 403, { error: 'forbidden' });

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

/* ---------------- routes ---------------- */

async function handleState(req, res) {
  if (req.method === 'GET') {
    const record = await readRecord();
    if (!record) return sendJson(res, 404, { error: 'no saved record yet' });
    return sendJson(res, 200, record);
  }

  if (req.method === 'PUT') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      const status = err.status || 400;
      return sendJson(res, status, { error: status === 413 ? 'body too large' : 'invalid JSON' });
    }

    const nextState = payload && typeof payload.state === 'object' && payload.state !== null
      ? payload.state
      : (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.logs ? payload : null);
    if (!nextState) return sendJson(res, 400, { error: 'body must contain a state object' });

    const existing = await readRecord();
    const record = {
      revision: ((existing && existing.revision) || 0) + 1,
      updatedAt: Number(payload.updatedAt) || Date.now(),
      savedAt: new Date().toISOString(),
      state: nextState
    };
    await queueWrite(record);
    return sendJson(res, 200, { ok: true, revision: record.revision, updatedAt: record.updatedAt, savedAt: record.savedAt });
  }

  res.setHeader('Allow', 'GET, PUT');
  return sendJson(res, 405, { error: 'method not allowed' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'system-fitness', time: new Date().toISOString() });
    }
    if (url.pathname === '/api/state') return await handleState(req, res);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return await serveStatic(url.pathname, req, res);
  } catch (err) {
    console.error('[system] request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`THE SYSTEM backend listening on http://${HOST}:${PORT}`);
  console.log(`record file: ${DATA_FILE}`);
});
