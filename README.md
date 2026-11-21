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

## Data

Everything is stored in the browser's `localStorage` under `system-fitness-v1`. Nothing leaves your device. The gear icon holds the hunter name, water goal, weekly workout target, calorie goal and protein goal.

## Author

**Adharsh M**
