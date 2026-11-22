# THE SYSTEM

A Solo Leveling–inspired fitness, hydration and nutrition tracker. Vanilla
HTML/CSS/JS front end, a Cloudflare Worker + D1 backend, an installable PWA and
a CI-built Android app.

## What it does

- **Daily quests** — workouts from a library, weekly schedule, XP, ranks,
  streaks, 84-day quest map.
- **Nutrition** — calories/protein meters, meal log, quick add, a Kerala dish
  database, and an editable pantry.
- **AI meal plan** — reads your pantry, what you have eaten, your remaining
  macros and a diet preference, then returns three cookable meals with kcal,
  protein, ingredients and steps. Each one can be logged in a tap.
- **Accounts** — email + password (PBKDF2-SHA256, per-user salt) or Google
  sign-in. Everyone gets their own record; nobody can read another account's
  data. A guest mode keeps everything on the device.
- **Device notifications** — real Web Push (VAPID + aes128gcm) from the worker,
  so reminders arrive with the app closed. A test button proves delivery.
- **Offline first** — the record is cached in `localStorage` and the app shell in
  a service worker, so it keeps working with no network and syncs when it can.

## Local development

```bash
npm install
npm start            # http://localhost:3000  (zero-dependency Node backend)
```

The Node server mirrors the hosted API: accounts, per-user records, the AI
planner and push endpoints, all stored in `data/db.json` (gitignored).

Optional local secrets go in `.dev.vars` (or `.env`):

```
VAPID_PUBLIC_KEY=...      # npm run vapid  (printed pair; keep these stable)
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
OPENAI_API_KEY=...        # turns the AI planner on
AI_BASE_URL=https://freebuff.com/api/v1/paid   # any OpenAI-compatible base
AI_MODEL=gpt-4o-mini
```

To run the real worker (D1 included) instead:

```bash
npm run build:worker
npm run worker        # wrangler dev on http://localhost:8787
```

Checks:

```bash
node scripts/test-push.mjs     # Web Push encryption + VAPID JWT round trip
```

## Hosting

The hosted deployment is a Worker (`worker/index.js`, bundled to
`deploy/index.js` by `npm run build:worker`) with `public/` as static assets:

```bash
npm run build:worker
# then deploy sites.json to the Sites project
```

Live: https://the-system-fitness-ehtabh.freebuff.site

Secrets (Sites → Secrets) — deploy once *before* setting them:

| Name | Needed for | Notes |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | device notifications | `npm run vapid`, already set |
| `VAPID_PRIVATE_KEY` | device notifications | keep stable; rotating it drops old subscriptions |
| `VAPID_SUBJECT` | device notifications | `mailto:` or an `https:` URL |
| `OPENAI_API_KEY` | AI meal plan | any OpenAI-compatible key; the planner returns a setup hint until it exists |
| `GOOGLE_CLIENT_ID` | Google sign-in | optional |
| `GOOGLE_CLIENT_SECRET` | Google sign-in | optional |

The origin is taken from `APP_ORIGIN` when set, otherwise from the request, so a
deployment works without extra configuration. All secrets are read on the
server only.

### Google sign-in

1. Create an OAuth 2.0 **Web application** client in Google Cloud Console.
2. Add authorised redirect URIs:
   `https://the-system-fitness-ehtabh.freebuff.site/api/auth/google/callback`
   (and `http://localhost:3000/api/auth/google/callback` for local use).
3. Put the client id and secret in Sites → Secrets.

Until both are set the button stays hidden and `/api/auth/config` reports
`google: false`; email + password keeps working.

## Data model (D1)

`users`, `sessions`, `records` (one row per user id), `push_subs`,
`push_prefs`, `ai_usage` (daily cap of 40 plans per account). The first account
created inherits the single record from the pre-accounts era.

## API

Public: `GET /api/health`, `GET /api/auth/config`,
`GET /api/auth/session`, `GET /api/auth/google/start|callback`,
`GET /.well-known/assetlinks.json`.

Signed in (`401` otherwise): `GET|PUT /api/state`,
`POST /api/ai/suggest`, `GET /api/push/config`,
`POST /api/push/subscribe|unsubscribe|test|prefs|tick`.

Writes also require a same-origin `Origin` header; a stale `PUT` answers `409`
with the stored copy.

## Device notifications

The worker signs a VAPID JWT (ES256) and encrypts each payload with an ephemeral
ECDH P-256 key and aes128gcm — no external push service and no dependency.

- `wrangler.jsonc` has a 15-minute cron for reminders while the app is closed.
- The client also calls `/api/push/tick` on open and on a timer, so reminders
  still arrive on hosts that do not run the scheduled trigger.
- Quiet hours are 08:00–22:00 in the browser's timezone.

## Android app (TWA)

`.github/workflows/android-apk.yml` builds the APK in CI — no local SDK:

- generates the project from `android/twa-manifest.json` with
  `bubblewrap update --skipVersionUpgrade`
- builds with `bubblewrap build --skipPwaValidation`
- uploads `the-system-apk` and writes the signing certificate fingerprint into
  the job summary

Add these repository secrets for a stable signature (otherwise a throwaway
keystore is generated and each build has a new fingerprint):

| Secret | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | base64 of your `.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | store/key password |
| `ANDROID_KEY_ALIAS` | key alias |

Then set `TWA_FINGERPRINT` (Sites → Secrets) to the printed SHA-256 so
`/.well-known/assetlinks.json` verifies the app and Chrome does not show a URL
bar. `targetSdk` is 36 because Bubblewrap 1.27 ignores 37; Play requires 37
from August 2027.

## Layout

```
public/     index.html, styles.css, app.js, nutrition.js, foods.js,
            auth.js, sync.js, ai.js, push.js, sw.js, icons/
worker/     index.js (router), auth.js (accounts/OAuth), push.js (web push)
server/     server.mjs — local backend
scripts/    build-worker.mjs, make-vapid.mjs, make-icons.mjs, test-push.mjs
android/    twa-manifest.json
```
