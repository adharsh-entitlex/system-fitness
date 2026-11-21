# THE SYSTEM — Personal Fitness Interface

A Solo Leveling–inspired personal fitness, hydration and nutrition tracker built for **Adharsh M**.

Plain HTML, CSS and JavaScript, plus a small zero-dependency Node backend. No build step,
no npm packages, no framework.

## Run it

The backend serves the app and stores your record in `data/state.json`. Node 18 or newer,
nothing to install:

```bash
npm start          # equivalent to: node server/server.mjs
```

Then visit http://localhost:3000. Use `PORT=8080 npm start` to change the port.

You can still open `index.html` directly, or serve the folder with any static server
(`python3 -m http.server 3000`). The app then runs in **local-only** mode on
`localStorage` with no backend, and the footer says so.

## Screens

- **Today** — daily workout quest with checkable exercises, skip/undo, hydration ring with reminders, streak and weekly progress.
- **Workouts** — editable workout library (name, exercises, sets, reps, weight) plus a weekly schedule.
- **Nutrition** — calorie and protein goals, meal log, an editable pantry (built-in ingredient groups plus your own additions, renameable and removable), and Kerala dish suggestions that only use the ingredients you have.
- **History** — every logged session with the exercises and weights you actually used, filterable by cleared, skipped or last 7 days.
- **Progress** — 12-week quest map, streaks and a hydration chart.
- **Trainer** — notes generated from your own data: what to train next, protein and water gaps, progressive overload suggestions.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell, header and tabs |
| `styles.css` | Solo Leveling–inspired theme and responsive layout |
| `app.js` | State, storage, workouts, water, progress and settings |
| `foods.js` | Kerala dish database and pantry ingredient groups |
| `nutrition.js` | History view, nutrition view, editable pantry and trainer notes |
| `sync.js` | Backend sync: push/pull, status badge, offline fallback |
| `server/server.mjs` | Zero-dependency Node backend: REST API plus static file server |
| `package.json` | `npm start` script — no dependencies |

## Backend

`server/server.mjs` is a single-file Node server with no dependencies. It serves the static
app and persists the full tracker state.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Liveness probe, used by the app to detect the backend |
| `/api/state` | GET | The saved record: `{ revision, updatedAt, savedAt, state }` |
| `/api/state` | PUT | Save `{ state, updatedAt }`, returns the new revision |

Behaviour worth knowing:

- The record lives in **`data/state.json`** (gitignored, written atomically via a tmp file + rename).
- The whole state is one JSON document, capped at 4 MB of request body.
- The app pushes after every change, debounced by ~1 second. On load it adopts the server copy only when the server's `updatedAt` is newer than the browser's, so a stale tab cannot silently overwrite newer data. Last write wins.
- **There is no authentication.** It is a single-hunter personal server: anyone who can reach the port can read and write the record. Keep it on localhost or a private network/VPN, or put it behind an authenticating reverse proxy before exposing it.
- Any Node 18+ host works (VPS, Render, Railway, Fly.io, a Raspberry Pi). It is not a Cloudflare Worker and cannot run on static-only hosting.

The gear icon also has **PUSH NOW** and **PULL NOW**, and the footer shows the sync status
(`LOCAL ONLY`, `SYNCED · time`, or `SYNC ERROR`).

## Data — where your history lives

Two layers, same shape:

1. **`data/state.json`** on the backend — the canonical record when you run `npm start`.
2. **`localStorage['system-fitness-v1']`** in the browser — the offline cache, and the only
   store when the app is opened without the backend.

The object holds workout logs (`logs`, keyed `YYYY-MM-DD`), water (`water`, `waterBonus`),
meals (`meals`), templates, weekly schedule, pantry, goals, nutrition targets, XP and
`meta.updatedAt` (used to resolve which copy is newer).

Consequences:

- With the backend running, history follows you between browsers and devices that point at the same server.
- Without it, history is **per browser and per device**; clearing site data or using private mode erases it.
- Different origins are different storage buckets (`file://` vs `http://localhost:3000`).

So the gear icon also holds **EXPORT BACKUP** and **IMPORT BACKUP**: export writes the whole
state to `system-fitness-backup-YYYY-MM-DD.json`, import restores it anywhere. The gear also
holds the hunter name, water goal, weekly workout target, calorie goal and protein goal.

## Author

**Adharsh M**
