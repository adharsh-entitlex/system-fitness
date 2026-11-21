# THE SYSTEM — Personal Fitness Interface

A Solo Leveling–inspired personal fitness, hydration and nutrition tracker built for **Adharsh M**.

Plain HTML, CSS and JavaScript. No build step, no dependencies, no framework.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 3000
```

Then visit http://localhost:3000.

## Screens

- **Today** — daily workout quest with checkable exercises, skip/undo, hydration ring with reminders, streak and weekly progress.
- **Workouts** — editable workout library (name, exercises, sets, reps, weight) plus a weekly schedule.
- **Nutrition** — calorie and protein goals, meal log, Kerala pantry and dish suggestions that only use the ingredients you have.
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
| `nutrition.js` | History view, nutrition view and trainer notes |

## Data — where your history lives

Everything is stored in the browser's `localStorage` under the key `system-fitness-v1`,
as one JSON object: workout logs (`logs`, keyed by `YYYY-MM-DD`), water (`water`),
meals (`meals`), templates, schedule, pantry, goals and XP. Nothing leaves your device
and there is no server or database.

What that means in practice:

- History is **per browser and per device**. It does not sync between your phone and laptop.
- Clearing site data, using private/incognito mode, or uninstalling the browser erases it.
- Opening the page from a different origin (e.g. `file://` vs `http://localhost:3000`) is a different storage bucket.

So the gear icon holds **EXPORT BACKUP** and **IMPORT BACKUP**. Export writes
the whole state to a JSON file (`system-fitness-backup-YYYY-MM-DD.json`); import restores it
on any device or browser. Export before clearing browser data, switching devices, or updating
the app by hand.

The gear icon also holds the hunter name, water goal, weekly workout target, calorie goal
and protein goal.

## Author

**Adharsh M**
