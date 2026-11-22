#!/usr/bin/env node
/* Round-trip check for the Web Push crypto: encrypts like the worker does,
   decrypts with node:crypto as a browser would, then verifies the VAPID JWT
   signature produced by the same code the worker ships.
   Run: node scripts/test-push.mjs */

import {
  createECDH,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify
} from 'node:crypto';
import { encryptPayload, pushConfigured, vapidHeaders } from '../worker/push.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const enc = (s) => Buffer.from(s, 'utf8');

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`ok   ${message}`);
  } else {
    console.error(`FAIL ${message}`);
    failures++;
  }
}

/* ---------------- payload encryption ---------------- */

const ua = createECDH('prime256v1');
ua.generateKeys();
const uaPublic = ua.getPublicKey(); // 65-byte uncompressed point
const authSecret = randomBytes(16);
const payload = { title: 'HYDRATION QUEST', body: '250 ml left today.', url: '/' };

const body = await encryptPayload(payload, new Uint8Array(uaPublic), new Uint8Array(authSecret));

const salt = Buffer.from(body.slice(0, 16));
const recordSize = Buffer.from(body.slice(16, 20)).readUInt32BE(0);
const idLength = body[20];
const asPublic = Buffer.from(body.slice(21, 21 + idLength));
const cipher = Buffer.from(body.slice(21 + idLength));

assert(idLength === 65, 'key id is an uncompressed P-256 point');
assert(recordSize === 4096, 'record size is 4096');

const shared = ua.computeSecret(asPublic);
const keyInfo = Buffer.concat([enc('WebPush: info\0'), Buffer.from(uaPublic), asPublic]);
const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
const cek = Buffer.from(hkdfSync('sha256', ikm, salt, enc('Content-Encoding: aes128gcm\0'), 16));
const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, enc('Content-Encoding: nonce\0'), 12));

const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
decipher.setAuthTag(cipher.slice(cipher.length - 16));
const plaintext = Buffer.concat([decipher.update(cipher.slice(0, cipher.length - 16)), decipher.final()]);
const text = plaintext.slice(0, plaintext.length - 1).toString('utf8');
assert(plaintext[plaintext.length - 1] === 2, 'padding delimiter is 0x02');
assert(JSON.parse(text).body === payload.body, 'payload survives the round trip');

/* ---------------- vapid jwt ---------------- */

const vapid = createECDH('prime256v1');
vapid.generateKeys();
const vapidPublic = vapid.getPublicKey();
const vapidPrivate = vapid.getPrivateKey();
const env = {
  VAPID_PUBLIC_KEY: b64u(vapidPublic),
  VAPID_PRIVATE_KEY: b64u(vapidPrivate),
  VAPID_SUBJECT: 'mailto:system@example.com'
};
assert(pushConfigured(env), 'keys are recognised as configured');

const headers = await vapidHeaders(env, 'https://push.example.com/sub/abc');
const match = String(headers.Authorization || '').match(/^vapid t=([^,]+), k=(.+)$/);
assert(!!match, 'Authorization header is a vapid scheme');
assert(headers['Content-Encoding'] === 'aes128gcm', 'content encoding header is set');

const [head, claims, signature] = match[1].split('.');
const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
const body2 = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
assert(header.alg === 'ES256', 'JWT alg is ES256');
assert(body2.aud === 'https://push.example.com', 'JWT audience is the push origin');

const publicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: b64u(vapidPublic.slice(1, 33)),
  y: b64u(vapidPublic.slice(33, 65))
};
const signedOk = verify(
  'sha256',
  enc(`${head}.${claims}`),
  { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
  Buffer.from(signature, 'base64url')
);
assert(signedOk, 'JWT signature verifies with the public key');

/* The private half must match the advertised public key. */
const derived = createECDH('prime256v1');
derived.setPrivateKey(Buffer.from(vapidPrivate));
assert(
  derived.getPublicKey().equals(vapidPublic) &&
    createPrivateKey({ key: { ...publicJwk, d: b64u(vapidPrivate) }, format: 'jwk' }).asymmetricKeyType === 'ec',
  'public and private halves belong together'
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall push checks passed');
