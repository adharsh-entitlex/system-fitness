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
- **Set-by-set logging** — every set can be recorded with its own reps and
  weight. From that come personal records, a "last time you did 80 kg × 8" line
  under each exercise, and a next-load suggestion once you hit every rep.
- **Live session** — one exercise at a time from the Today screen: log a set,
  rest on a 60/90/120/180-second timer, move on. Nothing else to scroll.
- **Starting program** — onboarding asks for experience, equipment and days per
  week, then builds the workout library and the weekly schedule for you (gym,
  dumbbells at home, or bodyweight only). Progress → REBUILD PROGRAM redoes it
  whenever those change; logged history is never touched.
- **Workout history** — every cleared day becomes a session with its exercises,
  sets, load and an optional note. HISTORY → + LOG SESSION backfills a workout
  you already trained on any past date (from the library, or as a one-off you
  type in), so a streak started before the app did is not lost. Each card has
  REMOVE, which returns the XP and stops the day counting.
- **Body measurements** — waist, chest, arms, thighs and body-fat next to the
  weigh-ins, with the change since the first entry, because the scale alone
  hides recomposition.
- **Adaptive targets** — calories, protein and water are derived from your
  current weight and goal. A typed target is respected until you press
  RECALIBRATE TARGETS, so a weigh-in never quietly overwrites your numbers.
- **Weekly report** — sessions against plan, volume, sets, water and protein
  days for the last seven, shareable as a 1080×1350 image card.
- **Share your record** — a native share sheet (clipboard fallback) with the
  hunter's level, rank, quests and streak, so progress is easy to post.
- **Google sign-in** — either sign in with Google, or attach Google to an
  existing email account from Settings → GOOGLE ACCOUNT. Google only ever
  attaches to an account the owner signed into first, and a Google address
  Google itself has not verified is refused.
- **Password recovery** — forgot-password sends a single-use link (30 minutes)
  through Resend or Postmark. A reset drops every other session, so a stolen
  cookie does not survive it. Accounts also carry an email-confirmed flag.
- **Account controls** — a header account button, signed-out sign-in, SIGN OUT,
  a device list and SIGN OUT EVERYWHERE (the device asking stays in).
- **Two devices, one record** — a stale sync no longer overwrites the other
  copy. Days, sets, meals and water are merged; the losing copy is also kept
  in `<store>.conflict` locally.
- **Autoregulation** — an estimated 1RM per lift from the logged sets, a
  three-session stall check, and a deload weight when a lift stops moving.
- **Plate and warm-up guide** — the loading per side for the weight in the box,
  plus a 40/60/80% ramp before the working set.
- **Program sharing** — SHARE PROGRAM makes a link with the split in the URL
  fragment; IMPORT PROGRAM loads one without touching history.
- **Streak insurance** — mark a day as rest (illness, travel) and it counts as
  neutral instead of zeroing a run.
- **Crash-safe sessions** — a live session survives a reload or a killed tab for
  six hours, and the screen stays awake while it is open.
- **A record with a ceiling** — detail older than two years rolls into monthly
  summaries, and Settings warns before browser storage fills.
- **Deployments that identify themselves** — `/api/version` reports the commit
  it was built from, `npm run check:live` diffs every deployment against HEAD,
  and CI runs the tests, the secret guard and the bundle on every push.

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

If the planner reports that the key was rejected by every provider, the secret
itself is dead (expired, revoked or from another project): create a new key and
replace `OPENAI_API_KEY`. The error names each provider's host and status, so a
bad key is never mistaken for an outage.

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
npm test                       # state maths, merge, plates, archiving (vm, no DOM)
node scripts/test-push.mjs     # Web Push encryption + VAPID JWT round trip
npm run check:secrets          # tracked files hold no credentials
npm run check:live             # every deployment reports HEAD (needs network)
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
| `RESEND_API_KEY` | password reset, email confirmation | optional; `POSTMARK_TOKEN` works too |
| `MAIL_FROM` | the sender on those emails | e.g. `THE SYSTEM <no-reply@yourdomain>`; Resend's test sender works before a domain is verified |

The origin is taken from `APP_ORIGIN` when set, otherwise from the request, so a
deployment works without extra configuration. All secrets are read on the
server only.

**If a secret leaks** — a key pasted into a tracked file, committed by mistake,
or shown in a screenshot is in the git history even after the file is deleted.
Deleting the file is not enough. Rotate the value first (`OPENAI_API_KEY` is
cheap to replace; a new VAPID pair drops existing push subscriptions, which
re-subscribe when each device next opens the app), then rewrite history if the
repository is public. Run `npm run check:secrets` before every push — the
pre-commit hook does it for you once `npm install` has run.

### Google sign-in

1. Google Cloud Console → **APIs & Services → OAuth consent screen**: External,
   app name, support email, scopes `openid email profile`. While the app is in
   **Testing** only listed test users can sign in, so add every Google account
   you want to use, or publish the app.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorised redirect URIs, exact strings, one per deployment:
   `https://the-system-fitness-ehtabh.freebuff.site/api/auth/google/callback`,
   `https://the-system-fitness-ehtabh-preview.freebuff.site/api/auth/google/callback`,
   `https://system-fitness.adharsh-bb1.workers.dev/api/auth/google/callback`,
   `http://localhost:8787/api/auth/google/callback` (only for `npm run worker`).
3. Where the pair goes — the Worker reads them, the browser never does, so no
   code change or redeploy is needed:
   - Sites deployment: Sites panel → THE SYSTEM — Fitness → **Secrets**, add
     `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to each environment you want
     it on (preview and production are separate).
   - Your own Cloudflare account: dashboard → Workers & Pages → `system-fitness`
     → Settings → Variables and Secrets, add both as **secret** type (or
     `npx wrangler secret put GOOGLE_CLIENT_ID` for each name).
   - Local worker: the same two lines in `.dev.vars`, which `wrangler dev` reads.
     `npm start` (the Node server in `server/server.mjs`) has no Google routes,
     so the button stays hidden there — use `npm run worker` to test locally.

After adding them, `/api/auth/config` answers `{"google":true,…}` and the button
appears on the sign-in screen. If it still says `false`, the secrets landed on a
different environment than the URL you opened.

Until both are set the button stays hidden and `/api/auth/config` reports
`google: false`; email + password keeps working.

Google never attaches itself to a password account from the public flow: if
that email already has one, the callback stops at `?auth=google-link-required`
and the owner has to sign in and press CONNECT GOOGLE. A Google address whose
`email_verified` claim is false is refused outright (`?auth=google-unverified`).
Without those two rules, anyone could pre-register someone else's address and
inherit their account the first time the real owner tapped the Google button.

### Password reset and email confirmation

Both need a transactional mail key on the Worker: `RESEND_API_KEY` (or
`POSTMARK_TOKEN`), plus `MAIL_FROM` for the sender. Resend's `onboarding@resend.dev`
sender works before a domain is verified; a real domain needs its DNS records
added in Resend first.

- `POST /api/auth/password/request { email }` always answers `{ ok: true }`, so
  it cannot be used to discover which addresses exist. The link is single-use,
  expires in 30 minutes, and resetting drops every other session.
- `POST /api/auth/verify/request` (signed in) re-sends the confirmation;
  `GET /api/auth/verify?token=…` marks the address confirmed.
- Locally, `npm start` prints the message to the terminal instead of sending
  it, so the whole flow is testable offline.
- No key means sign-in still works and the UI says confirmation is unavailable.

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

Public: `GET /api/health`, `GET /api/version` (build commit),
`GET /api/auth/config`, `GET /api/auth/session`,
`GET /api/auth/google/start|callback`, `GET /api/auth/verify?token=…`,
`POST /api/auth/signup|login|logout`, `POST /api/auth/password/request|reset`,
`GET /.well-known/assetlinks.json`.

Signed in (`401` otherwise): `GET|PUT /api/state`,
`POST /api/auth/verify/request`, `GET /api/auth/sessions`,
`POST /api/auth/sessions/revoke-all`, `POST /api/ai/suggest`,
`GET /api/push/config`,
`POST /api/push/subscribe|unsubscribe|test|prefs|tick`,
`POST /api/account/delete` (`{ confirm: "DELETE" }`; removes the account and
every row belonging to it).

Writes also require a same-origin `Origin` header; a stale `PUT` answers `409`
with the stored copy.

## Device notifications

The worker signs a VAPID JWT (ES256) and encrypts each payload with an ephemeral
ECDH P-256 key and aes128gcm — no external push service and no dependency.

- `wrangler.jsonc` has a 15-minute cron for reminders while the app is closed.
- The client also calls `/api/push/tick` on open and on a timer, so reminders
  still arrive on hosts that do not run the scheduled trigger.
- Quiet hours are 08:00–22:00 in the browser's timezone.
- A **streak check-in** goes out at the hour set in Settings (default 20:00)
  when a workout is scheduled, still open, and at least 20 hours have passed
  since the last nudge. It names the streak that is on the line.

## Android app (TWA)

`.github/workflows/android-apk.yml` builds the APK in CI — no local SDK:

- generates the project from `android/twa-manifest.json` with
  `bubblewrap update --skipVersionUpgrade`
- builds with `bubblewrap build --skipPwaValidation`
- uploads `the-system-apk` and writes the signing certificate fingerprint into
  the job summary and the job log

The run's artifact expires after 90 days. For a download link that lasts,
create a release once and let the workflow attach the APK to it — the
`release_tag` input does that, and its URL is what this README links to:

```
gh release create v1.7.0 --title "THE SYSTEM 1.7.0" --notes "Signed with the stable key; installs over 1.6.0."
```

Then **Actions → Build Android APK → Run workflow**, `release_tag` = `v1.7.0`.
The job uploads `THE-SYSTEM-1.7.0.apk` (named from `appVersionName`) to that
release. Name each later release after its version (`v1.8.0`, …) and run the
workflow the same way.

These repository secrets are set on the repo, so every build from now on is
signed with the same key:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | base64 of the keystore |
| `ANDROID_KEYSTORE_PASSWORD` | store/key password |
| `ANDROID_KEY_ALIAS` | key alias (`android`) |

A build without those secrets now fails on purpose instead of signing with a
throwaway key: a new signature cannot update an installed app, so Android would
ask for an uninstall first.

Back the keystore up somewhere you will not lose it (password manager or an
offline copy). If it is lost, the next build has a new signature and every
installed copy has to be uninstalled and reinstalled by hand.

`TWA_FINGERPRINT` (`Sites → Secrets` for the Worker) is the SHA-256 of that key,
so `/.well-known/assetlinks.json` verifies the app and Chrome does not show a URL
bar. `targetSdk` is 36 because Bubblewrap 1.27 ignores 37; Play requires 37 from
August 2027.

### Install on a phone

The app opens `https://system-fitness.adharsh-bb1.workers.dev` (the owner's own
Cloudflare Worker). Release **1.7.0** (`appVersionCode` 4) is signed with the
stable key:

```
E0:C4:A5:2C:7F:5A:BD:4D:56:3F:8B:CC:B9:79:48:28
A1:3E:55:8A:66:12:6F:11:40:07:FF:D2:21:FC:C6:EA
```

That digest is in the Worker's `TWA_FINGERPRINT`, so `/.well-known/assetlinks.json`
verifies the APK and it opens fullscreen, with no address bar. `TWA_FINGERPRINT`
accepts a comma-separated list, so several signatures can be valid at once.

The key is the one 1.6.0 shipped with: run #8 generated it, `artifacts/THE-SYSTEM-1.6.0.apk`
carries the same certificate, so 1.7.0 installs straight over it — no uninstall.

1. Download **[THE-SYSTEM-1.7.0.apk](https://github.com/adharsh-entitlex/system-fitness/releases/download/v1.7.0/THE-SYSTEM-1.7.0.apk)**
   from the [v1.7.0 release](https://github.com/adharsh-entitlex/system-fitness/releases/tag/v1.7.0).
   That link is permanent — release assets do not expire the way Actions
   artifacts do (artifacts are deleted after 90 days).
2. Copy the file to the phone.
3. Tap it and allow installs from your file manager when Android asks.
   Android treats it as an update of the installed app.
4. Open **THE SYSTEM** and sign in — the same account, the same record.

`appVersionCode` in `android/twa-manifest.json` must go up for each release; a
build with the same code is not offered as an update.

The certificate digest can be re-read from an APK with `openssl pkcs7 -inform DER
-in META-INF/ANDROID.RSA -print_certs | openssl x509 -noout -fingerprint -sha256`
(after unzipping `META-INF/*` out of it), or from the run summary and job log.

## Layout

```
public/     index.html, styles.css, app.js, nutrition.js, foods.js,
            auth.js, sync.js, ai.js, push.js, sw.js, icons/
worker/     index.js (router), auth.js (accounts/OAuth), push.js (web push)
server/     server.mjs — local backend
scripts/    build-worker.mjs, make-vapid.mjs, make-icons.mjs, test-push.mjs
android/    twa-manifest.json
```
