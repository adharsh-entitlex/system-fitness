/* ======================================================================
   Web Push (RFC 8030 / 8291 / 8292) with no dependencies.
   ----------------------------------------------------------------------
   VAPID JWT is signed with ECDSA P-256; the payload is encrypted with
   aes128gcm using an ephemeral ECDH key per message. Both keys come from
   Worker secrets:

     VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point
     VAPID_PRIVATE_KEY  base64url, 32-byte private scalar
     VAPID_SUBJECT      mailto:you@example.com (or an https: URL)

   Generate a pair with: node scripts/make-vapid.mjs
   ====================================================================== */

import { b64uDecode, b64uEncode } from './auth.js';

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;

function concat(...parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* HKDF is one call in WebCrypto: extract with salt, expand with info. */
async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

export async function encryptPayload(payload, uaPublicBytes, authSecret) {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublicBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256)
  );

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublicBytes, asPublic);
  const ikm = await hkdf(shared, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext)
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export async function vapidHeaders(env, endpoint) {
  const publicBytes = b64uDecode(env.VAPID_PUBLIC_KEY);
  const privateBytes = b64uDecode(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64uEncode(publicBytes.slice(1, 33)),
    y: b64uEncode(publicBytes.slice(33, 65)),
    d: b64uEncode(privateBytes)
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:system@example.com'
  };
  const unsigned = `${b64uEncode(encoder.encode(JSON.stringify(header)))}.${b64uEncode(
    encoder.encode(JSON.stringify(claims))
  )}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned))
  );

  return {
    Authorization: `vapid t=${unsigned}.${b64uEncode(signature)}, k=${env.VAPID_PUBLIC_KEY}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: '86400',
    Urgency: 'normal'
  };
}

export function pushConfigured(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/* One subscription. A 404/410 means the browser dropped it. */
export async function sendPush(env, subscription, payload) {
  if (!pushConfigured(env)) return { ok: false, status: 0, expired: false, error: 'push not configured' };
  try {
    const body = await encryptPayload(payload, b64uDecode(subscription.p256dh), b64uDecode(subscription.auth));
    const headers = await vapidHeaders(env, subscription.endpoint);
    const res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
    return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
  } catch (err) {
    return { ok: false, status: 0, expired: false, error: String((err && err.message) || err) };
  }
}

/* Every device a user registered. Expired endpoints are pruned. */
export async function pushUser(env, userId, payload) {
  const rows = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'
  )
    .bind(userId)
    .all();
  const subs = (rows.results || []).map((row) => ({
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth
  }));
  let sent = 0;
  for (const sub of subs) {
    const result = await sendPush(env, sub, payload);
    if (result.ok) sent++;
    if (result.expired) {
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
    }
  }
  return { sent, total: subs.length };
}
