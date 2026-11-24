#!/usr/bin/env node
/* ======================================================================
   Smoke tests for the parts of THE SYSTEM that are pure logic.

   app.js is a classic browser script with no exports, so it is evaluated in
   a vm with a tiny DOM stub and its boot block removed. That keeps the real
   code under test instead of a copy of it: streak counting, day states, BMI
   and the weight trend have all been wrong at least once.

   Run: npm test
   ====================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { aiFailureHint, chatUrl, modelFor } from '../worker/ai.js';

const read = (name) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');

function stubElement() {
  return {
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {},
    remove() {},
    insertAdjacentHTML() {},
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    innerHTML: '',
    textContent: ''
  };
}

function makeContext() {
  const store = new Map();
  const ctx = {
    console,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    },
    document: {
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      createElement() { return stubElement(); },
      body: stubElement()
    },
    window: { addEventListener() {}, scrollTo() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: {},
    location: { origin: 'http://localhost', search: '', pathname: '/' },
    history: { replaceState() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    confirm: () => true,
    alert: () => {},
    Blob: class { constructor(parts) { this.size = String((parts || []).join('')).length; } },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('foods.js'), ctx, { filename: 'foods.js' });
  const app = read('app.js').split('/* ---------------- boot ---------------- */')[0];
  vm.runInContext(app, ctx, { filename: 'app.js' });
  vm.runInContext(read('merge.js'), ctx, { filename: 'merge.js' });
  vm.runInContext(read('training.js'), ctx, { filename: 'training.js' });
  vm.runInContext(read('coach.js'), ctx, { filename: 'coach.js' });
  return ctx;
}

const ctx = makeContext();
const run = (code) => vm.runInContext(code, ctx);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}

/* ---------------- levels and ranks ---------------- */

check('level starts at 1 and advances every 500 XP', () => {
  assert.equal(run('levelOf(0)'), 1);
  assert.equal(run('levelOf(499)'), 1);
  assert.equal(run('levelOf(500)'), 2);
  assert.equal(run('levelOf(5000)'), 11);
});

check('rank follows level and tops out at S', () => {
  assert.equal(run('rankOf(1)'), 'E');
  assert.equal(run('rankOf(3)'), 'D');
  assert.equal(run('rankOf(30)'), 'S');
});

/* ---------------- streak ---------------- */

check('streak counts consecutive cleared days across rest days', () => {
  const streak = run(`(() => {
    state.logs = {};
    state.schedule = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
    [1, 2, 3].forEach((n) => { state.logs[keyOf(addDays(new Date(), -n))] = { status: 'completed', exercises: [] }; });
    return computeStreak();
  })()`);
  assert.equal(streak, 3);
});

check('today never breaks the streak', () => {
  const streak = run(`(() => {
    state.logs = {};
    state.schedule = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
    [1, 2].forEach((n) => { state.logs[keyOf(addDays(new Date(), -n))] = { status: 'completed', exercises: [] }; });
    return computeStreak();
  })()`);
  assert.equal(streak, 2);
});

check('a missed scheduled day stops the streak', () => {
  const streak = run(`(() => {
    state.logs = {};
    const day = addDays(new Date(), -5);
    state.schedule = { 0: 'x', 1: 'x', 2: 'x', 3: 'x', 4: 'x', 5: 'x', 6: 'x' };
    state.logs[keyOf(addDays(new Date(), -1))] = { status: 'completed', exercises: [] };
    state.logs[keyOf(addDays(new Date(), -2))] = { status: 'completed', exercises: [] };
    // -3 is scheduled and missing: the run ends there.
    return computeStreak();
  })()`);
  assert.equal(streak, 2);
});

/* ---------------- day state ---------------- */

check('days before the record began are not missed', () => {
  const st = run(`(() => {
    state.logs = {};
    state.meta = { ...(state.meta || {}), startedAt: keyOf(addDays(new Date(), -2)) };
    return dayState(keyOf(addDays(new Date(), -10)));
  })()`);
  assert.equal(st, 'pre');
});

check('a cleared day reports done', () => {
  const st = run(`(() => {
    state.logs = {};
    state.logs[todayKey()] = { status: 'completed', exercises: [] };
    return dayState(todayKey());
  })()`);
  assert.equal(st, 'done');
});

/* ---------------- body maths ---------------- */

check('BMI uses height in metres', () => {
  const bmi = run('bmiOf({ heightCm: 180, weightKg: 81 })');
  assert.equal(Number(bmi.toFixed(1)), 25);
});

check('weight trend reports kg and days between first and last', () => {
  const trend = run(`(() => {
    state.weights = {};
    state.weights[keyOf(addDays(new Date(), -10))] = 80;
    state.weights[todayKey()] = 77.5;
    return weightDelta(weightEntries());
  })()`);
  assert.equal(trend.kg, -2.5);
  assert.equal(trend.days, 10);
});

check('backfilled sessions count towards the total', () => {
  const total = run(`(() => {
    state.logs = {
      [keyOf(addDays(new Date(), -20))]: { status: 'completed', exercises: [] },
      [keyOf(addDays(new Date(), -19))]: { status: 'skipped', exercises: [] }
    };
    return completedTotal();
  })()`);
  assert.equal(total, 1);
});

/* ---------------- AI transport helpers ---------------- */

check('chatUrl appends the completion path once', () => {
  assert.equal(chatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    chatUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  );
});

check('the model follows the provider', () => {
  assert.equal(modelFor('https://api.groq.com/openai/v1'), 'openai/gpt-oss-120b');
  assert.equal(modelFor('https://api.openai.com/v1'), 'gpt-4o-mini');
});

check('a rejected key is named as a key problem, not an outage', () => {
  const hint = aiFailureHint({
    ok: false,
    attempts: [
      { host: 'api.openai.com', status: 401, reason: 'Incorrect API key provided' },
      { host: 'api.groq.com', status: 401, reason: 'Invalid API Key' }
    ]
  });
  assert.match(hint, /rejected/);
  assert.match(hint, /api\.openai\.com/);
  assert.match(hint, /replace the secret/);
});

/* ---------------- conflict merge ---------------- */

check('merging two devices keeps the sets from both', () => {
  const out = run(`(() => {
    const mine = defaultState();
    mine.meta.updatedAt = 2000;
    mine.logs[todayKey()] = { status: 'completed', templateId: 'push', exercises: [
      { name: 'Bench Press', sets: 3, reps: 8, weight: 60, log: [{ reps: 8, weight: 60 }] }
    ] };
    const theirs = defaultState();
    theirs.meta.updatedAt = 1000;
    theirs.logs[todayKey()] = { status: 'pending', templateId: 'push', exercises: [
      { name: 'Bench Press', sets: 3, reps: 8, weight: 62.5, log: [{ reps: 6, weight: 62.5 }] }
    ] };
    const merged = mergeStates(mine, theirs);
    return {
      sets: merged.logs[todayKey()].exercises[0].log.length,
      status: merged.logs[todayKey()].status,
      water: merged.water[todayKey()] || 0
    };
  })()`);
  assert.equal(out.sets, 2);
  assert.equal(out.status, 'completed');
});

check('merging keeps the larger water total and both logged days', () => {
  const out = run(`(() => {
    const mine = defaultState();
    mine.meta.updatedAt = 5000;
    mine.water[todayKey()] = 1000;
    mine.logs[keyOf(addDays(new Date(), -1))] = { status: 'completed', exercises: [] };
    const theirs = defaultState();
    theirs.meta.updatedAt = 4000;
    theirs.water[todayKey()] = 2500;
    theirs.logs[keyOf(addDays(new Date(), -2))] = { status: 'completed', exercises: [] };
    const merged = mergeStates(mine, theirs);
    return { water: merged.water[todayKey()], days: Object.keys(merged.logs).length };
  })()`);
  assert.equal(out.water, 2500);
  assert.equal(out.days, 2);
});

/* ---------------- autoregulation and plates ---------------- */

check('estimated one-rep max follows weight and reps', () => {
  assert.equal(run('e1rmOf({ weight: 100, reps: 5 })'), 116.7);
  assert.equal(run('e1rmOf({ weight: 0, reps: 10 })'), 0);
});

check('plates split evenly per side', () => {
  const out = run('platesPerSide(100)');
  assert.deepEqual(Array.from(out.perSide), [25, 15]);
  assert.equal(out.leftover, 0);
  assert.equal(run('platesPerSide(20).perSide.length'), 0);
  assert.equal(run('platesPerSide(10).under'), true);
});

check('warm-up ladder rises to the working weight', () => {
  const ladder = run('warmupLadder(100)');
  assert.deepEqual(Array.from(ladder.map((step) => step.weight)), [40, 60, 80]);
  assert.deepEqual(Array.from(ladder.map((step) => step.reps)), [8, 5, 3]);
});

/* ---------------- retention, streaks and archiving ---------------- */

check('a marked rest day keeps the streak alive', () => {
  const streak = run(`(() => {
    state.logs = {};
    state.restDays = {};
    state.schedule = { 0: 'x', 1: 'x', 2: 'x', 3: 'x', 4: 'x', 5: 'x', 6: 'x' };
    state.logs[keyOf(addDays(new Date(), -1))] = { status: 'completed', exercises: [] };
    state.logs[keyOf(addDays(new Date(), -2))] = { status: 'completed', exercises: [] };
    state.restDays[keyOf(addDays(new Date(), -3))] = true;
    return computeStreak();
  })()`);
  assert.equal(streak, 2);
});

check('old detail rolls into a monthly summary', () => {
  const out = run(`(() => {
    state = defaultState();
    state.logs['2020-01-05'] = { status: 'completed', templateId: 'push', exercises: [
      { name: 'Bench Press', sets: 3, reps: 8, weight: 60, log: [{ reps: 8, weight: 60 }] }
    ] };
    state.water['2020-01-05'] = 2000;
    const removed = pruneHistory();
    return { removed, archive: state.archive['2020-01'], water: state.water['2020-01-05'] };
  })()`);
  assert.equal(out.removed, 1);
  assert.equal(out.archive.sessions, 1);
  assert.equal(out.archive.load, 480);
  assert.equal(out.water, undefined);
});

/* ---------------- readiness, swaps, analytics ---------------- */

check('readiness scores sleep, energy and soreness into one number', () => {
  assert.equal(run('readinessScore({ sleep: 5, energy: 5, soreness: 1 })'), 100);
  // Worst answers still score 20: three 1s average 3/15 before the percentage.
  assert.equal(run('readinessScore({ sleep: 1, energy: 1, soreness: 5 })'), 20);
  assert.equal(run('readinessScore(null)'), null);
});

check('a wrecked check-in recommends less load than a primed one', () => {
  const primed = run('readinessAdvice(100)');
  const wrecked = run('readinessAdvice(20)');
  assert.equal(primed.label, 'PRIMED');
  assert.equal(wrecked.label, 'RECOVER');
  // A hard day is not an error state: the low score keeps the neutral tone.
  assert.equal(wrecked.tone, '');
  assert.ok(wrecked.factor < 1);
  assert.ok(primed.factor >= 1);
});

check('readiness moves the suggested weight and rounds to a plate step', () => {
  const out = run(`(() => {
    state = defaultState();
    state.readiness[todayKey()] = { sleep: 5, energy: 5, soreness: 1 };
    const primed = readinessTargetHtml(100);
    state.readiness[todayKey()] = { sleep: 1, energy: 1, soreness: 5 };
    const wrecked = readinessTargetHtml(100);
    state.readiness = {};
    return { primed, wrecked, none: readinessTargetHtml(100) };
  })()`);
  assert.match(out.primed, /TODAY 105 KG/);
  assert.match(out.wrecked, /TODAY 85 KG/);
  assert.equal(out.none, '');
});

check('an exercise maps to its movement pattern', () => {
  assert.equal(run("patternOf('Bench Press')"), 'horiz-push');
  assert.equal(run("patternOf('Romanian Deadlift')"), 'hinge');
  assert.equal(run("patternOf('Lat Pulldown')"), 'pull');
  assert.equal(run("patternOf('Leg Extension')"), 'squat');
  assert.equal(run("patternOf('Calf Raise')"), 'calves');
});

check('swap candidates follow equipment and the avoided reasons', () => {
  const out = run(`(() => {
    state = defaultState();
    state.meta.program = { equipment: 'home', experience: 'beginner', days: 3 };
    const plain = swapCandidates('Bench Press', [], 'home').map((row) => row.name);
    const noShoulder = swapCandidates('Bench Press', ['shoulder'], 'home').map((row) => row.name);
    return { plain, noShoulder };
  })()`);
  assert.ok(out.plain.includes('Dumbbell Floor Press'));
  assert.ok(!out.plain.includes('Back Squat'));
  assert.ok(!out.noShoulder.includes('Dumbbell Floor Press'));
});

check('the sparkline fits every point inside its box', () => {
  const path = run('sparklinePath([10, 20, 15, 30], 120, 30)');
  assert.match(path, /^M0\.0 /);
  assert.equal((path.match(/L/g) || []).length, 3);
  assert.equal(run('sparklinePath([5], 120, 30)'), '');
});

check('the load check is the only e1RM view, sparkline and records included', () => {
  const html = run(`(() => {
    state = defaultState();
    state.templates = [{ id: 'squat-day', name: 'SQUAT DAY', exercises: [{ name: 'Back Squat' }] }];
    state.logs = {
      '2026-01-02': { status: 'completed', exercises: [{ name: 'Back Squat', log: [{ reps: 5, weight: 100 }] }] },
      '2026-01-09': { status: 'completed', exercises: [{ name: 'Back Squat', log: [{ reps: 5, weight: 105 }] }] }
    };
    return loadCheckHtml();
  })()`);
  assert.match(html, /LOAD CHECK/);
  assert.match(html, /class="spark"/);
  assert.match(html, /RECORD TIMELINE/);
  assert.doesNotMatch(html, /LIFT PROGRESS/);
});

check('the set export is a CSV with one row per logged set', () => {
  const csv = run(`(() => {
    state = defaultState();
    state.logs['2026-01-02'] = { status: 'completed', templateId: 'push', exercises: [
      { name: 'Bench Press', sets: 3, reps: 8, weight: 60, log: [{ reps: 8, weight: 60 }, { reps: 7, weight: 62.5 }] }
    ] };
    return csvOfSets();
  })()`);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'date,workout,exercise,set,weight_kg,reps,volume_kg');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /2026-01-02,PUSH DAY,Bench Press,1,60,8,480/);
});

check('the recap counts only the last four weeks', () => {
  const out = run(`(() => {
    state = defaultState();
    state.logs = {
      [keyOf(addDays(new Date(), -2))]: { status: 'completed', exercises: [
        { name: 'Back Squat', sets: 3, reps: 5, weight: 100, log: [{ reps: 5, weight: 100 }] }
      ] },
      [keyOf(addDays(new Date(), -200))]: { status: 'completed', exercises: [] }
    };
    const r = recapStats();
    return { sessions: r.sessions, volume: r.volume, lifts: r.lifts.length };
  })()`);
  assert.equal(out.sessions, 1);
  assert.equal(out.volume, 500);
  assert.equal(out.lifts, 1);
});

check('merging keeps readiness days and swap choices from both devices', () => {
  const out = run(`(() => {
    const mine = defaultState();
    mine.meta.updatedAt = 4000;
    mine.readiness['2026-01-01'] = { sleep: 4, energy: 4, soreness: 2 };
    mine.constraints = { avoid: ['knee'], swaps: { 'bench press': 'Push-up' } };
    const theirs = defaultState();
    theirs.meta.updatedAt = 3000;
    theirs.readiness['2026-01-02'] = { sleep: 2, energy: 2, soreness: 4 };
    theirs.constraints = { avoid: ['overhead'], swaps: { 'back squat': 'Leg Press' } };
    const merged = mergeStates(mine, theirs);
    return {
      days: Object.keys(merged.readiness).length,
      avoid: Array.from(merged.constraints.avoid).sort(),
      swaps: Object.keys(merged.constraints.swaps).length
    };
  })()`);
  assert.equal(out.days, 2);
  assert.deepEqual(Array.from(out.avoid), ['knee', 'overhead']);
  assert.equal(out.swaps, 2);
});

/* ---------------- report ---------------- */

const failed = results.filter((r) => !r.ok);
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
