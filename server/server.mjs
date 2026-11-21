#!/usr/bin/env node
/* ======================================================================
   THE SYSTEM — backend
   ----------------------------------------------------------------------
   Zero dependencies. Serves public/ and keeps the tracker record in
   data/state.json.

     GET /api/health  -> { ok: true }
     GET /api/state   -> { revision, updatedAt, savedAt, state } | 404
     PUT /api/state   <- { state, updatedAt }
                        200 { ok, revision, updatedAt, savedAt }
                        409 + the stored record when the incoming copy is
                            older than the one on disk

   Run:  npm start          (PORT=3000, HOST=0.0.0.0 by default)
   ====================================================================== */

import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(ROOT, 'public');
const DATA_FILE = resolve(ROOT, 'data', 'state.json');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 4 * 1024 * 1024; // a lifetime of logs is far smaller than this

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

/* ---------------- record ---------------- */

async function readRecord() {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.state ? parsed : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Serialised and atomic (tmp + rename): two tabs saving at once can never
// leave a half-written record, and one failed write cannot jam the queue.
let writeChain = Promise.resolve();

function queueWrite(record) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
      await rename(tmp, DATA_FILE);
    });
  return writeChain;
}

/* ---------------- http helpers ---------------- */

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

/* ---------------- routes ---------------- */

async function handleState(req, res) {
  if (req.method === 'GET') {
    const record = await readRecord();
    return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: 'no saved record yet' });
  }

  if (req.method === 'PUT') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.status === 413 ? 'body too large' : 'invalid JSON' });
    }

    const nextState = payload && payload.state;
    if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
      return sendJson(res, 400, { error: 'body must contain a state object' });
    }

    const updatedAt = Number(payload.updatedAt) || Date.now();
    const existing = await readRecord();

    // A stale tab or an offline device coming back must not overwrite newer
    // data: hand back the stored copy and let the client adopt it.
    if (existing && Number(existing.updatedAt) > updatedAt) {
      return sendJson(res, 409, existing);
    }

    const record = {
      revision: ((existing && existing.revision) || 0) + 1,
      updatedAt,
      savedAt: new Date().toISOString(),
      state: nextState
    };
    await queueWrite(record);
    return sendJson(res, 200, { ok: true, revision: record.revision, updatedAt, savedAt: record.savedAt });
  }

  res.setHeader('Allow', 'GET, PUT');
  return sendJson(res, 405, { error: 'method not allowed' });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (pathname === '/api/state') return await handleState(req, res);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

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
  console.log(`record: ${DATA_FILE}`);
});
