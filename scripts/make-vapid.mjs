#!/usr/bin/env node
/* Generates a VAPID key pair for Web Push.
   Run: node scripts/make-vapid.mjs
   Put the two values into Worker secrets (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)
   and never commit the private one. */

import { generateKeyPairSync, randomBytes } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });

const raw = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url')
]);
const d = Buffer.from(priv.d, 'base64url').length === 32 ? Buffer.from(priv.d, 'base64url') : Buffer.concat([Buffer.from([0]), Buffer.from(priv.d, 'base64url')]).subarray(-32);

console.log('VAPID_PUBLIC_KEY =', b64u(raw));
console.log('VAPID_PRIVATE_KEY =', b64u(d));
console.log('VAPID_SUBJECT = mailto:you@example.com');
console.log('\nLocal development goes in .dev.vars; the hosted site uses Sites → Secrets.');
console.log('Optional entropy:', b64u(randomBytes(4)));
