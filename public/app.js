'use strict';

/* ======================================================================
   THE SYSTEM — personal fitness & hydration interface
   Single-page app. Data persists in localStorage.
   ====================================================================== */

const STORE_KEY = 'system-fitness-v1';
const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const XP_PER_LEVEL = 500;
const XP_WORKOUT = 100;
const XP_WATER = 40;
const RANKS = ['E', 'E', 'D', 'D', 'C', 'C', 'B', 'B', 'A', 'A', 'S'];

const uid = () => 'w' + Math.random().toString(36).slice(2, 8);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- defaults ---------------- */

const DEFAULT_TEMPLATES = [
  {
    id: 'push', name: 'PUSH DAY', focus: 'Chest · Shoulders · Triceps',
    exercises: [
      { name: 'Bench Press', sets: 4, reps: 8, weight: 60 },
      { name: 'Overhead Press', sets: 3, reps: 10, weight: 30 },
      { name: 'Incline Dumbbell Press', sets: 3, reps: 10, weight: 22 },
      { name: 'Lateral Raise', sets: 3, reps: 15, weight: 8 },
      { name: 'Triceps Pushdown', sets: 3, reps: 12, weight: 25 }
    ]
  },
  {
    id: 'pull', name: 'PULL DAY', focus: 'Back · Rear Delts · Biceps',
    exercises: [
      { name: 'Deadlift', sets: 4, reps: 5, weight: 90 },
      { name: 'Lat Pulldown', sets: 3, reps: 10, weight: 45 },
      { name: 'Barbell Row', sets: 3, reps: 8, weight: 50 },
      { name: 'Face Pull', sets: 3, reps: 15, weight: 15 },
      { name: 'Barbell Curl', sets: 3, reps: 12, weight: 20 }
    ]
  },
  {
    id: 'legs', name: 'LEG DAY', focus: 'Quads · Hamstrings · Calves',
    exercises: [
      { name: 'Back Squat', sets: 4, reps: 8, weight: 80 },
      { name: 'Romanian Deadlift', sets: 3, reps: 10, weight: 60 },
      { name: 'Leg Press', sets: 3, reps: 12, weight: 100 },
      { name: 'Leg Curl', sets: 3, reps: 12, weight: 35 },
      { name: 'Calf Raise', sets: 4, reps: 20, weight: 40 }
    ]
  }
];

function defaultState() {
  return {
    hunter: 'Adharsh M',
    xp: 0,
    goals: { water: 2500, weekly: 4 },
    profile: { heightCm: 0, weightKg: 0, goal: 'maintain' },
    weights: {},
    schedule: { 0: null, 1: 'push', 2: 'pull', 3: null, 4: 'legs', 5: 'push', 6: null },
    templates: JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)),
    logs: {},
    water: {},
    waterBonus: {},
    meals: {},
    pantry: DEFAULT_PANTRY.slice(),
    nutrition: { kcal: 2200, protein: 140 },
    ai: { diet: 'balanced', notes: '', results: [], at: 0, error: '', busy: false, remaining: null },
    reminders: { enabled: false, everyMin: 90, lastDrinkAt: 0, lastNotifiedAt: 0 },
    // startedAt is the day this record began: days before it are never counted
    // as missed workouts. tourDone remembers the first-run walkthrough.
    meta: { updatedAt: 0, startedAt: '', tourDone: false }
  };
}

/* ---------------- persistence ---------------- */

let memoryStore = null;

/* Normalises any stored or imported object against the current schema, so
   old saves and backups missing newer keys keep working. */
function normalizeState(parsed) {
  const base = defaultState();
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    ...base,
    ...src,
    goals: { ...base.goals, ...(src.goals || {}) },
    profile: { ...base.profile, ...(src.profile || {}) },
    weights: src.weights && typeof src.weights === 'object' ? src.weights : {},
    reminders: { ...base.reminders, ...(src.reminders || {}) },
    schedule: { ...base.schedule, ...(src.schedule || {}) },
    templates: Array.isArray(src.templates) && src.templates.length ? src.templates : base.templates,
    logs: src.logs || {},
    water: src.water || {},
    waterBonus: src.waterBonus || {},
    meals: src.meals || {},
    pantry: Array.isArray(src.pantry) ? src.pantry.filter((item) => typeof item === 'string') : DEFAULT_PANTRY.slice(),
    nutrition: { ...base.nutrition, ...(src.nutrition || {}) },
    ai: { ...base.ai, ...(src.ai || {}), busy: false, results: Array.isArray((src.ai || {}).results) ? src.ai.results : [] },
    meta: { ...base.meta, ...(src.meta || {}) }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    return memoryStore || defaultState();
  }
}

function save() {
  // Stamped before serialising so the timestamp handed to the backend matches
  // exactly what this browser has cached.
  state.meta = { ...(state.meta || {}), updatedAt: Date.now() };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    memoryStore = state;
  }
  if (typeof schedulePush === 'function') schedulePush();
}

let state = loadState();

/* ---------------- backup & restore ----------------
   History lives only in this browser's localStorage, which disappears when
   site data is cleared and never follows you to another device. Export/import
   is the escape hatch: a plain JSON file holding the whole state object. */

function storageSizeKb() {
  try {
    return (new Blob([JSON.stringify(state)]).size / 1024).toFixed(1);
  } catch (err) {
    return '0';
  }
}

function exportBackup() {
  const payload = { app: 'system-fitness', version: 1, exportedAt: new Date().toISOString(), state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `system-fitness-backup-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup downloaded. Keep the file somewhere safe.', 'gold');
}

function importBackupFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (err) {
      toast('That file is not valid JSON.', 'danger');
      return;
    }
    const candidate = parsed && parsed.app === 'system-fitness' && parsed.state ? parsed.state : parsed;
    if (!candidate || typeof candidate !== 'object' || (!candidate.logs && !candidate.water && !candidate.meals)) {
      toast('That file does not look like a System backup.', 'danger');
      return;
    }
    const sessions = Object.keys(candidate.logs || {}).length;
    if (!confirm(`Restore this backup? It replaces the data saved in this browser (${sessions} logged day${sessions === 1 ? '' : 's'}).`)) return;
    state = normalizeState(candidate);
    save();
    closeModal();
    renderAll();
    toast('Backup restored. Your record is back.', 'gold');
  };
  reader.onerror = () => toast('Could not read that file.', 'danger');
  reader.readAsText(file);
}

/* ---------------- dates ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const parseKey = (k) => {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};
const shortDate = (d) => `${DAY_LABELS[d.getDay()]} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

/* The day the hunt began. A brand-new record starts today, so nothing from
   before sign-up shows up as a missed quest. An existing record keeps its
   earliest logged day as the start. */
function startedKey() {
  const value = (state.meta && state.meta.startedAt) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function ensureStartDate() {
  state.meta = state.meta || {};
  const logged = Object.keys(state.logs || {})
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort();
  const earliest = logged.length ? logged[0] : '';
  const current = startedKey();
  if (current && (!earliest || current <= earliest)) return;
  state.meta.startedAt = earliest || current || todayKey();
  // Written straight to the cache on purpose: this is a local repair, and it
  // must not stamp meta.updatedAt or an empty record would win the first sync.
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    memoryStore = state;
  }
}

/* ---------------- derived model ---------------- */

function levelOf(xp) { return 1 + Math.floor(xp / XP_PER_LEVEL); }
function rankOf(level) { return RANKS[Math.min(level - 1, RANKS.length - 1)]; }

function planFor(key) {
  const date = parseKey(key);
  const log = state.logs[key] || null;
  const schedId = state.schedule[date.getDay()] || null;
  const templateId = log ? (log.templateId || null) : schedId;
  const template = state.templates.find((t) => t.id === templateId) || null;
  const exercises = log ? log.exercises : (template ? template.exercises.map((e) => ({ ...e, done: false })) : []);
  return { key, date, log, template, exercises, schedId };
}

function ensureLog(key) {
  if (!state.logs[key]) {
    const p = planFor(key);
    state.logs[key] = {
      status: 'pending',
      templateId: p.template ? p.template.id : null,
      exercises: p.template ? p.template.exercises.map((e) => ({ ...e, done: false })) : [],
      xpAwarded: false
    };
  }
  return state.logs[key];
}

function dayState(key) {
  const started = startedKey();
  // Before the record began, a scheduled day is not a failure.
  if (started && key < started) return 'pre';
  const p = planFor(key);
  const today = todayKey();
  if (p.log && p.log.status === 'completed') return 'done';
  if (p.log && p.log.status === 'skipped') return 'skip';
  if (p.template) {
    if (key === today) return 'pending';
    return key < today ? 'miss' : 'upcoming';
  }
  return 'rest';
}

function computeStreak() {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 400; i++) {
    const date = addDays(today, -i);
    const key = keyOf(date);
    const log = state.logs[key];
    if (log && log.status === 'completed') { streak++; continue; }
    if (i === 0) continue; // today never breaks the streak
    const scheduled = state.schedule[date.getDay()];
    if (!scheduled) continue; // rest day, neutral
    return streak;
  }
  return streak;
}

function weekStart() {
  const d = new Date();
  return addDays(d, -d.getDay());
}

function completedThisWeek() {
  const start = weekStart();
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const key = keyOf(addDays(start, i));
    if (state.logs[key] && state.logs[key].status === 'completed') count++;
  }
  return count;
}

function completedTotal() {
  return Object.values(state.logs).filter((l) => l.status === 'completed').length;
}

function grantXp(amount) {
  const before = levelOf(state.xp);
  state.xp += amount;
  const after = levelOf(state.xp);
  if (after > before) {
    setTimeout(() => toast(`Level ${after} reached — rank ${rankOf(after)}. The System acknowledges your growth.`, 'gold'), 450);
  }
}

/* ---------------- body profile & BMI ---------------- */

const PROFILE_GOALS = [
  ['lose', 'LOSE FAT'],
  ['maintain', 'MAINTAIN'],
  ['gain', 'BUILD MUSCLE']
];

function profileOf() {
  const p = state.profile || {};
  return {
    heightCm: Number(p.heightCm) || 0,
    weightKg: Number(p.weightKg) || 0,
    goal: PROFILE_GOALS.some(([value]) => value === p.goal) ? p.goal : 'maintain'
  };
}

function bmiOf(p) {
  const height = (Number(p && p.heightCm) || 0) / 100;
  const weight = Number(p && p.weightKg) || 0;
  if (!(height > 0) || !(weight > 0)) return 0;
  const bmi = weight / (height * height);
  return Number.isFinite(bmi) ? bmi : 0;
}

function bmiBand(bmi) {
  if (!(bmi > 0)) return { label: 'NO DATA', tone: 'muted' };
  if (bmi < 18.5) return { label: 'UNDERWEIGHT', tone: 'low' };
  if (bmi < 25) return { label: 'NORMAL', tone: 'good' };
  if (bmi < 30) return { label: 'OVERWEIGHT', tone: 'high' };
  return { label: 'OBESE', tone: 'high' };
}

function profileComplete() {
  const p = profileOf();
  return p.heightCm >= 120 && p.weightKg >= 30;
}

/* Daily targets follow body weight, adjusted by the goal. Manual entries in
   Settings still win because saveSettings() reads them afterwards. */
function applyProfileTargets() {
  const p = profileOf();
  if (!(p.weightKg > 0)) return;
  const kcalPerKg = p.goal === 'lose' ? 26 : p.goal === 'gain' ? 34 : 30;
  const proteinPerKg = p.goal === 'gain' ? 2 : p.goal === 'lose' ? 1.8 : 1.6;
  state.nutrition.kcal = Math.round((p.weightKg * kcalPerKg) / 50) * 50;
  state.nutrition.protein = Math.round((p.weightKg * proteinPerKg) / 5) * 5;
  state.goals.water = Math.round(Math.min(5000, Math.max(1500, p.weightKg * 35)) / 50) * 50;
}

function readProfileInputs() {
  const height = Number($('[data-profile="height"]')?.value);
  const weight = Number($('[data-profile="weight"]')?.value);
  const goal = $('[data-profile="goal"]')?.value;
  const validHeight = Number.isFinite(height) && height >= 120 && height <= 230;
  const validWeight = Number.isFinite(weight) && weight >= 30 && weight <= 250;
  if (!validHeight && !validWeight) return null;
  const next = profileOf();
  return {
    heightCm: validHeight ? Math.round(height * 10) / 10 : next.heightCm,
    weightKg: validWeight ? Math.round(weight * 10) / 10 : next.weightKg,
    goal: PROFILE_GOALS.some(([value]) => value === goal) ? goal : next.goal
  };
}

/* ---------------- weight log & trend ---------------- */

function weightEntries() {
  const raw = state.weights || {};
  return Object.keys(raw)
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .filter((key) => {
      const kg = Number(raw[key]);
      return Number.isFinite(kg) && kg >= 30 && kg <= 250;
    })
    .sort()
    .map((key) => ({ key, kg: Math.round(Number(raw[key]) * 10) / 10 }));
}

function recordWeight(kg) {
  const value = Math.round(Number(kg) * 10) / 10;
  if (!(value >= 30 && value <= 250)) return;
  state.weights = state.weights || {};
  state.weights[todayKey()] = value;
}

function weightDelta(entries) {
  if (entries.length < 2) return null;
  const first = entries[0];
  const last = entries[entries.length - 1];
  const days = Math.max(1, Math.round((parseKey(last.key) - parseKey(first.key)) / 86400000));
  return { first, last, days, kg: Math.round((last.kg - first.kg) * 10) / 10 };
}

function bmiAt(kg) {
  const height = profileOf().heightCm / 100;
  if (!(height > 0) || !(kg > 0)) return 0;
  const bmi = kg / (height * height);
  return Number.isFinite(bmi) ? bmi : 0;
}

function weightSpark(entries) {
  const points = entries.slice(-16);
  if (points.length < 2) {
    return '<div class="empty" style="margin:0">Log your weight on two different days to plot the trend.</div>';
  }
  const w = 320;
  const h = 96;
  const pad = 8;
  const values = points.map((p) => p.kg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(0.6, max - min);
  const x = (i) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
  const dots = points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="2.6" />`)
    .join('');
  return `
      <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Weight trend, ${points[0].kg} kg to ${points[points.length - 1].kg} kg">
        <defs>
          <linearGradient id="weightGrad" x1="0" y1="0" x2="0" y2="1">
            <stop stop-color="#5fe6ff" stop-opacity=".4" /><stop offset="1" stop-color="#5fe6ff" stop-opacity="0" />
          </linearGradient>
        </defs>
        <polygon points="${area}" fill="url(#weightGrad)" />
        <polyline points="${line}" fill="none" stroke="#5fe6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        ${dots}
      </svg>
      <div class="spark-axis"><span>${points[0].key}</span><span>${points[points.length - 1].kg} kg · ${points[points.length - 1].key}</span></div>`;
}

function logWeight() {
  const raw = Number($('[data-weight-input]')?.value);
  if (!(raw >= 30 && raw <= 250)) {
    toast('Enter a weight between 30 and 250 kg.', 'danger');
    return;
  }
  const kg = Math.round(raw * 10) / 10;
  recordWeight(kg);
  state.profile = { ...profileOf(), weightKg: kg };
  applyProfileTargets();
  save();
  renderAll();
  const bmi = bmiOf(state.profile);
  toast(`Weight logged: ${kg} kg · BMI ${bmi.toFixed(1)} ${bmiBand(bmi).label}.`, 'gold');
}

function bmiLine(p) {
  const bmi = bmiOf(p);
  if (!bmi) return 'Enter your height and weight to see your BMI.';
  const band = bmiBand(bmi);
  return `BMI <b>${bmi.toFixed(1)}</b> · ${band.label}. Saving also sets daily calories, protein and water for this body.`;
}

function profileFieldsHtml() {
  const p = profileOf();
  const options = PROFILE_GOALS.map(
    ([value, label]) => `<option value="${value}"${p.goal === value ? ' selected' : ''}>${label}</option>`
  ).join('');
  return `
      <div class="form-grid two">
        <label class="field"><span class="lbl">HEIGHT (CM)</span>
          <input type="number" min="120" max="230" step="0.5" inputmode="decimal" data-profile="height" value="${p.heightCm || ''}" />
        </label>
        <label class="field"><span class="lbl">WEIGHT (KG)</span>
          <input type="number" min="30" max="250" step="0.1" inputmode="decimal" data-profile="weight" value="${p.weightKg || ''}" />
        </label>
      </div>
      <label class="field"><span class="lbl">GOAL</span>
        <select data-profile="goal">${options}</select>
      </label>
      <p class="panel-sub" id="bmiPreview" style="margin:2px 0 0;font-size:12.5px">${bmiLine(p)}</p>`;
}

function openProfileSetup() {
  openModal(`
    <h2>HUNTER PROFILE</h2>
    <div class="sub">Height, weight and goal calibrate your BMI and your daily targets.</div>
    <div class="form-grid">
      ${profileFieldsHtml()}
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-act="save-profile">SAVE PROFILE</button>
      <button class="btn ghost" data-act="profile-later">LATER</button>
    </div>
  `);
}

let profilePrompted = false;

/* Asked once per page load, and only once the sign-in gate is out of the way. */
function maybeOpenProfileSetup() {
  if (profilePrompted) return;
  const gate = $('#authScreen');
  if (gate && !gate.hidden) return;
  const root = $('#modalRoot');
  if (root && !root.hidden) return;
  profilePrompted = true;
  if (profileComplete()) return;
  openProfileSetup();
}

function saveProfile() {
  const rawHeight = Number($('[data-profile="height"]')?.value);
  const rawWeight = Number($('[data-profile="weight"]')?.value);
  if (!(rawHeight >= 120 && rawHeight <= 230) || !(rawWeight >= 30 && rawWeight <= 250)) {
    toast('Enter a height of 120–230 cm and a weight of 30–250 kg.', 'danger');
    return;
  }
  const profile = readProfileInputs();
  if (!profile) return;
  state.profile = profile;
  recordWeight(profile.weightKg);
  applyProfileTargets();
  save();
  closeModal();
  renderAll();
  toast(`BMI ${bmiOf(profile).toFixed(1)} · ${bmiBand(bmiOf(profile)).label}. Targets updated.`, 'gold');
  maybeStartTour();
}

/* ---------------- notifications & toasts ---------------- */

function toast(message, kind = '') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  const tag = kind === 'gold' ? 'LEVEL UP' : kind === 'danger' ? 'WARNING' : 'SYSTEM';
  el.className = 'toast ' + kind;
  el.innerHTML = `<span class="ti">${tag}</span><span>${esc(message)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3600);
}

function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

async function requestNotifyPermission() {
  if (!notifySupported()) {
    toast('This browser does not support system notifications. In-app alerts will still appear.', 'danger');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    toast('Alerts enabled. The System will remind you to drink water.', 'gold');
    return true;
  }
  toast('Alerts blocked. You can re-enable them in your browser site settings.', 'danger');
  return false;
}

function pushNotification(title, body) {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'system-water', renotify: true });
  } catch (err) { /* ignore */ }
}

function checkWaterReminder() {
  const r = state.reminders;
  if (!r.enabled) return;
  // With device push on, the server owns reminders; skip the in-tab duplicate.
  if (typeof PUSH_STATE !== 'undefined' && PUSH_STATE.subscribed) return;
  const now = new Date();
  const hour = now.getHours();
  if (hour < 8 || hour >= 22) return;
  const everyMs = Math.max(15, r.everyMin) * 60000;
  const last = Math.max(r.lastDrinkAt || 0, r.lastNotifiedAt || 0);
  if (Date.now() - last < everyMs) return;
  r.lastNotifiedAt = Date.now();
  save();
  const goal = state.goals.water;
  const drank = state.water[todayKey()] || 0;
  pushNotification('HYDRATION QUEST', `No water logged for ${r.everyMin} min. ${Math.max(0, goal - drank)} ml left today.`);
  toast(`Hydration quest: drink 250 ml (${Math.round((drank / goal) * 100)}% of goal done).`);
}

/* ---------------- modal ---------------- */

function openModal(inner) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-act="modal-close"></div>
    <div class="modal-panel" role="dialog" aria-modal="true">
      <button class="icon-btn modal-close" data-act="modal-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      ${inner}
    </div>`;
  root.hidden = false;
  document.body.style.overflow = 'hidden';
  const focusable = root.querySelector('input, select, button:not(.modal-close)');
  if (focusable) setTimeout(() => focusable.focus(), 60);
}

function closeModal() {
  $('#modalRoot').hidden = true;
  $('#modalRoot').innerHTML = '';
  document.body.style.overflow = '';
  draft = null;
}

/* ---------------- rendering: shell ---------------- */

function renderTopbar() {
  const level = levelOf(state.xp);
  const into = state.xp % XP_PER_LEVEL;
  $('#hunterName').textContent = state.hunter || 'HUNTER';
  $('#levelNum').textContent = level;
  $('#rankBadge').textContent = rankOf(level);
  $('#xpText').textContent = `${into} / ${XP_PER_LEVEL} XP`;
  $('#xpFill').style.width = `${(into / XP_PER_LEVEL) * 100}%`;
}

function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  renderAll();
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) { /* older browser */ }
}

/* A short tick on devices that can do it: the app should answer a tap. */
function tapFeedback(ms = 8) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch (err) { /* desktop and iOS simply ignore it */ }
}

/* ---------------- rendering: today ---------------- */

function renderToday() {
  const key = todayKey();
  const p = planFor(key);
  const st = dayState(key);
  const goal = state.goals.water;
  const drank = state.water[key] || 0;
  const pct = Math.min(1, goal ? drank / goal : 0);
  const C = 2 * Math.PI * 66;
  const statusClass = st === 'done' ? 'is-done' : st === 'skip' ? 'is-skip' : '';
  const tagClass = st === 'done' ? 'done' : st === 'skip' ? 'skip' : (p.template ? '' : 'rest');
  const tagText = st === 'done' ? 'QUEST CLEARED' : st === 'skip' ? 'SKIPPED' : (p.template ? 'ACTIVE QUEST' : 'REST DAY');
  const doneCount = p.exercises.filter((e) => e.done).length;

  const exRows = p.exercises.map((ex, i) => `
    <li class="ex ${ex.done ? 'is-done' : ''}">
      <button class="check" data-act="toggle-ex" data-key="${key}" data-i="${i}" aria-label="Toggle ${esc(ex.name)}">✓</button>
      <div class="ex-body">
        <span class="ex-name">${esc(ex.name)}</span>
        <span class="ex-meta">${ex.sets} × ${ex.reps}${ex.weight ? ` · ${ex.weight} kg` : ''}</span>
      </div>
      <div class="ex-actions">
        <button class="icon-btn sm" data-act="edit-ex" data-key="${key}" data-i="${i}" aria-label="Edit exercise">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 6l4 4" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="icon-btn sm" data-act="del-ex" data-key="${key}" data-i="${i}" aria-label="Remove exercise">
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M10 7V5h4v2M8 7l1 13h6l1-13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </li>`).join('');

  const list = p.exercises.length
    ? `<ul class="ex-list">${exRows}</ul>`
    : `<div class="empty" style="margin-top:16px">No training scheduled today. Pick a workout above to begin, or keep it a rest day.</div>`;

  const options = [`<option value=""${!p.template ? ' selected' : ''}>Rest day</option>`]
    .concat(state.templates.map((t) => `<option value="${t.id}"${p.template && p.template.id === t.id ? ' selected' : ''}>${esc(t.name)}</option>`))
    .join('');

  const actions = [];
  if (st === 'done') {
    actions.push(`<button class="btn ghost" data-act="reopen-day" data-key="${key}">UNDO CLEAR</button>`);
    actions.push(`<button class="btn" data-act="skip-day" data-key="${key}">MARK SKIPPED</button>`);
  } else {
    actions.push(`<button class="btn primary" data-act="complete-day" data-key="${key}">${st === 'skip' ? 'CLEAR QUEST' : 'COMPLETE QUEST'}</button>`);
    if (st !== 'skip') actions.push(`<button class="btn ghost" data-act="skip-day" data-key="${key}">SKIP TODAY</button>`);
  }
  actions.push(`<button class="btn" data-act="add-ex" data-key="${key}">+ EXERCISE</button>`);

  const streak = computeStreak();
  const week = completedThisWeek();

  $('#view-today').innerHTML = `
    <div class="section-head">
      <h2>DAILY QUEST</h2>
      <div class="line"></div>
      <span class="hint">${shortDate(new Date())}</span>
    </div>

    <div class="quest ${statusClass}">
      <div class="quest-top">
        <div>
          <h2 class="quest-title">${p.template ? esc(p.template.name) : 'REST &amp; RECOVER'}</h2>
          <div class="quest-sub">${p.template ? `${esc(p.template.focus || 'Training')} · ${p.exercises.length} exercises · ${doneCount}/${p.exercises.length} done` : 'No training scheduled. Recovery is part of the climb.'}</div>
        </div>
        <span class="quest-tag ${tagClass}">${tagText}</span>
      </div>

      <div class="field" style="margin-top:14px;max-width:320px">
        <span class="lbl">TODAY'S WORKOUT</span>
        <select data-change="today-template">${options}</select>
      </div>

      ${list}

      <div class="quest-actions">${actions.join('')}</div>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="k">STREAK</div><div class="v">${streak} <small>DAY${streak === 1 ? '' : 'S'}</small></div></div>
      <div class="stat"><div class="k">THIS WEEK</div><div class="v">${week} <small>/ ${state.goals.weekly}</small></div></div>
      <div class="stat"><div class="k">WATER TODAY</div><div class="v">${(drank / 1000).toFixed(2)} <small>L</small></div></div>
      <div class="stat"><div class="k">BMI</div><div class="v">${bmiOf(profileOf()) ? bmiOf(profileOf()).toFixed(1) : '—'} <small>${bmiBand(bmiOf(profileOf())).label}</small></div></div>
      <div class="stat"><div class="k">QUESTS CLEARED</div><div class="v">${completedTotal()}</div></div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-head">
        <div class="panel-title">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0C6 9.4 12 3 12 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          HYDRATION
        </div>
        <div class="spacer"></div>
        <span class="panel-sub">${Math.round(pct * 100)}% of ${(goal / 1000).toFixed(1)} L</span>
      </div>

      <div class="water-wrap">
        <div class="ring">
          <svg viewBox="0 0 152 152">
            <defs>
              <linearGradient id="waterGrad" x1="0" y1="0" x2="1" y2="1">
                <stop stop-color="#5fe6ff" /><stop offset="1" stop-color="#3a86ff" />
              </linearGradient>
            </defs>
            <circle class="track" cx="76" cy="76" r="66" />
            <circle class="fill" cx="76" cy="76" r="66" stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}" />
          </svg>
          <div class="ring-label">
            <div class="big">${(drank / 1000).toFixed(2)}L</div>
            <div class="small">${Math.max(0, goal - drank) > 0 ? `${Math.max(0, goal - drank)} ML LEFT` : 'GOAL MET'}</div>
          </div>
        </div>

        <div class="water-side">
          <div class="water-meta">
            <span class="goal">INTAKE LOG</span>
            <span class="panel-sub">${drank} / ${goal} ml</span>
          </div>
          <div class="water-btns">
            <button class="btn" data-act="water-add" data-ml="250">+250 ML</button>
            <button class="btn" data-act="water-add" data-ml="500">+500 ML</button>
            <button class="btn" data-act="water-add" data-ml="750">+750 ML</button>
          </div>
          <div class="water-note" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <label class="switch">
              <input type="checkbox" data-change="reminders-toggle" ${state.reminders.enabled ? 'checked' : ''} />
              <span class="track2"></span>
              <span class="sw-label">Remind every ${state.reminders.everyMin} min</span>
            </label>
            <button class="btn ghost" style="padding:6px 10px;font-size:9px" data-act="water-reset">RESET</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- rendering: workouts ---------------- */

function renderWorkouts() {
  const cards = state.templates.map((t) => `
    <article class="wcard">
      <div class="wcard-head">
        <div>
          <h3>${esc(t.name)}</h3>
          <div class="focus">${esc(t.focus || 'Custom training')}</div>
        </div>
        <span class="count">${t.exercises.length} MOVES</span>
      </div>
      <ul>
        ${t.exercises.map((e) => `<li><span>${esc(e.name)}</span><span>${e.sets}×${e.reps}${e.weight ? ` · ${e.weight}kg` : ''}</span></li>`).join('') || '<li><span>No exercises yet</span><span>—</span></li>'}
      </ul>
      <div class="wcard-foot">
        <button class="btn" data-act="edit-template" data-id="${t.id}">EDIT</button>
        <button class="btn ghost" data-act="delete-template" data-id="${t.id}">DELETE</button>
      </div>
    </article>`).join('');

  const todayDow = new Date().getDay();
  const schRows = DAY_LABELS.map((label, dow) => {
    const current = state.schedule[dow] || '';
    const opts = [`<option value=""${!current ? ' selected' : ''}>Rest day</option>`]
      .concat(state.templates.map((t) => `<option value="${t.id}"${current === t.id ? ' selected' : ''}>${esc(t.name)}</option>`))
      .join('');
    return `
      <div class="sch-row ${dow === todayDow ? 'is-today' : ''}">
        <span class="sch-day">${label}</span>
        <select data-change="schedule" data-dow="${dow}">${opts}</select>
      </div>`;
  }).join('');

  $('#view-workouts').innerHTML = `
    <div class="section-head">
      <h2>WORKOUT LIBRARY</h2>
      <div class="line"></div>
      <button class="btn" data-act="new-template">+ NEW WORKOUT</button>
    </div>
    <div class="card-grid">${cards}</div>

    <div class="section-head">
      <h2>WEEKLY SCHEDULE</h2>
      <div class="line"></div>
      <span class="hint">Assign a workout to each day</span>
    </div>
    <div class="panel">
      <div class="schedule">${schRows}</div>
    </div>

    <div class="section-head">
      <h2>HOW IT WORKS</h2>
      <div class="line"></div>
    </div>
    <div class="panel">
      <p class="panel-sub" style="margin:0;line-height:1.6">
        Edit a workout in the library and every future scheduled day follows the new structure.
        On the Today screen you can also swap the day's workout, add an extra exercise, or mark the day
        as skipped — the System records all of it, so a changed plan or a missed day never breaks your history.
      </p>
    </div>
  `;
}

/* ---------------- rendering: progress ---------------- */

function renderProgress() {
  const today = new Date();
  const start = addDays(today, -(today.getDay() + 7 * 11));
  const cells = [];
  for (let i = 0; i < 84; i++) {
    const d = addDays(start, i);
    const key = keyOf(d);
    const st = dayState(key);
    const cls = st === 'done' ? 'done' : st === 'skip' ? 'skip' : st === 'miss' ? 'miss' : st === 'rest' ? 'rest' : st === 'pre' ? 'pre' : st === 'pending' ? 'pending' : 'upcoming';
    const label = st === 'pre' ? 'before your hunt began' : st;
    cells.push(`<button class="hm-cell ${cls} ${key === todayKey() ? 'today' : ''}" data-act="day-open" data-key="${key}" title="${key} · ${label}" aria-label="${key} ${label}"></button>`);
  }

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    days.push({ key: keyOf(d), date: d, ml: state.water[keyOf(d)] || 0 });
  }
  const goal = state.goals.water || 2500;
  const maxVal = Math.max(goal, ...days.map((d) => d.ml));

  const bars = days.map((d) => {
    const h = Math.max(2, (d.ml / maxVal) * 100);
    const cls = d.ml >= goal ? 'is-goal' : d.ml < goal * 0.4 ? 'is-low' : '';
    return `
      <div class="bar-col ${cls}">
        <span class="bar-val">${(d.ml / 1000).toFixed(1)}L</span>
        <div class="bar-track">
          <div class="bar-fill" style="height:${h}%"></div>
          <div class="bar-goal-line" style="bottom:${(goal / maxVal) * 100}%"></div>
        </div>
        <span class="bar-label">${DAY_LABELS[d.date.getDay()]}</span>
      </div>`;
  }).join('');

  const weightLog = weightEntries();
  const weightTrend = weightDelta(weightLog);
  const currentWeight = weightLog.length ? weightLog[weightLog.length - 1].kg : profileOf().weightKg;
  const bmiNow = bmiOf(profileOf());
  const bmiStart = weightTrend ? bmiAt(weightTrend.first.kg) : 0;
  const bmiShift = weightTrend && bmiStart ? Math.round((bmiNow - bmiStart) * 10) / 10 : null;

  $('#view-progress').innerHTML = `
    <div class="section-head">
      <h2>HUNTER RECORD</h2>
      <div class="line"></div>
      <span class="hint">Level ${levelOf(state.xp)} · Rank ${rankOf(levelOf(state.xp))}</span>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="k">CURRENT STREAK</div><div class="v">${computeStreak()} <small>D</small></div></div>
      <div class="stat"><div class="k">BEST STREAK</div><div class="v">${bestStreak()} <small>D</small></div></div>
      <div class="stat gold"><div class="k">TOTAL XP</div><div class="v">${state.xp}</div></div>
      <div class="stat"><div class="k">QUESTS CLEARED</div><div class="v">${completedTotal()}</div></div>
    </div>

    <div class="section-head">
      <h2>BODY · WEIGHT &amp; BMI</h2>
      <div class="line"></div>
      <span class="hint">${weightLog.length} weigh-in${weightLog.length === 1 ? '' : 's'}</span>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 19h16M6 19V9m6 10V5m6 14v-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          WEIGHT TREND
        </div>
        <div class="spacer"></div>
        <span class="panel-sub">${currentWeight ? `${currentWeight} kg` : 'not logged yet'}</span>
      </div>
      ${weightSpark(weightLog)}
      <div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin-top:14px">
        <div class="stat"><div class="k">BMI NOW</div><div class="v">${bmiNow ? bmiNow.toFixed(1) : '—'} <small>${bmiBand(bmiNow).label}</small></div></div>
        <div class="stat"><div class="k">CHANGE</div><div class="v">${weightTrend ? `${weightTrend.kg > 0 ? '+' : ''}${weightTrend.kg} <small>KG</small>` : '—'}</div></div>
      </div>
      <p class="panel-sub" style="margin:10px 0 0;line-height:1.6">
        ${weightTrend && bmiStart
          ? `BMI ${bmiStart.toFixed(1)} → ${bmiNow.toFixed(1)} (${bmiShift > 0 ? '+' : ''}${bmiShift}) over ${weightTrend.days} day${weightTrend.days === 1 ? '' : 's'}.`
          : 'Log your weight now and then; the trend and BMI change build up as you go.'}
      </p>
      <div class="weight-log">
        <label class="field"><span class="lbl">WEIGHT (KG)</span>
          <input type="number" min="30" max="250" step="0.1" inputmode="decimal" data-weight-input value="${currentWeight || ''}" />
        </label>
        <button class="btn primary" data-act="log-weight">LOG WEIGHT</button>
      </div>
    </div>

    <div class="section-head">
      <h2>QUEST MAP</h2>
      <div class="line"></div>
      <span class="hint">${startedKey() ? `Since ${startedKey()}` : 'Tap a day to log or edit it'}</span>
    </div>
    <div class="panel">
      <div class="heatmap">${cells.join('')}</div>
      <div class="legend">
        <span><i style="background:linear-gradient(140deg,#4fe0ff,#2e7dff);border-color:#5fe6ff"></i>Cleared</span>
        <span><i style="background:rgba(255,84,112,.32);border-color:rgba(255,84,112,.5)"></i>Skipped</span>
        <span><i style="background:rgba(255,84,112,.1);border-color:rgba(255,84,112,.22)"></i>Missed</span>
        <span><i style="background:rgba(139,92,246,.1);border-color:rgba(139,92,246,.2)"></i>Rest</span>
        <span><i style="background:transparent;border-style:dashed;border-color:rgba(122,146,184,.3)"></i>Before start</span>
        <span><i style="border-color:#5fe6ff;background:rgba(95,230,255,.12)"></i>Today</span>
      </div>
    </div>

    <div class="section-head">
      <h2>HYDRATION · LAST 7 DAYS</h2>
      <div class="line"></div>
    </div>
    <div class="panel">
      <div class="bars">${bars}</div>
    </div>
  `;
}

function bestStreak() {
  const completed = Object.keys(state.logs).filter((k) => state.logs[k].status === 'completed');
  let best = 0;
  completed.forEach((endKey) => {
    let run = 0;
    const end = parseKey(endKey);
    for (let i = 0; i < 400; i++) {
      const day = addDays(end, -i);
      const log = state.logs[keyOf(day)];
      if (log && log.status === 'completed') { run++; continue; }
      if (!state.schedule[day.getDay()]) continue; // rest day keeps a streak alive
      break;
    }
    best = Math.max(best, run);
  });
  return best;
}

function renderAll() {
  renderTopbar();
  renderToday();
  renderWorkouts();
  renderProgress();
  if (typeof renderHistory === 'function') renderHistory();
  if (typeof renderNutrition === 'function') renderNutrition();
  if (typeof coachIntoToday === 'function') coachIntoToday();
}

/* ---------------- workout template editor ---------------- */

let draft = null;

function blankExercise() { return { name: '', sets: 3, reps: 10, weight: 0 }; }

function openTemplateEditor(id) {
  if (id) {
    const tpl = state.templates.find((t) => t.id === id);
    if (!tpl) return;
    draft = { id: tpl.id, name: tpl.name, focus: tpl.focus || '', exercises: tpl.exercises.map((e) => ({ ...e })), isNew: false };
  } else {
    draft = { id: uid(), name: 'NEW WORKOUT', focus: '', exercises: [blankExercise()], isNew: true };
  }
  renderTemplateEditor();
}

function renderTemplateEditor() {
  const rows = draft.exercises.map((e, i) => `
    <div class="ex-edit-row">
      <label class="field ex-name-in"><span class="lbl">EXERCISE</span>
        <input type="text" data-tpl-name="${i}" value="${esc(e.name)}" placeholder="Exercise name" />
      </label>
      <label class="field"><span class="lbl">SETS</span>
        <input type="number" min="1" max="20" data-tpl-sets="${i}" value="${e.sets}" />
      </label>
      <label class="field"><span class="lbl">REPS</span>
        <input type="number" min="1" max="100" data-tpl-reps="${i}" value="${e.reps}" />
      </label>
      <label class="field"><span class="lbl">KG</span>
        <input type="number" min="0" max="500" step="0.5" data-tpl-weight="${i}" value="${e.weight || 0}" />
      </label>
      <button class="icon-btn rm" data-act="tpl-rm-row" data-i="${i}" aria-label="Remove row">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M10 7V5h4v2M8 7l1 13h6l1-13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`).join('');

  openModal(`
    <h2>${draft.isNew ? 'FORGE WORKOUT' : 'EDIT WORKOUT'}</h2>
    <div class="sub">Shape the structure. Future scheduled days follow this plan.</div>
    <div class="form-grid">
      <label class="field"><span class="lbl">WORKOUT NAME</span>
        <input type="text" data-tpl-field="name" value="${esc(draft.name)}" placeholder="e.g. PUSH DAY" />
      </label>
      <label class="field"><span class="lbl">TARGET MUSCLES</span>
        <input type="text" data-tpl-field="focus" value="${esc(draft.focus)}" placeholder="e.g. Chest · Shoulders" />
      </label>
    </div>
    <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">EXERCISES</h2><div class="line"></div></div>
    <div>${rows || '<div class="empty">No exercises yet — add the first one.</div>'}</div>
    <button class="btn block" data-act="tpl-add-row">+ ADD EXERCISE</button>
    <div class="modal-actions">
      <button class="btn primary" data-act="tpl-save">SAVE WORKOUT</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

function collectTemplateDraft() {
  if (!draft) return;
  const nameEl = $('[data-tpl-field="name"]');
  const focusEl = $('[data-tpl-field="focus"]');
  if (nameEl) draft.name = nameEl.value.trim() || 'UNTITLED WORKOUT';
  if (focusEl) draft.focus = focusEl.value.trim();
  draft.exercises = $$('[data-tpl-name]').map((_, i) => ({
    name: ($(`[data-tpl-name="${i}"]`)?.value || '').trim(),
    sets: clampNum($(`[data-tpl-sets="${i}"]`)?.value, 1, 20, 3),
    reps: clampNum($(`[data-tpl-reps="${i}"]`)?.value, 1, 100, 10),
    weight: clampNum($(`[data-tpl-weight="${i}"]`)?.value, 0, 500, 0)
  }));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------------- exercise editor (single) ---------------- */

function openExerciseEditor(key, index) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return;
  openModal(`
    <h2>EDIT EXERCISE</h2>
    <div class="sub">Adjust today's target. The saved workout stays unchanged.</div>
    <div class="form-grid two">
      <label class="field" style="grid-column:1/-1"><span class="lbl">NAME</span>
        <input type="text" data-ex-field="name" value="${esc(ex.name)}" />
      </label>
      <label class="field"><span class="lbl">SETS</span><input type="number" min="1" max="20" data-ex-field="sets" value="${ex.sets}" /></label>
      <label class="field"><span class="lbl">REPS</span><input type="number" min="1" max="100" data-ex-field="reps" value="${ex.reps}" /></label>
      <label class="field"><span class="lbl">WEIGHT (KG)</span><input type="number" min="0" max="500" step="0.5" data-ex-field="weight" value="${ex.weight || 0}" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-act="save-ex" data-key="${key}" data-i="${index}">SAVE</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

function openNewExercise(key) {
  openModal(`
    <h2>ADD EXERCISE</h2>
    <div class="sub">Extra work for today only — cable work, cardio, anything.</div>
    <div class="form-grid two">
      <label class="field" style="grid-column:1/-1"><span class="lbl">NAME</span>
        <input type="text" data-ex-field="name" placeholder="e.g. Incline Treadmill" />
      </label>
      <label class="field"><span class="lbl">SETS / MINUTES</span><input type="number" min="1" max="999" data-ex-field="sets" value="3" /></label>
      <label class="field"><span class="lbl">REPS / LEVEL</span><input type="number" min="1" max="999" data-ex-field="reps" value="10" /></label>
      <label class="field"><span class="lbl">WEIGHT (KG)</span><input type="number" min="0" max="500" step="0.5" data-ex-field="weight" value="0" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-act="save-new-ex" data-key="${key}">ADD</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

/* ---------------- day detail modal ---------------- */

function openDayModal(key) {
  const p = planFor(key);
  const st = dayState(key);
  const d = parseKey(key);
  const rows = p.exercises.map((e) => `<li class="ex ${e.done ? 'is-done' : ''}" style="pointer-events:none"><div class="ex-body"><span class="ex-name">${esc(e.name)}</span><span class="ex-meta">${e.sets} × ${e.reps}${e.weight ? ` · ${e.weight} kg` : ''}</span></div></li>`).join('');
  const tag = st === 'done' ? 'CLEARED' : st === 'skip' ? 'SKIPPED' : st === 'rest' ? 'REST DAY' : st === 'miss' ? 'MISSED' : 'PENDING';

  openModal(`
    <h2>${shortDate(d)}</h2>
    <div class="sub">${p.template ? esc(p.template.name) : 'No workout scheduled'} · ${tag}</div>
    ${rows ? `<ul class="ex-list">${rows}</ul>` : '<div class="empty">No exercises planned.</div>'}
    <div class="modal-actions" style="margin-top:18px">
      <button class="btn primary" data-act="day-status" data-key="${key}" data-status="completed">CLEARED</button>
      <button class="btn danger" data-act="day-status" data-key="${key}" data-status="skipped">SKIPPED</button>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="day-clear" data-key="${key}">CLEAR RECORD</button>
      <button class="btn ghost" data-act="modal-close">CLOSE</button>
    </div>
  `);
}

/* ---------------- actions ---------------- */

function addWater(ml) {
  const key = todayKey();
  const goal = state.goals.water;
  const before = state.water[key] || 0;
  state.water[key] = Math.max(0, before + ml);
  state.reminders.lastDrinkAt = Date.now();
  state.reminders.lastNotifiedAt = Date.now();
  if (!state.waterBonus[key] && state.water[key] >= goal) {
    state.waterBonus[key] = true;
    grantXp(XP_WATER);
    toast('Hydration quest complete. Goal reached — well done, Hunter.', 'gold');
  }
  save();
  renderAll();
}

function completeDay(key) {
  const log = ensureLog(key);
  if (log.exercises.length === 0 && !log.templateId) {
    toast('Nothing scheduled for this day. Add or pick a workout first.', 'danger');
    return;
  }
  log.status = 'completed';
  log.exercises.forEach((e) => { e.done = true; });
  if (!log.xpAwarded) {
    log.xpAwarded = true;
    grantXp(XP_WORKOUT);
  }
  save();
  renderAll();
  toast(key === todayKey() ? 'Quest cleared. +100 XP' : `Quest cleared for ${shortDate(parseKey(key))}. +100 XP`, 'gold');
}

function skipDay(key) {
  const log = ensureLog(key);
  log.status = 'skipped';
  save();
  renderAll();
  toast('Day marked as skipped. Streak paused — tomorrow is a new quest.', 'danger');
}

/* XP is only owed for a day that is still cleared. Reopening or wiping the
   record takes the award back, so totals can't be farmed by re-clearing. */
function revokeWorkoutXp(log) {
  if (!log || !log.xpAwarded) return false;
  log.xpAwarded = false;
  state.xp = Math.max(0, state.xp - XP_WORKOUT);
  return true;
}

function reopenDay(key) {
  const log = state.logs[key];
  if (!log) return;
  log.status = 'pending';
  const lost = revokeWorkoutXp(log);
  save();
  renderAll();
  toast(lost ? 'Quest reopened. Awarded XP returned.' : 'Quest reopened.');
}

function clearDay(key) {
  const lost = revokeWorkoutXp(state.logs[key]);
  delete state.logs[key];
  save();
  renderAll();
  toast(lost ? 'Record cleared. Awarded XP returned.' : 'Record cleared.');
}

function toggleExercise(key, index) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return;
  ex.done = !ex.done;
  if (log.status === 'completed' && log.exercises.some((e) => !e.done)) log.status = 'pending';
  save();
  renderAll();
}

function deleteExercise(key, index) {
  const log = ensureLog(key);
  log.exercises.splice(index, 1);
  save();
  renderAll();
}

function saveExerciseEdit(key, index) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return;
  const name = ($('[data-ex-field="name"]')?.value || '').trim();
  if (!name) { toast('Exercise needs a name.', 'danger'); return; }
  ex.name = name;
  ex.sets = clampNum($('[data-ex-field="sets"]')?.value, 1, 999, 3);
  ex.reps = clampNum($('[data-ex-field="reps"]')?.value, 1, 999, 10);
  ex.weight = clampNum($('[data-ex-field="weight"]')?.value, 0, 500, 0);
  save();
  closeModal();
  renderAll();
  toast('Exercise updated.');
}

function addNewExercise(key) {
  const name = ($('[data-ex-field="name"]')?.value || '').trim();
  if (!name) { toast('Exercise needs a name.', 'danger'); return; }
  const log = ensureLog(key);
  log.exercises.push({
    name,
    sets: clampNum($('[data-ex-field="sets"]')?.value, 1, 999, 3),
    reps: clampNum($('[data-ex-field="reps"]')?.value, 1, 999, 10),
    weight: clampNum($('[data-ex-field="weight"]')?.value, 0, 500, 0),
    done: false
  });
  if (log.status === 'completed') log.status = 'pending';
  save();
  closeModal();
  renderAll();
  toast('Exercise added to today.');
}

function setTodayTemplate(id) {
  const key = todayKey();
  const log = ensureLog(key);
  const tpl = state.templates.find((t) => t.id === id) || null;
  log.templateId = tpl ? tpl.id : null;
  log.exercises = tpl ? tpl.exercises.map((e) => ({ ...e, done: false })) : [];
  if (log.status === 'completed') log.status = 'pending';
  save();
  renderAll();
}

/* ---------------- settings ---------------- */

function openSettings() {
  const perm = notifySupported() ? Notification.permission : 'unsupported';
  const permLabel = perm === 'granted' ? 'ALERTS ON' : perm === 'denied' ? 'BLOCKED' : perm === 'unsupported' ? 'UNSUPPORTED' : 'ENABLE ALERTS';
  const every = state.reminders.everyMin;
  const account = typeof auth !== 'undefined' ? auth.user : null;
  const googleReady = typeof auth !== 'undefined' && auth.config ? !!auth.config.google : false;
  openModal(`
    <h2>SYSTEM SETTINGS</h2>
    <div class="sub">Goals, alerts and hunter identity.</div>
    <div class="form-grid">
      <label class="field"><span class="lbl">HUNTER NAME</span>
        <input type="text" data-set="name" value="${esc(state.hunter)}" />
      </label>
      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">BODY &amp; BMI</h2><div class="line"></div></div>
      ${profileFieldsHtml()}
      <div class="form-grid two">
        <label class="field"><span class="lbl">DAILY WATER GOAL (ML)</span>
          <input type="number" min="500" max="8000" step="100" data-set="water" value="${state.goals.water}" />
        </label>
        <label class="field"><span class="lbl">WORKOUTS PER WEEK</span>
          <input type="number" min="1" max="14" data-set="weekly" value="${state.goals.weekly}" />
        </label>
      </div>
      <div class="form-grid two">
        <label class="field"><span class="lbl">DAILY CALORIE GOAL</span>
          <input type="number" min="1000" max="6000" step="50" data-set="kcal" value="${state.nutrition.kcal}" />
        </label>
        <label class="field"><span class="lbl">DAILY PROTEIN GOAL (G)</span>
          <input type="number" min="40" max="400" step="5" data-set="protein" value="${state.nutrition.protein}" />
        </label>
      </div>
      <div class="form-grid two">
        <label class="field"><span class="lbl">REMINDER INTERVAL (MIN)</span>
          <input type="number" min="15" max="360" step="15" data-set="every" value="${every}" />
        </label>
        <div class="field"><span class="lbl">BROWSER NOTIFICATIONS</span>
          <button class="btn block" data-act="notify-perm">${permLabel}</button>
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" data-change="settings-reminders" ${state.reminders.enabled ? 'checked' : ''} />
        <span class="track2"></span>
        <span class="sw-label">Water reminders (8:00 – 22:00)</span>
      </label>
      <p class="panel-sub" style="margin:4px 0 0;font-size:12.5px">
        In-app reminders fire while this app is open. Turn on device notifications below to be reminded even when the tab is closed.
      </p>

      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">BACKUP</h2><div class="line"></div></div>
      <p class="panel-sub" style="margin:0;font-size:12.5px;line-height:1.6">
        This browser caches your history under <code>${STORE_KEY}</code> (${storageSizeKb()} KB).
        The server keeps the durable copy — export a backup file now and then as well.
      </p>
      <div class="modal-actions" style="margin-top:0;justify-content:flex-start">
        <button class="btn" data-act="export-backup">EXPORT BACKUP</button>
        <button class="btn ghost" data-act="import-backup">IMPORT BACKUP</button>
      </div>
      <input type="file" accept="application/json,.json" data-backup-file hidden />

      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">ACCOUNT</h2><div class="line"></div></div>
      <p class="panel-sub" style="margin:0;font-size:12.5px;line-height:1.6">
        <span id="settingsAccount">${esc(typeof authAccountLabel === 'function' ? authAccountLabel() : 'Not signed in.')}</span>
      </p>
      <div class="modal-actions" style="margin-top:0;justify-content:flex-start">
        ${account
          ? '<button class="btn ghost" data-act="auth-signout">SIGN OUT</button>'
          : '<button class="btn" data-act="auth-open">SIGN IN OR CREATE ACCOUNT</button>'}
      </div>

      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">GOOGLE ACCOUNT</h2><div class="line"></div></div>
      <p class="panel-sub" style="margin:0;font-size:12.5px;line-height:1.6">
        ${account
          ? account.google
            ? 'Google is connected to this account. You can sign in with your password or with Google — same account, same record.'
            : googleReady
              ? 'Connect Google to sign in with one tap on any device. It attaches to this account, so nothing is duplicated or lost.'
              : 'Google sign-in is not configured on this deployment yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets to switch it on.'
          : 'Sign in first, then Google can be attached to that account.'}
      </p>
      ${account && !account.google && googleReady
        ? '<div class="modal-actions" style="margin-top:0;justify-content:flex-start"><button class="btn" data-act="link-google">CONNECT GOOGLE</button></div>'
        : ''}

      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">TUTORIAL</h2><div class="line"></div></div>
      <p class="panel-sub" style="margin:0;font-size:12.5px;line-height:1.6">
        Replay the walkthrough: today's quest, water, workouts, nutrition, progress and where the settings live.
      </p>
      <div class="modal-actions" style="margin-top:0;justify-content:flex-start">
        <button class="btn" data-act="start-tour">SHOW TUTORIAL</button>
      </div>

      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">DEVICE NOTIFICATIONS</h2><div class="line"></div></div>
      <p class="panel-sub" style="margin:0;font-size:12.5px;line-height:1.6">
        <span id="settingsPush">${esc(typeof pushStatusText === 'function' ? pushStatusText() : 'Off.')}</span>
      </p>
      <p class="panel-sub" style="margin:6px 0 0;font-size:12px">
        Device notifications are delivered by the server, so they arrive even when this app is closed.
      </p>
      <div class="modal-actions" style="margin-top:0;justify-content:flex-start">
        <button class="btn" data-act="push-enable">ENABLE ON THIS DEVICE</button>
        <button class="btn ghost" data-act="push-test">SEND TEST</button>
        <button class="btn ghost" data-act="push-disable">TURN OFF</button>
      </div>

      <div class="section-head" style="margin:18px 0 10px"><h2 style="font-size:10px">SERVER SYNC</h2><div class="line"></div></div>
      <p class="panel-sub" style="margin:0;font-size:12.5px;line-height:1.6">
        <span id="settingsSync">${typeof syncStatusText === 'function' ? syncStatusText() : 'LOCAL ONLY'}</span>.
        Every change is pushed to the server automatically, and the newest copy wins on any device.
        PULL NOW replaces this browser's copy with the server's. The server only ever answers the
        account you are signed in with.
      </p>
      <div class="modal-actions" style="margin-top:0;justify-content:flex-start">
        <button class="btn" data-act="sync-push">PUSH NOW</button>
        <button class="btn ghost" data-act="sync-pull">PULL NOW</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-act="save-settings">SAVE</button>
      <button class="btn danger" data-act="reset-data">RESET ALL DATA</button>
    </div>
  `);
}

function saveSettings() {
  const name = ($('[data-set="name"]')?.value || '').trim();
  state.hunter = name || 'HUNTER';
  const before = { water: state.goals.water, kcal: state.nutrition.kcal, protein: state.nutrition.protein };
  const typed = {
    water: Number($('[data-set="water"]')?.value),
    kcal: Number($('[data-set="kcal"]')?.value),
    protein: Number($('[data-set="protein"]')?.value)
  };
  const beforeWeight = profileOf().weightKg;
  const profile = readProfileInputs();
  if (profile) {
    state.profile = profile;
    if (profile.weightKg !== beforeWeight) recordWeight(profile.weightKg);
    applyProfileTargets();
  }
  // A typed target wins only when the hunter actually changed that field;
  // otherwise a new weight would be immediately overwritten by the stale box.
  if (Number.isFinite(typed.water) && typed.water !== before.water) {
    state.goals.water = clampNum(typed.water, 500, 8000, state.goals.water);
  }
  if (Number.isFinite(typed.kcal) && typed.kcal !== before.kcal) {
    state.nutrition.kcal = clampNum(typed.kcal, 1000, 6000, state.nutrition.kcal);
  }
  if (Number.isFinite(typed.protein) && typed.protein !== before.protein) {
    state.nutrition.protein = clampNum(typed.protein, 40, 400, state.nutrition.protein);
  }
  state.goals.weekly = clampNum($('[data-set="weekly"]')?.value, 1, 14, 4);
  state.reminders.everyMin = clampNum($('[data-set="every"]')?.value, 15, 360, 90);
  save();
  closeModal();
  renderAll();
  toast('Settings saved.');
}

/* ---------------- guided tour --------------
   The first run walks through the app one part at a time: everything but
   the current element is dimmed and a card says what it is for. Skipping
   still marks it done, and Settings can replay it at any time. */

const TOUR_STEPS = [
  {
    title: 'WELCOME TO THE SYSTEM',
    body: 'This is your personal training record. Your hunt starts today, so nothing from before today ever shows up as a missed quest. Here is where everything lives.',
    view: 'today'
  },
  {
    title: 'LEVEL, RANK & XP',
    target: '.topbar',
    body: 'Clearing a workout earns +100 XP; hitting the water goal earns +40. XP raises your level and your level sets the rank beside it.',
    view: 'today'
  },
  {
    title: 'THE DAILY QUEST',
    target: '#view-today .quest',
    body: 'Your workout for today. Tick each exercise as you finish it, then press COMPLETE QUEST. Swapping the workout or adding one exercise only changes today, never your saved library.',
    view: 'today'
  },
  {
    title: 'HYDRATION',
    target: '#view-today .panel',
    body: 'Tap +250, +500 or +750 ml as you drink. The ring fills towards your daily goal, and the reminder switch nags you every 90 minutes between 08:00 and 22:00.',
    view: 'today'
  },
  {
    title: 'WORKOUT LIBRARY',
    target: '#view-workouts .card-grid',
    body: 'Forge your own workouts here and assign them to days of the week. The Today screen follows that schedule automatically, and every day you keep is recorded in the quest map.',
    view: 'workouts'
  },
  {
    title: 'NUTRITION',
    target: '#view-nutrition .panel',
    body: 'Log what you eat against your calorie and protein targets, keep the pantry honest, and ask the AI coach for a plan built from what you actually have at home.',
    view: 'nutrition'
  },
  {
    title: 'PROGRESS',
    target: '#view-progress .panel',
    body: 'Weigh in here and the trend line plus BMI change build up over time. The quest map below fills as you go; days before you started stay blank on purpose.',
    view: 'progress'
  },
  {
    title: 'SETTINGS',
    target: '#settingsBtn',
    body: 'The gear holds your goals, body profile, device notifications, Google sign-in, backups and this tutorial.',
    view: 'today'
  },
  {
    title: 'ALMOST THERE',
    body: 'Two things worth doing now: turn on device notifications so reminders reach your phone with the app closed, and connect Google in Settings for one-tap sign-in. This tour lives in Settings → SHOW TUTORIAL whenever you want it again.',
    view: 'today'
  }
];

let tourIndex = 0;
let tourActive = false;

function tourRoot() {
  let root = document.getElementById('tour');
  if (!root) {
    root = document.createElement('div');
    root.id = 'tour';
    root.className = 'tour';
    root.hidden = true;
    root.innerHTML = `
      <div class="tour-spot" id="tourSpot" aria-hidden="true"></div>
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle">
        <div class="tour-top">
          <span class="tour-count" id="tourCount"></span>
          <button class="tour-skip" data-act="tour-end" type="button">SKIP</button>
        </div>
        <h3 id="tourTitle"></h3>
        <p id="tourBody"></p>
        <div class="tour-actions">
          <button class="btn ghost" data-act="tour-back" type="button">BACK</button>
          <button class="btn primary" data-act="tour-next" type="button">NEXT</button>
        </div>
      </div>`;
    document.body.appendChild(root);
  }
  return root;
}

function tourTarget(step) {
  return step && step.target ? document.querySelector(step.target) : null;
}

function tourPlaceSpot() {
  const spot = document.getElementById('tourSpot');
  if (!spot) return;
  const el = tourActive ? tourTarget(TOUR_STEPS[tourIndex]) : null;
  if (!el) {
    spot.style.opacity = '0';
    return;
  }
  const rect = el.getBoundingClientRect();
  const pad = 8;
  spot.style.opacity = '1';
  spot.style.top = `${Math.max(4, rect.top - pad)}px`;
  spot.style.left = `${Math.max(4, rect.left - pad)}px`;
  spot.style.width = `${Math.min(window.innerWidth - 8, rect.width + pad * 2)}px`;
  spot.style.height = `${Math.min(window.innerHeight - 8, rect.height + pad * 2)}px`;
}

function showTourStep() {
  const step = TOUR_STEPS[tourIndex];
  if (!step) return endTour();
  tourRoot().hidden = false;
  tourActive = true;
  document.body.classList.add('is-touring');
  if (step.view) switchView(step.view);

  const count = document.getElementById('tourCount');
  const title = document.getElementById('tourTitle');
  const body = document.getElementById('tourBody');
  if (count) count.textContent = `${tourIndex + 1} / ${TOUR_STEPS.length}`;
  if (title) title.textContent = step.title;
  if (body) body.textContent = step.body;

  const back = document.querySelector('[data-act="tour-back"]');
  if (back) back.hidden = tourIndex === 0;
  const next = document.querySelector('[data-act="tour-next"]');
  if (next) next.textContent = tourIndex === TOUR_STEPS.length - 1 ? 'START TRAINING' : 'NEXT';

  const el = tourTarget(step);
  if (el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { /* older browser */ }
  }
  requestAnimationFrame(tourPlaceSpot);
  setTimeout(tourPlaceSpot, 320);
}

function nextTourStep() {
  if (tourIndex >= TOUR_STEPS.length - 1) {
    endTour();
    return;
  }
  tourIndex++;
  showTourStep();
}

function prevTourStep() {
  if (tourIndex === 0) return;
  tourIndex--;
  showTourStep();
}

function startTour() {
  tourIndex = 0;
  showTourStep();
}

/* Called on boot, after sign-in and after the profile step, so the tour
   never lands on top of the gate or a modal. */
function maybeStartTour() {
  if (tourActive) return;
  if (state.meta && state.meta.tourDone) return;
  // Access has to be settled first: while the session check is in flight the
  // gate is still hidden, and the tour would open underneath it.
  if (typeof auth !== 'undefined' && !auth.checked) return;
  if (typeof auth !== 'undefined' && !auth.user && !auth.guest) return;
  const gate = $('#authScreen');
  if (gate && !gate.hidden) return;
  const modal = $('#modalRoot');
  if (modal && !modal.hidden) return;
  setTimeout(() => {
    if (tourActive) return;
    const gateNow = $('#authScreen');
    if (gateNow && !gateNow.hidden) return;
    const stillModal = $('#modalRoot');
    if (stillModal && !stillModal.hidden) return;
    startTour();
  }, 420);
}

function endTour() {
  tourActive = false;
  const root = document.getElementById('tour');
  if (root) root.hidden = true;
  document.body.classList.remove('is-touring');
  state.meta = { ...(state.meta || {}), tourDone: true };
  save();
  toast('Tour closed. Settings → SHOW TUTORIAL brings it back.');
}

window.addEventListener('resize', () => { if (tourActive) tourPlaceSpot(); });
window.addEventListener('scroll', () => { if (tourActive) tourPlaceSpot(); }, { passive: true });

/* ---------------- events ---------------- */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  tapFeedback();
  const act = el.dataset.act;
  const key = el.dataset.key;
  const i = el.dataset.i !== undefined ? Number(el.dataset.i) : null;

  switch (act) {
    case 'tab': switchView(el.dataset.view); break;
    case 'open-settings': openSettings(); break;
    case 'modal-close': closeModal(); break;
    case 'start-tour': closeModal(); startTour(); break;
    case 'link-google': location.href = '/api/auth/google/start?link=1'; break;
    case 'tour-next': nextTourStep(); break;
    case 'tour-back': prevTourStep(); break;
    case 'tour-end': endTour(); break;

    case 'notify-perm': {
      const ok = await requestNotifyPermission();
      if (ok) {
        state.reminders.enabled = true;
        save();
        renderAll();
        el.textContent = 'ALERTS ON';
      }
      break;
    }

    case 'water-add': addWater(Number(el.dataset.ml) || 0); break;
    case 'water-reset':
      if (confirm('Reset today\'s water intake to 0?')) {
        state.water[todayKey()] = 0;
        save();
        renderAll();
      }
      break;

    case 'toggle-ex': toggleExercise(key, i); break;
    case 'edit-ex': openExerciseEditor(key, i); break;
    case 'save-ex': saveExerciseEdit(key, i); break;
    case 'del-ex': deleteExercise(key, i); break;
    case 'add-ex': openNewExercise(key); break;
    case 'save-new-ex': addNewExercise(key); break;

    case 'complete-day': completeDay(key); break;
    case 'skip-day': skipDay(key); break;
    case 'reopen-day': reopenDay(key); break;
    case 'day-open': openDayModal(key); break;
    case 'day-clear':
      if (confirm('Clear the record for this day?')) { clearDay(key); closeModal(); }
      break;
    case 'day-status':
      if (el.dataset.status === 'completed') completeDay(key);
      else skipDay(key);
      closeModal();
      break;

    case 'new-template': openTemplateEditor(null); break;
    case 'edit-template': openTemplateEditor(el.dataset.id); break;
    case 'delete-template': {
      const tpl = state.templates.find((t) => t.id === el.dataset.id);
      if (!tpl) break;
      if (confirm(`Delete "${tpl.name}"? Days scheduled with it become rest days.`)) {
        state.templates = state.templates.filter((t) => t.id !== tpl.id);
        Object.keys(state.schedule).forEach((d) => { if (state.schedule[d] === tpl.id) state.schedule[d] = null; });
        save();
        renderAll();
        toast('Workout deleted.');
      }
      break;
    }
    case 'tpl-add-row':
      collectTemplateDraft();
      draft.exercises.push(blankExercise());
      renderTemplateEditor();
      break;
    case 'tpl-rm-row':
      collectTemplateDraft();
      draft.exercises.splice(i, 1);
      renderTemplateEditor();
      break;
    case 'tpl-save': {
      collectTemplateDraft();
      if (!draft) break;
      const wasNew = draft.isNew;
      const cleaned = draft.exercises.filter((ex) => ex.name);
      const template = { id: draft.id, name: draft.name, focus: draft.focus, exercises: cleaned.length ? cleaned : [{ name: 'New Exercise', sets: 3, reps: 10, weight: 0 }] };
      if (wasNew) state.templates.push(template);
      else state.templates = state.templates.map((t) => (t.id === template.id ? template : t));
      save();
      closeModal();
      renderAll();
      toast(wasNew ? 'Workout forged.' : 'Workout updated.', 'gold');
      break;
    }

    case 'save-settings': saveSettings(); break;
    case 'save-profile': saveProfile(); break;
    case 'profile-later': closeModal(); maybeStartTour(); break;
    case 'log-weight': logWeight(); break;
    case 'export-backup': exportBackup(); break;
    case 'import-backup': {
      const input = $('[data-backup-file]');
      if (input) input.click();
      break;
    }
    case 'reset-data':
      if (confirm('Erase all workouts, water logs and progress? This cannot be undone.')) {
        try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
        memoryStore = null;
        state = defaultState();
        save();
        closeModal();
        renderAll();
        toast('All data reset. A new hunt begins.');
      }
      break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const mode = el.dataset.change;

  if (mode === 'today-template') {
    setTodayTemplate(el.value);
  } else if (mode === 'schedule') {
    const dow = Number(el.dataset.dow);
    state.schedule[dow] = el.value || null;
    save();
    renderAll();
    toast('Schedule updated.');
  } else if (mode === 'reminders-toggle') {
    state.reminders.enabled = el.checked;
    if (el.checked) {
      state.reminders.lastNotifiedAt = Date.now();
      requestNotifyPermission().then((ok) => {
        if (!ok) toast('Reminders will appear as in-app alerts until browser alerts are allowed.');
      });
    }
    save();
    renderAll();
  } else if (mode === 'settings-reminders') {
    state.reminders.enabled = el.checked;
    save();
    if (el.checked) requestNotifyPermission();
  }
});

document.addEventListener('input', (e) => {
  if (!e.target.matches || !e.target.matches('[data-profile]')) return;
  const line = $('#bmiPreview');
  if (!line) return;
  const height = Number($('[data-profile="height"]')?.value) || 0;
  const weight = Number($('[data-profile="weight"]')?.value) || 0;
  line.innerHTML = bmiLine({ heightCm: height, weightKg: weight });
});

document.addEventListener('change', (e) => {
  if (e.target.matches && e.target.matches('[data-backup-file]')) {
    importBackupFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-weight-input]')) {
    e.preventDefault();
    logWeight();
    return;
  }
  if (e.key === 'Escape' && tourActive) { endTour(); return; }
  if (e.key === 'Escape' && !$('#modalRoot').hidden) closeModal();
});

/* ---------------- boot ---------------- */

ensureStartDate();
renderAll();
setTimeout(maybeStartTour, 1800);
setInterval(checkWaterReminder, 30000);
setInterval(renderTopbar, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });
