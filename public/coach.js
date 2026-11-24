'use strict';

/* ======================================================================
   Coach extensions
   ----------------------------------------------------------------------
   Loaded after training.js; shares the same `state`.

   - readiness   a ten-second morning check-in that picks today's load
   - swaps       a movement can be replaced when equipment or a joint says no
   - analytics   per-lift e1RM trend, volume and a PR timeline
   - recap       one shareable card of the whole hunt
   - csv         spreadsheet exports of logged sets and weigh-ins
   ====================================================================== */

/* ---------------- readiness ---------------- */

const READINESS_FIELDS = [
  { key: 'sleep', label: 'SLEEP', low: 'WRECKED', high: 'GREAT' },
  { key: 'soreness', label: 'SORENESS', low: 'NONE', high: 'BEAT UP' },
  { key: 'energy', label: 'ENERGY', low: 'FLAT', high: 'PRIMED' }
];

function readinessOf(key) {
  const raw = (state.readiness || {})[key || todayKey()];
  return raw && typeof raw === 'object' ? raw : null;
}

/* 0–100. Sleep and energy are good when high; soreness is good when low, so
   the third term is flipped before the three are averaged. */
function readinessScore(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sleep = clampNum(entry.sleep, 1, 5, 3);
  const energy = clampNum(entry.energy, 1, 5, 3);
  const soreness = clampNum(entry.soreness, 1, 5, 3);
  return Math.round(((sleep + energy + (6 - soreness)) / 15) * 100);
}

function readinessAdvice(score) {
  if (score == null) {
    return { label: 'NO CHECK-IN', tone: '', factor: 1, note: 'Answer the three questions and today\u2019s load is picked for you.' };
  }
  if (score >= 80) {
    return { label: 'PRIMED', tone: 'is-good', factor: 1.05, note: 'Sleep and energy are there — take the extra 2.5 kg if the warm-up moves well.' };
  }
  if (score >= 60) {
    return { label: 'STEADY', tone: '', factor: 1, note: 'A normal day: run the plan as written.' };
  }
  if (score >= 40) {
    return { label: 'HOLD', tone: '', factor: 0.95, note: 'Short on recovery — hold last session\u2019s weight and keep every rep clean.' };
  }
  return { label: 'RECOVER', tone: '', factor: 0.85, note: 'Take 10% off the bar, or mark today a rest day. A bad session buys nothing.' };
}

/* The line the set logger prints: last session's top weight adjusted by
   today's readiness, rounded to a weight the plates can actually make. */
function readinessTargetHtml(weight) {
  const score = readinessScore(readinessOf());
  const base = Math.round((Number(weight) || 0) / 2.5) * 2.5;
  if (score == null || !(base > 0)) return '';
  const advice = readinessAdvice(score);
  const target = Math.max(2.5, Math.round((base * advice.factor) / 2.5) * 2.5);
  const head = `READINESS ${score} · ${advice.label}`;
  return target === base
    ? `<p class="readiness-line">${head} · HOLD ${base} KG TODAY</p>`
    : `<p class="readiness-line ${advice.tone}">${head} · TODAY ${target} KG (LAST ${base} KG)</p>`;
}

function saveReadiness() {
  const entry = {};
  READINESS_FIELDS.forEach((field) => {
    const el = $(`[data-readiness="${field.key}"]`);
    entry[field.key] = clampNum(el ? el.value : 3, 1, 5, 3);
  });
  state.readiness = state.readiness || {};
  state.readiness[todayKey()] = { ...entry, at: Date.now() };
  save();
  renderAll();
  const score = readinessScore(entry);
  const advice = readinessAdvice(score);
  toast(`Readiness ${score}/100 · ${advice.label}. ${advice.note}`, 'gold');
}

function readinessCardHtml() {
  const entry = readinessOf();
  const score = readinessScore(entry);
  const advice = readinessAdvice(score);
  const selects = READINESS_FIELDS.map((field) => {
    const current = Number(entry && entry[field.key]) || 3;
    const options = [1, 2, 3, 4, 5]
      .map((n) => {
        const edge = n === 1 ? ` · ${field.low}` : n === 5 ? ` · ${field.high}` : '';
        return `<option value="${n}"${current === n ? ' selected' : ''}>${n}${edge}</option>`;
      })
      .join('');
    return `<label class="field"><span class="lbl">${field.label}</span>
      <select data-readiness="${field.key}">${options}</select>
    </label>`;
  }).join('');

  return `
    <div class="section-head">
      <h2>READINESS</h2>
      <div class="line"></div>
      <span class="hint">${score == null ? 'not checked in' : `${score}/100 · ${advice.label}`}</span>
    </div>
    <div class="panel readiness-panel">
      <div class="form-grid three">${selects}</div>
      <p class="panel-sub ${advice.tone}" style="margin:10px 0 0;line-height:1.6">${esc(advice.note)}</p>
      <div class="modal-actions" style="margin-top:10px;justify-content:flex-start">
        <button class="btn${score == null ? ' primary' : ''}" data-act="save-readiness">${score == null ? 'CHECK IN' : 'UPDATE CHECK-IN'}</button>
      </div>
    </div>`;
}

function coachIntoToday() {
  const today = document.getElementById('view-today');
  if (!today) return;
  const old = today.querySelector('[data-coach="readiness"]');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.setAttribute('data-coach', 'readiness');
  wrap.className = 'coach-readiness';
  wrap.innerHTML = readinessCardHtml();
  today.insertBefore(wrap, today.firstChild);
}

/* ---------------- exercise substitution ----------------
   The pattern, not the name, is what makes a movement replaceable: any
   horizontal push can stand in for a bench press. Tags mark the reasons a
   substitute is refused when the hunter has flagged them. */

const AVOID_TAGS = [
  ['overhead', 'OVERHEAD PRESSING'],
  ['spine', 'HEAVY SPINAL LOAD'],
  ['knee', 'DEEP KNEE BEND'],
  ['shoulder', 'SHOULDER STRAIN']
];

const SUBSTITUTES = [
  { name: 'Back Squat', pattern: 'squat', equipment: ['gym'], tags: ['spine', 'knee'] },
  { name: 'Front Squat', pattern: 'squat', equipment: ['gym'], tags: ['spine', 'knee'] },
  { name: 'Leg Press', pattern: 'squat', equipment: ['gym'], tags: ['spine'] },
  { name: 'Hack Squat', pattern: 'squat', equipment: ['gym'], tags: ['knee'] },
  { name: 'Leg Extension', pattern: 'squat', equipment: ['gym'], tags: ['knee'] },
  { name: 'Goblet Squat', pattern: 'squat', equipment: ['gym', 'home'], tags: ['knee'] },
  { name: 'Dumbbell Split Squat', pattern: 'squat', equipment: ['gym', 'home'], tags: ['knee'] },
  { name: 'Bodyweight Squat', pattern: 'squat', equipment: ['bodyweight', 'home'], tags: ['knee'] },
  { name: 'Wall Sit', pattern: 'squat', equipment: ['bodyweight'] },
  { name: 'Deadlift', pattern: 'hinge', equipment: ['gym'], tags: ['spine'] },
  { name: 'Romanian Deadlift', pattern: 'hinge', equipment: ['gym'], tags: ['spine'] },
  { name: 'Good Morning', pattern: 'hinge', equipment: ['gym'], tags: ['spine'] },
  { name: 'Hip Thrust', pattern: 'hinge', equipment: ['gym', 'home'], tags: ['spine'] },
  { name: 'Dumbbell RDL', pattern: 'hinge', equipment: ['gym', 'home'], tags: ['spine'] },
  { name: 'Leg Curl', pattern: 'hinge', equipment: ['gym'] },
  { name: 'Glute Bridge', pattern: 'hinge', equipment: ['home', 'bodyweight'] },
  { name: 'Nordic Curl', pattern: 'hinge', equipment: ['bodyweight'] },
  { name: 'Bench Press', pattern: 'horiz-push', equipment: ['gym'], tags: ['shoulder'] },
  { name: 'Incline Dumbbell Press', pattern: 'horiz-push', equipment: ['gym', 'home'], tags: ['shoulder'] },
  { name: 'Dumbbell Floor Press', pattern: 'horiz-push', equipment: ['home', 'gym'], tags: ['shoulder'] },
  { name: 'Chest Press Machine', pattern: 'horiz-push', equipment: ['gym'], tags: ['shoulder'] },
  { name: 'Push-up', pattern: 'horiz-push', equipment: ['bodyweight', 'home', 'gym'], tags: ['shoulder'] },
  { name: 'Dip', pattern: 'horiz-push', equipment: ['gym', 'bodyweight'], tags: ['shoulder'] },
  { name: 'Overhead Press', pattern: 'vert-push', equipment: ['gym'], tags: ['overhead', 'shoulder'] },
  { name: 'Dumbbell Overhead Press', pattern: 'vert-push', equipment: ['home', 'gym'], tags: ['overhead', 'shoulder'] },
  { name: 'Arnold Press', pattern: 'vert-push', equipment: ['gym', 'home'], tags: ['overhead', 'shoulder'] },
  { name: 'Pike Push-up', pattern: 'vert-push', equipment: ['bodyweight', 'home'], tags: ['overhead', 'shoulder'] },
  { name: 'Landmine Press', pattern: 'vert-push', equipment: ['gym'], tags: ['shoulder'] },
  { name: 'Barbell Row', pattern: 'pull', equipment: ['gym'], tags: ['spine'] },
  { name: 'Seated Cable Row', pattern: 'pull', equipment: ['gym'] },
  { name: 'Lat Pulldown', pattern: 'pull', equipment: ['gym'] },
  { name: 'Pull-up', pattern: 'pull', equipment: ['gym', 'bodyweight'] },
  { name: 'Chin-up', pattern: 'pull', equipment: ['gym', 'bodyweight'] },
  { name: 'Dumbbell Row', pattern: 'pull', equipment: ['gym', 'home'] },
  { name: 'Inverted Row', pattern: 'pull', equipment: ['bodyweight', 'home'] },
  { name: 'Lateral Raise', pattern: 'delt', equipment: ['gym', 'home'] },
  { name: 'Dumbbell Lateral Raise', pattern: 'delt', equipment: ['home', 'gym'] },
  { name: 'Face Pull', pattern: 'delt', equipment: ['gym'] },
  { name: 'Reverse Fly', pattern: 'delt', equipment: ['gym', 'home', 'bodyweight'] },
  { name: 'Rear Delt Machine', pattern: 'delt', equipment: ['gym'] },
  { name: 'Barbell Curl', pattern: 'biceps', equipment: ['gym'] },
  { name: 'Cable Curl', pattern: 'biceps', equipment: ['gym'] },
  { name: 'Dumbbell Curl', pattern: 'biceps', equipment: ['home', 'gym'] },
  { name: 'Hammer Curl', pattern: 'biceps', equipment: ['home', 'gym'] },
  { name: 'Triceps Pushdown', pattern: 'triceps', equipment: ['gym'] },
  { name: 'Skull Crusher', pattern: 'triceps', equipment: ['gym'] },
  { name: 'Overhead Extension', pattern: 'triceps', equipment: ['home', 'gym'], tags: ['overhead'] },
  { name: 'Close-grip Push-up', pattern: 'triceps', equipment: ['bodyweight', 'home', 'gym'] },
  { name: 'Bench Dip', pattern: 'triceps', equipment: ['home', 'bodyweight'] },
  { name: 'Calf Raise', pattern: 'calves', equipment: ['gym', 'home'] },
  { name: 'Single-leg Calf Raise', pattern: 'calves', equipment: ['bodyweight', 'home'] },
  { name: 'Plank', pattern: 'core', equipment: ['gym', 'home', 'bodyweight'] },
  { name: 'Hollow Hold', pattern: 'core', equipment: ['gym', 'home', 'bodyweight'] },
  { name: 'Dead Bug', pattern: 'core', equipment: ['home', 'bodyweight'] },
  { name: 'Ab Wheel', pattern: 'core', equipment: ['gym'] }
];

function patternOf(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'other';
  if (/calf/.test(n)) return 'calves';
  if (/leg curl|nordic|hamstring/.test(n)) return 'hinge';
  if (/squat|leg press|lunge|split squat|leg extension|wall sit/.test(n)) return 'squat';
  if (/deadlift|rdl|romanian|good morning|hip thrust|glute bridge|hinge/.test(n)) return 'hinge';
  if (/overhead press|shoulder press|arnold|pike|landmine/.test(n)) return 'vert-push';
  if (/bench|floor press|push-up|pushup|chest press|\bdip\b/.test(n)) return 'horiz-push';
  if (/press/.test(n)) return 'horiz-push';
  if (/pulldown|pull-up|pullup|chin-up|chinup/.test(n)) return 'pull';
  if (/row/.test(n)) return 'pull';
  if (/lateral raise|face pull|reverse fly|rear delt/.test(n)) return 'delt';
  if (/curl/.test(n)) return 'biceps';
  if (/triceps|pushdown|skull|extension/.test(n)) return 'triceps';
  if (/plank|hollow|sit-up|crunch|dead bug|ab wheel/.test(n)) return 'core';
  return 'other';
}

function equipmentOf() {
  const pref = (state.meta && state.meta.program) || {};
  return pref.equipment || 'gym';
}

function avoidList() {
  const list = (state.constraints && state.constraints.avoid) || [];
  return Array.isArray(list) ? list : [];
}

/* Same pattern, different movement, available with this equipment, and not
   excluded by an avoided reason. If a filter empties the list, the equipment
   filter is relaxed rather than leaving the hunter with nothing. */
function swapCandidates(name, avoid, equipment) {
  const pattern = patternOf(name);
  const needle = String(name || '').toLowerCase();
  const avoided = Array.isArray(avoid) ? avoid : [];
  const samePattern = SUBSTITUTES
    .filter((item) => item.pattern === pattern && item.name.toLowerCase() !== needle)
    .filter((item) => !(item.tags || []).some((tag) => avoided.indexOf(tag) >= 0));
  const forEquipment = samePattern.filter((item) => item.equipment.indexOf(equipment || 'gym') >= 0);
  const list = forEquipment.length ? forEquipment : samePattern;
  return list.map((item) => ({ name: item.name, tags: item.tags || [] }));
}

function openSwap(key, index) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return;
  const equipment = equipmentOf();
  const avoid = avoidList();
  const candidates = swapCandidates(ex.name, avoid, equipment);
  const remembered = ((state.constraints || {}).swaps || {})[String(ex.name).toLowerCase()];

  const rows = candidates.map((item) => {
    const reason = item.tags.length ? item.tags.join(' · ').toUpperCase() : 'SAME PATTERN';
    return `<li class="set-row swap-row">
      <span class="set-val">${esc(item.name)}</span>
      <span class="swap-tag">${esc(reason)}</span>
      <button class="btn ghost sm" data-act="swap-pick" data-key="${key}" data-i="${index}" data-name="${esc(item.name)}">USE</button>
    </li>`;
  }).join('');

  const toggles = AVOID_TAGS.map(([tag, label]) => `
    <label class="switch swap-switch">
      <input type="checkbox" data-avoid="${tag}"${avoid.indexOf(tag) >= 0 ? ' checked' : ''} />
      <span class="track2"></span>
      <span class="sw-label">${label}</span>
    </label>`).join('');

  openModal(`
    <h2>SWAP MOVEMENT</h2>
    <div class="sub">${esc(ex.name)} · ${patternOf(ex.name).replace('-', ' ')} · ${esc(equipment)}</div>
    <p class="panel-sub" style="margin:0 0 12px;line-height:1.6">Replace today's movement with one that trains the same thing. Your logged history stays with the original name.</p>
    ${remembered ? `<p class="panel-sub" style="margin:0 0 10px;line-height:1.6">You swapped this before: <b>${esc(remembered)}</b></p>
      <div class="modal-actions" style="margin:0 0 12px;justify-content:flex-start">
        <button class="btn" data-act="swap-pick" data-key="${key}" data-i="${index}" data-name="${esc(remembered)}">USE ${esc(String(remembered).toUpperCase())}</button>
      </div>` : ''}
    <div class="swap-avoids">${toggles}</div>
    ${rows ? `<ul class="set-list">${rows}</ul>` : '<div class="empty">No alternative is left with those limits. Clear one, or type a movement below.</div>'}
    <label class="field"><span class="lbl">OR TYPE ANY MOVEMENT</span>
      <input type="text" maxlength="60" data-swap-custom value="" placeholder="e.g. Smith Machine Press" />
    </label>
    <div class="modal-actions">
      <button class="btn primary" data-act="swap-custom" data-key="${key}" data-i="${index}">USE THAT</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

function swapExercise(key, index, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) { toast('Pick or type a movement first.', 'danger'); return false; }
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return false;
  const previous = ex.name;
  if (String(previous).toLowerCase() === clean.toLowerCase()) { closeModal(); return false; }
  if (setsOf(ex).length && !confirm(`Keep the ${setsOf(ex).length} set(s) already logged under "${previous}"?`)) return false;
  ex.name = clean;
  state.constraints = state.constraints || { avoid: [], swaps: {} };
  state.constraints.swaps = { ...(state.constraints.swaps || {}), [String(previous).toLowerCase()]: clean };
  save();
  closeModal();
  renderAll();
  toast(`${previous} → ${clean}. Remembered for next time.`, 'gold');
  return true;
}

function toggleAvoid(tag, on) {
  const list = avoidList().filter((item) => item !== tag);
  if (on) list.push(tag);
  state.constraints = { ...(state.constraints || {}), avoid: list };
  save();
}

/* ---------------- per-lift analytics ---------------- */

function analyticsLifts(limit) {
  const names = [];
  Object.keys(state.logs || {}).sort().forEach((key) => {
    ((state.logs[key] || {}).exercises || []).forEach((ex) => {
      if (!ex || !ex.name) return;
      if (!setsOf(ex).length) return;
      if (names.indexOf(ex.name) < 0) names.push(ex.name);
    });
  });
  return names
    .map((name) => ({ name, series: e1rmSeries(name) }))
    .filter((row) => row.series.length)
    .sort((a, b) => b.series.length - a.series.length)
    .slice(0, limit || 4);
}

/* An SVG polyline for a series, normalised into a `width` × `height` box. */
function sparklinePath(values, width, height) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return '';
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const stepX = width / (nums.length - 1);
  return nums
    .map((n, i) => `${i ? 'L' : 'M'}${(i * stepX).toFixed(1)} ${(height - ((n - min) / span) * height).toFixed(1)}`)
    .join(' ');
}

function liftChangePct(series, lookback) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const span = Math.min(series.length - 1, Math.max(1, lookback || 4));
  const from = Number(series[series.length - 1 - span].e1rm) || 0;
  const to = Number(series[series.length - 1].e1rm) || 0;
  if (!(from > 0) || !(to > 0)) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

function recentPrs(limit) {
  const best = new Map();
  const out = [];
  Object.keys(state.logs || {}).sort().forEach((key) => {
    ((state.logs[key] || {}).exercises || []).forEach((ex) => {
      if (!ex || !ex.name) return;
      setsOf(ex).forEach((set) => {
        const weight = Number(set.weight) || 0;
        if (!(weight > 0)) return;
        const name = String(ex.name);
        const previous = best.get(name) || 0;
        if (weight > previous) {
          best.set(name, weight);
          out.push({ key, name, weight, reps: Number(set.reps) || 0, gain: Math.round((weight - previous) * 10) / 10 });
        }
      });
    });
  });
  return out.slice(-(limit || 6)).reverse();
}

/* ---------------- CSV export ---------------- */

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function csvOfSets() {
  const rows = [['date', 'workout', 'exercise', 'set', 'weight_kg', 'reps', 'volume_kg']];
  Object.keys(state.logs || {}).sort().forEach((key) => {
    const log = state.logs[key] || {};
    const template = (state.templates || []).find((tpl) => tpl.id === log.templateId);
    (log.exercises || []).forEach((ex) => {
      setsOf(ex).forEach((set, i) => {
        const weight = Number(set.weight) || 0;
        const reps = Number(set.reps) || 0;
        rows.push([key, template ? template.name : (log.templateId || ''), ex.name || '', i + 1, weight, reps, Math.round(weight * reps * 10) / 10]);
      });
    });
  });
  return csvRows(rows);
}

function csvOfWeighIns() {
  const rows = [['date', 'weight_kg']];
  Object.keys(state.weights || {}).sort().forEach((key) => {
    rows.push([key, Number(state.weights[key]) || 0]);
  });
  return csvRows(rows);
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSetsCsv() {
  downloadText(`system-fitness-sets-${todayKey()}.csv`, csvOfSets(), 'text/csv;charset=utf-8');
  toast('Set log exported. Open it in any spreadsheet.', 'gold');
}

function exportWeighInsCsv() {
  downloadText(`system-fitness-weigh-ins-${todayKey()}.csv`, csvOfWeighIns(), 'text/csv;charset=utf-8');
  toast('Weigh-ins exported as CSV.', 'gold');
}

/* ---------------- progress recap card ---------------- */

function recapStats() {
  const level = levelOf(state.xp);
  const cutoff = keyOf(addDays(new Date(), -27));
  let sessions = 0;
  let volume = 0;
  let waterDays = 0;
  let proteinDays = 0;
  Object.keys(state.logs || {}).forEach((key) => {
    if (key < cutoff) return;
    const log = state.logs[key];
    if (log && log.status === 'completed') sessions += 1;
    ((log && log.exercises) || []).forEach((ex) => {
      setsOf(ex).forEach((set) => {
        volume += (Number(set.weight) || 0) * (Number(set.reps) || 0);
      });
    });
  });
  for (let i = 0; i < 28; i++) {
    const key = keyOf(addDays(new Date(), -i));
    if ((state.water[key] || 0) >= (state.goals.water || 2500)) waterDays += 1;
    const protein = (state.meals[key] || []).reduce((n, meal) => n + (Number(meal.protein) || 0), 0);
    if (protein >= (state.nutrition.protein || 140)) proteinDays += 1;
  }
  const lifts = analyticsLifts(3).map(({ name, series }) => ({
    name,
    now: series[series.length - 1].e1rm,
    change: liftChangePct(series, 8)
  }));
  const prs = recentPrs(40).filter((pr) => pr.key >= cutoff).length;
  return {
    level,
    rank: rankOf(level),
    streak: computeStreak(),
    xp: state.xp,
    sessions,
    volume: Math.round(volume),
    lifts,
    prs,
    waterDays,
    proteinDays,
    days: 28
  };
}

async function shareRecap() {
  const r = recapStats();
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  if (!ctx) { toast('This browser cannot draw the card.', 'danger'); return; }

  const bg = ctx.createLinearGradient(0, 0, 1080, 1350);
  bg.addColorStop(0, '#0b1a33');
  bg.addColorStop(1, '#05070f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1080, 1350);

  ctx.strokeStyle = 'rgba(95,230,255,.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(48, 48, 984, 1254);

  ctx.fillStyle = '#5fe6ff';
  ctx.font = '600 34px Orbitron, sans-serif';
  ctx.fillText('THE SYSTEM', 96, 150);
  ctx.fillStyle = '#8ea9c9';
  ctx.font = '500 26px Rajdhani, sans-serif';
  ctx.fillText('PROGRESS RECAP · LAST 28 DAYS', 96, 196);

  ctx.fillStyle = '#dff2ff';
  ctx.font = '700 150px Orbitron, sans-serif';
  ctx.fillText(`LV ${r.level}`, 96, 400);
  ctx.font = '600 44px Rajdhani, sans-serif';
  ctx.fillStyle = '#5fe6ff';
  ctx.fillText(`RANK ${r.rank} · ${r.streak}-DAY STREAK`, 96, 470);

  const rows = [
    ['SESSIONS', String(r.sessions)],
    ['VOLUME', `${r.volume.toLocaleString()} KG`],
    ['RECORDS', String(r.prs)],
    ['WATER GOAL', `${r.waterDays} / ${r.days} DAYS`],
    ['PROTEIN GOAL', `${r.proteinDays} / ${r.days} DAYS`],
    ['TOTAL XP', String(r.xp)]
  ];
  let y = 580;
  rows.forEach(([label, value]) => {
    ctx.fillStyle = 'rgba(95,230,255,.08)';
    ctx.fillRect(96, y - 50, 888, 92);
    ctx.fillStyle = '#8ea9c9';
    ctx.font = '500 30px Rajdhani, sans-serif';
    ctx.fillText(label, 128, y);
    ctx.fillStyle = '#dff2ff';
    ctx.font = '700 38px Orbitron, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value, 952, y + 2);
    ctx.textAlign = 'left';
    y += 104;
  });

  let liftY = y + 40;
  if (r.lifts.length) {
    ctx.fillStyle = '#5fe6ff';
    ctx.font = '500 26px Rajdhani, sans-serif';
    ctx.fillText('TOP LIFTS · ESTIMATED 1RM', 96, liftY);
    liftY += 44;
    r.lifts.forEach((lift) => {
      ctx.fillStyle = '#dff2ff';
      ctx.font = '600 32px Rajdhani, sans-serif';
      ctx.fillText(String(lift.name).slice(0, 26), 96, liftY);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8ea9c9';
      ctx.font = '500 30px Rajdhani, sans-serif';
      const change = lift.change == null ? '' : ` · ${lift.change > 0 ? '+' : ''}${lift.change}%`;
      ctx.fillText(`${lift.now} KG${change}`, 984, liftY);
      ctx.textAlign = 'left';
      liftY += 42;
    });
  }

  ctx.fillStyle = '#5fe6ff';
  ctx.font = '500 26px Rajdhani, sans-serif';
  ctx.fillText('THE SYSTEM · PERSONAL TRAINING INTERFACE', 96, 1240);

  const finish = async (blob) => {
    const file = blob && typeof File === 'function' ? new File([blob], `system-recap-${todayKey()}.png`, { type: 'image/png' }) : null;
    const caption = `Level ${r.level}, ${r.streak}-day streak, ${r.sessions} sessions, ${r.prs} records.`;
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'THE SYSTEM — progress recap', text: caption });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-recap-${todayKey()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Recap card downloaded — post it anywhere.', 'gold');
  };

  if (canvas.toBlob) canvas.toBlob((blob) => { if (blob) finish(blob); }, 'image/png');
  else toast('This browser cannot export the card.', 'danger');
}

/* ---------------- paint ---------------- */

function renderCoachExtras() {
  const progress = document.getElementById('view-progress');
  if (!progress) return;
  progress.querySelectorAll('[data-coach-block]').forEach((el) => el.remove());
  const wrap = document.createElement('div');
  wrap.setAttribute('data-coach-block', '1');
  wrap.innerHTML = `
    <div class="section-head">
      <h2>RECAP CARD</h2>
      <div class="line"></div>
      <span class="hint">shareable image</span>
    </div>
    <div class="panel">
      <p class="panel-sub" style="margin:0;line-height:1.6">One card with the level, the streak, the last four weeks of sessions, records and the top lifts. Nothing is uploaded — the image is drawn on this device.</p>
      <div class="modal-actions" style="margin-top:12px;justify-content:flex-start">
        <button class="btn primary" data-act="share-recap">MAKE RECAP CARD</button>
      </div>
    </div>`;
  progress.appendChild(wrap);
}

/* ---------------- events ---------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const key = el.dataset.key;
  const index = el.dataset.i !== undefined ? Number(el.dataset.i) : null;

  if (act === 'save-readiness') saveReadiness();
  else if (act === 'swap-open') openSwap(key, index);
  else if (act === 'swap-pick') swapExercise(key, index, el.dataset.name);
  else if (act === 'swap-custom') swapExercise(key, index, $('[data-swap-custom]') ? $('[data-swap-custom]').value : '');
  else if (act === 'export-csv-sets') exportSetsCsv();
  else if (act === 'export-csv-weight') exportWeighInsCsv();
  else if (act === 'share-recap') shareRecap();
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-avoid]');
  if (!el) return;
  toggleAvoid(el.dataset.avoid, el.checked);
  const swap = document.querySelector('[data-act="swap-open"]');
  if (swap && el.closest('.modal-panel')) openSwap(swap.dataset.key, Number(swap.dataset.i));
});

renderAll = (() => {
  const base = renderAll;
  return function renderAllWithCoach() {
    base();
    try { renderCoachExtras(); } catch (err) { console.error('[coach] extras failed', err); }
  };
})();

if (typeof document !== 'undefined' && document.getElementById('view-today')) renderAll();
