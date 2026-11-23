# THE SYSTEM

A Solo Leveling–inspired fitness, hydration and nutrition tracker. Vanilla
HTML/CSS/JS front end, a Cloudflare Worker + D1 backend, an installable PWA and
a CI-built Android app.

## What it does

- **Daily quests** — workouts from a library, weekly schedule, XP, ranks,
  streaks, 84-day quest map.
- **Body profile & BMI** — the first run asks for height, weight and goal
  (lose fat, maintain, build muscle); that calibrates BMI and the daily calorie,
  protein and water targets, which stay editable in Settings.
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
- **A first day, not a backlog** — a new account (or a guest record) starts on
  the day it is created: days before it are blank in the quest map instead of
  showing as missed workouts.
- **Guided tour** — the first run walks through the quest, water, workouts,
  nutrition, progress and settings one card at a time. Settings → SHOW TUTORIAL
  replays it.
- **A real app, not a tab** — a launch splash, a one-tap install bar (native
  prompt on Android/Chrome, Share → Add to Home Screen instructions on iOS),
  home-screen shortcuts for water / today / weigh-in, and a single-window
  `launch_handler`. Installed, it runs standalone with no address bar.
- **Daily directive** — one rotating objective a day (hydration, workout,
  protein, meals or weigh-in) worth bonus XP, claimable once the condition is
  met. Settings can't fake it; the check reads the day's real log.
- **Achievements** — eleven milestones (streaks, levels, quests, hydration,
  weigh-ins, meals, sharing) that unlock once and pay XP, shown as a badge
  shelf in the Hunter Record.
- **Share your record** — a native share sheet (clipboard fallback) with the
  hunter's level, rank, quests and streak, so progress is easy to post.
- **Google sign-in** — either sign in with Google, or attach Google to an
  existing email account from Settings → GOOGLE ACCOUNT.

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
OPENAI_API_KEY=...        # turns the AI planner on (any of the keys below)
```

The planner works out where to send the request from the key itself: a `gsk_…`
key goes to Groq, a `sk-…` OpenAI key to `https://api.openai.com/v1`, anything
else (a Freebuff key) to the Freebuff paid endpoint. Each provider gets its own
default model (`openai/gpt-oss-120b` on Groq, `gpt-4o-mini` elsewhere) unless
`AI_MODEL` says otherwise. If the chosen endpoint rejects the key with
400/401/403/404 the request is retried on the others, so no base URL needs
setting. `AI_BASE_URL=…` is only for some other OpenAI-compatible provider and
still takes priority.

**Free keys.** Groq has a free plan with no card: create a key at
<https://console.groq.com/keys> and put it in `OPENAI_API_KEY`. Free models there
are `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`, at about
30 requests/minute and 1,000/day per model — far more than a meal planner needs.
Google AI Studio (Gemini) and OpenRouter (`:free` models) also speak the OpenAI
format, but need `AI_BASE_URL` set.

To run the real worker (D1 included) instead:

```bash
npm run build:worker
npm run worker        # wrangler dev on http://localhost:8787
```

Checks:

```bash
node scripts/test-push.mjs     # Web Push encryption + VAPID JWT round trip
npm run check:secrets          # tracked files hold no credentials
```

`npm install` points git at `.githooks/`, so `git commit` runs that credential
check before the commit exists and refuses a `.dev.vars`, `.env`, keystore or a
pasted key. The `Secret guard` workflow runs the same script on every push and
pull request, for the case where the hook was never installed.

## Hosting

The hosted deployment is a Worker (`worker/index.js`, bundled to
`deploy/index.js` by `npm run build:worker`) with `public/` as static assets:

```bash
npm run build:worker
# then deploy sites.json to the Sites project
```

Live: https://the-system-fitness-ehtabh.freebuff.site
A second deployment runs on the owner's own Cloudflare account:
<https://system-fitness.adharsh-bb1.workers.dev>

### Your own Cloudflare account

The same Worker deploys straight from this repo:

```bash
npx wrangler login                              # once
npx wrangler d1 create system-fitness           # copy the database_id into wrangler.jsonc
npm run build:worker
npx wrangler deploy
```

Then set the secrets on that Worker (dashboard → Worker → Settings → Variables,
or `npx wrangler secret put NAME`): `OPENAI_API_KEY`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and later `TWA_FINGERPRINT`. The origin is
read from the request when `APP_ORIGIN` is unset, so no extra variable is needed
on `*.workers.dev`; set it if the app moves behind a custom domain.

The first request creates the D1 tables. The cron trigger in `wrangler.jsonc`
sends water reminders while the app is closed.

Secrets (Sites → Secrets) — deploy once *before* setting them:

| Name | Needed for | Notes |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | device notifications | `npm run vapid`; `/api/auth/config` reports `push: true` once both VAPID keys are set |
| `VAPID_PRIVATE_KEY` | device notifications | keep stable; rotating it drops old subscriptions |
| `VAPID_SUBJECT` | device notifications | `mailto:` or an `https:` URL |
| `OPENAI_API_KEY` | AI meal plan | a Freebuff key, a plain OpenAI (`sk-…`) key or a free Groq key (`gsk_…`); the endpoint and model follow the key, and the planner returns a setup hint until the secret exists |
| `GOOGLE_CLIENT_ID` | Google sign-in | optional |
| `GOOGLE_CLIENT_SECRET` | Google sign-in | optional |

The origin is taken from `APP_ORIGIN` when set, otherwise from the request, so a
deployment works without extra configuration. All secrets are read on the
server only.

### Google sign-in

1. Create an OAuth 2.0 **Web application** client in Google Cloud Console.
2. Add authorised redirect URIs, one per deployment:
   `https://the-system-fitness-ehtabh.freebuff.site/api/auth/google/callback`,
   `https://system-fitness.adharsh-bb1.workers.dev/api/auth/google/callback`
   (and `http://localhost:3000/api/auth/google/callback` for local use).
3. Put the client id and secret in Sites → Secrets / the Worker's variables.

Until both are set the button stays hidden and `/api/auth/config` reports
`google: false`; email + password keeps working.

Signed-in users can attach Google to their existing account: Settings →
GOOGLE ACCOUNT → CONNECT GOOGLE. The intent rides in the same HttpOnly state
cookie as the OAuth `state`, so `/api/auth/google/start?link=1` can only link
the account that started the flow, and an email that already belongs to another
account is refused (`?auth=google-in-use`).

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
  the job summary and the job log

Add these repository secrets for a stable signature (otherwise a throwaway
keystore is generated and each build has a new fingerprint):

| Secret | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | base64 of your `.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | store/key password |
| `ANDROID_KEY_ALIAS` | key alias |

Then set `TWA_FINGERPRINT` (Sites → Secrets) to the printed SHA-256 so `/.well-known/assetlinks.json` verifies the app and Chrome does not show a URL bar. `targetSdk` is 36 because Bubblewrap 1.27 ignores 37; Play requires 37 from August 2027.

### Install on a phone

The app opens `https://system-fitness.adharsh-bb1.workers.dev` (the owner's own
Cloudflare Worker). The current release is **1.6.0** (`appVersionCode` 3), built
by run #8 and signed with that run's throwaway key:

```
E0:C4:A5:2C:7F:5A:BD:4D:56:3F:8B:CC:B9:79:48:28
A1:3E:55:8A:66:12:6F:11:40:07:FF:D2:21:FC:C6:EA
```

That digest is in the Worker's `TWA_FINGERPRINT`, so `/.well-known/assetlinks.json`
verifies the APK and it opens fullscreen, with no address bar. `TWA_FINGERPRINT`
accepts a comma-separated list, so several signatures can be valid at once.
The file itself is `artifacts/THE-SYSTEM-1.6.0.apk`
(sha256 `719b44f0c3aee06fe08e1d9bd76dbe26030fa16066cabb8011ef146d0642840a`).

Since these builds use a throwaway key, the signature changes with every run:
uninstall the old app before installing a new one, and update the fingerprint.

1. Open **Actions → Build Android APK → the latest run** and download the
   `the-system-apk` artifact.
2. Unzip it and copy `app-release-signed.apk` to the phone.
3. Tap the file and allow installs from your file manager when Android asks.
4. Open **THE SYSTEM** and sign in — the same account, the same record.

A build without the keystore secrets is signed with a throwaway key, so every
new build has a new fingerprint. Re-read it with `openssl x509 -in cert.pem
-fingerprint -sha256 -noout` (extract `META-INF/*.RSA` from the APK first), or
from the run summary, and update `TWA_FINGERPRINT` before installing that
build. Adding `ANDROID_KEYSTORE_BASE64` keeps one signature forever.

## Layout

```
public/     index.html, styles.css, app.js, nutrition.js, foods.js,
            auth.js, sync.js, ai.js, push.js, sw.js, icons/
worker/     index.js (router), auth.js (accounts/OAuth), push.js (web push)
server/     server.mjs — local backend
scripts/    build-worker.mjs, make-vapid.mjs, make-icons.mjs, test-push.mjs
android/    twa-manifest.json
```
