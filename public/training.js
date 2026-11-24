'use strict';

/* ======================================================================
   Training engine
   ----------------------------------------------------------------------
   Loaded after app.js and nutrition.js; shares the same `state`.

   - per-set logs      every set of an exercise can be recorded, which is
                       what makes personal records and overload possible
   - live session      one exercise at a time with a rest timer
   - program builder   a starting split from equipment, experience and days
   - measurements      waist / chest / arms next to the weigh-ins
   - adaptive targets  recalibrate calories and protein from the trend
   - weekly report     a shareable card of the last seven days
   ====================================================================== */

const OVERLOAD_STEP = 2.5;
const REST_CHOICES = [60, 90, 120, 180];

/* ---------------- per-set records ---------------- */

function setsOf(ex) {
  return Array.isArray(ex && ex.log) ? ex.log.filter((s) => s && Number.isFinite(Number(s.reps))) : [];
}

function topOf(sets) {
  if (!sets || !sets.length) return null;
  return sets.reduce((best, s) => ((Number(s.weight) || 0) > (Number(best.weight) || 0) ? s : best), sets[0]);
}

function setLine(set) {
  if (!set) return '';
  const reps = Number(set.reps) || 0;
  const weight = Number(set.weight) || 0;
  return weight > 0 ? `${weight} kg × ${reps}` : `${reps} reps`;
}

/* Every logged set for one exercise name, oldest first. */
function exerciseSessions(name, skipKey) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  Object.keys(state.logs || {}).sort().forEach((key) => {
    if (key === skipKey) return;
    const log = state.logs[key];
    if (!log) return;
    (log.exercises || []).forEach((ex) => {
      if (String(ex.name || '').trim().toLowerCase() !== needle) return;
      const sets = setsOf(ex);
      if (sets.length) out.push({ key, sets });
    });
  });
  return out;
}

function lastSessionFor(name, skipKey) {
  const all = exerciseSessions(name, skipKey);
  return all.length ? all[all.length - 1] : null;
}

function prFor(name, skipKey) {
  let best = null;
  exerciseSessions(name, skipKey).forEach((session) => {
    session.sets.forEach((set) => {
      const weight = Number(set.weight) || 0;
      if (!weight) return;
      if (!best || weight > best.weight) {
        best = { weight, reps: Number(set.reps) || 0, key: session.key };
      }
    });
  });
  return best;
}

function agoLabel(key) {
  if (!key) return '';
  const days = Math.round((parseKey(todayKey()) - parseKey(key)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  return `${Math.round(days / 7)} weeks ago`;
}

/* A one-line memory under each exercise: what you did last time and the best
   you have ever done, so the next set has a target before you touch a bar. */
function setBadgeHtml(key, ex) {
  const sets = setsOf(ex);
  const planned = Number(ex.sets) || 0;
  const last = lastSessionFor(ex.name, key);
  const pr = prFor(ex.name, key);
  const parts = [];
  if (sets.length) {
    const top = topOf(sets);
    parts.push(`today ${sets.length}/${planned || sets.length}${top ? ` · ${setLine(top)}` : ''}`);
  } else if (last) {
    const top = topOf(last.sets);
    parts.push(`last ${agoLabel(last.key)}${top ? ` · ${setLine(top)}` : ''}`);
  } else {
    parts.push('first time — start light');
  }
  if (pr) parts.push(`PR ${pr.weight} kg`);
  return `<span class="ex-badge">${esc(parts.join(' · '))}</span>`;
}

/* Hit every planned rep last time? Then the bar goes up. */
function nextLoadHint(ex, last, pr) {
  const planned = Number(ex.reps) || 10;
  const weight = Number(ex.weight) || 0;
  if (!last) return 'No history yet — pick a weight you can control for every rep.';
  const top = topOf(last.sets);
  const allHit = last.sets.every((s) => (Number(s.reps) || 0) >= planned);
  if (top && allHit && (Number(top.weight) || 0) > 0) {
    return `You hit every rep at ${top.weight} kg last time — try ${(Number(top.weight) + OVERLOAD_STEP)} kg today.`;
  }
  if (top && (Number(top.weight) || 0) > 0) {
    return `Last time: ${setLine(top)}. Stay at that weight until all ${planned} reps come clean.`;
  }
  return `Bodyweight last time (${setLine(top)}). Add a rep or slow the tempo.`;
}

/* ---------------- logging a set ---------------- */

function openSetLogger(key, index) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return;
  const sets = setsOf(ex);
  const planned = Number(ex.sets) || 3;
  const reps = Number(ex.reps) || 10;
  const last = lastSessionFor(ex.name, key);
  const pr = prFor(ex.name, key);
  const lastSet = topOf(sets) || topOf(last ? last.sets : []) || null;

  const rows = sets.map((set, i) => `
    <li class="set-row">
      <span class="set-no">SET ${i + 1}</span>
      <span class="set-val">${setLine(set)}</span>
      <button class="icon-btn sm" data-act="set-rm" data-key="${key}" data-i="${index}" data-s="${i}" aria-label="Remove set ${i + 1}">×</button>
    </li>`).join('');

  openModal(`
    <h2>${esc(ex.name)}</h2>
    <div class="sub">${planned} × ${reps} planned${pr ? ` · best ${pr.weight} kg` : ''}</div>
    <p class="panel-sub" style="margin:0 0 12px;line-height:1.6">${esc(nextLoadHint(ex, last, pr))}</p>
    ${rows ? `<ul class="set-list">${rows}</ul>` : '<div class="empty">No sets recorded yet.</div>'}
    <div class="form-grid two">
      <label class="field"><span class="lbl">WEIGHT (KG)</span>
        <input type="number" min="0" max="500" step="0.5" inputmode="decimal" data-set-field="weight" data-change="set-weight" value="${lastSet ? lastSet.weight : (Number(ex.weight) || 0)}" />
      </label>
      <label class="field"><span class="lbl">REPS</span>
        <input type="number" min="0" max="500" inputmode="numeric" data-set-field="reps" value="${reps}" />
      </label>
    </div>
    <p class="plate-line">${esc(plateLine(lastSet ? lastSet.weight : (Number(ex.weight) || 0)))}</p>
    ${warmupHtml(lastSet ? lastSet.weight : (Number(ex.weight) || 0))}
    ${typeof readinessTargetHtml === 'function' ? readinessTargetHtml(lastSet ? lastSet.weight : (Number(ex.weight) || 0)) : ''}
    <div class="modal-actions">
      <button class="btn primary" data-act="set-add" data-key="${key}" data-i="${index}">LOG THIS SET</button>
      <button class="btn ghost" data-act="swap-open" data-key="${key}" data-i="${index}">SWAP</button>
      <button class="btn ghost" data-act="modal-close">DONE</button>
    </div>
  `);
}

function addSet(key, index) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) return;
  const reps = clampNum($('[data-set-field="reps"]')?.value, 0, 500, 0);
  const weight = clampNum($('[data-set-field="weight"]')?.value, 0, 500, 0);
  if (!reps && !weight) { toast('Enter reps or a weight first.', 'danger'); return; }
  const pr = prFor(ex.name, key);
  if (!Array.isArray(ex.log)) ex.log = [];
  ex.log.push({ reps, weight });
  // The plan's weight follows the heaviest set actually done, so the load in
  // the session log, the history and the trainer notes stay truthful.
  const top = topOf(setsOf(ex));
  if (top && Number(top.weight) > 0) ex.weight = Number(top.weight);
  const planned = Number(ex.sets) || 0;
  if (planned && setsOf(ex).length >= planned) ex.done = true;
  const isPr = pr && Number(weight) > pr.weight;
  save();
  closeModal();
  renderAll();
  if (isPr) toast(`NEW RECORD · ${ex.name} ${weight} kg`, 'gold');
  else toast(`Set logged: ${setLine({ reps, weight })}.`);
  openSetLogger(key, index);
}

function removeSet(key, index, setIndex) {
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex || !Array.isArray(ex.log)) return;
  ex.log.splice(setIndex, 1);
  if (!ex.log.length) delete ex.log;
  const planned = Number(ex.sets) || 0;
  if (planned && setsOf(ex).length < planned) ex.done = false;
  save();
  renderAll();
  openSetLogger(key, index);
}

/* ---------------- live session ---------------- */

let liveSession = null;
let wakeLock = null;

/* Keeping the screen on between sets is the difference between the phone
   sleeping at set 2 and the session being usable in a real gym. The lock is
   best-effort: browsers without it simply skip this. */
async function requestWakeLock() {
  try {
    if (!navigator.wakeLock || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    if (wakeLock) wakeLock.release();
  } catch (err) {
    /* ignore */
  }
  wakeLock = null;
}

/* The session itself lives in the record, so a reload, a locked phone or a
   killed tab can pick it up instead of starting over. */
function persistLiveSession() {
  if (!liveSession) return;
  state.live = {
    key: liveSession.key,
    index: liveSession.index,
    until: liveSession.until || 0,
    startedAt: liveSession.startedAt || Date.now()
  };
  save();
}

function resumeLiveSession() {
  const saved = state.live;
  if (!saved || !saved.key || !state.logs[saved.key]) {
    if (saved) { state.live = null; save(); }
    return false;
  }
  const log = state.logs[saved.key];
  const index = Math.min(Math.max(0, Number(saved.index) || 0), Math.max(0, log.exercises.length - 1));
  liveSession = {
    key: saved.key,
    index,
    until: Number(saved.until) || 0,
    startedAt: Number(saved.startedAt) || Date.now(),
    timer: setInterval(paintRestClock, 500)
  };
  requestWakeLock();
  renderLiveSession();
  return true;
}

function restSeconds() {
  const value = Number((state.meta || {}).restSec);
  return REST_CHOICES.indexOf(value) >= 0 ? value : 90;
}

function startLiveSession(key) {
  const log = ensureLog(key);
  if (!log.exercises.length) {
    toast('Nothing scheduled to train. Pick a workout first.', 'danger');
    return;
  }
  const firstOpen = log.exercises.findIndex((ex) => !ex.done);
  liveSession = { key, index: firstOpen >= 0 ? firstOpen : 0, until: 0, startedAt: Date.now() };
  persistLiveSession();
  requestWakeLock();
  renderLiveSession();
  if (liveSession && liveSession.timer) clearInterval(liveSession.timer);
  liveSession.timer = setInterval(paintRestClock, 500);
}

function endLiveSession(silent) {
  if (!liveSession) return;
  clearInterval(liveSession.timer);
  const done = ensureLog(liveSession.key).exercises.filter((e) => e.done).length;
  const total = ensureLog(liveSession.key).exercises.length;
  liveSession = null;
  state.live = null;
  releaseWakeLock();
  save();
  closeModal();
  if (!silent) toast(`Session ended — ${done}/${total} exercises done.`, done === total ? 'gold' : '');
  renderAll();
}

function paintRestClock() {
  const el = document.getElementById('liveRest');
  if (!el || !liveSession) return;
  const left = Math.max(0, Math.ceil((liveSession.until - Date.now()) / 1000));
  el.textContent = left > 0 ? `REST ${left}s` : 'READY';
  el.classList.toggle('is-resting', left > 0);
  if (left === 0 && liveSession.until) {
    liveSession.until = 0;
    try { if (navigator.vibrate) navigator.vibrate([40, 60, 40]); } catch (err) { /* ignore */ }
  }
}

function renderLiveSession() {
  if (!liveSession) return;
  const { key, index } = liveSession;
  const log = ensureLog(key);
  const ex = log.exercises[index];
  if (!ex) { endLiveSession(true); return; }
  const sets = setsOf(ex);
  const planned = Math.max(Number(ex.sets) || 1, sets.length);
  const last = lastSessionFor(ex.name, key);
  const pr = prFor(ex.name, key);
  const lastSet = topOf(sets) || topOf(last ? last.sets : []) || null;

  const chips = Array.from({ length: planned }, (_, i) => {
    const set = sets[i];
    return `<span class="live-set ${set ? 'is-done' : ''}">${set ? setLine(set) : `SET ${i + 1}`}</span>`;
  }).join('');

  const restOptions = REST_CHOICES.map(
    (sec) => `<option value="${sec}"${sec === restSeconds() ? ' selected' : ''}>${sec}s</option>`
  ).join('');

  openModal(`
    <div class="live-head">
      <span class="live-count">${index + 1} / ${log.exercises.length}</span>
      <span class="live-rest" id="liveRest">READY</span>
    </div>
    <h2>${esc(ex.name)}</h2>
    <div class="sub">${planned} × ${ex.reps} target${pr ? ` · best ${pr.weight} kg` : ''}</div>
    <div class="live-sets">${chips}</div>
    <div class="form-grid two">
      <label class="field"><span class="lbl">WEIGHT (KG)</span>
        <input type="number" min="0" max="500" step="0.5" inputmode="decimal" data-set-field="weight" data-change="set-weight" value="${lastSet ? lastSet.weight : (Number(ex.weight) || 0)}" />
      </label>
      <label class="field"><span class="lbl">REPS</span>
        <input type="number" min="0" max="500" inputmode="numeric" data-set-field="reps" value="${Number(ex.reps) || 10}" />
      </label>
    </div>
    <p class="plate-line">${esc(plateLine(lastSet ? lastSet.weight : (Number(ex.weight) || 0)))}</p>
    ${warmupHtml(lastSet ? lastSet.weight : (Number(ex.weight) || 0))}
    ${typeof readinessTargetHtml === 'function' ? readinessTargetHtml(lastSet ? lastSet.weight : (Number(ex.weight) || 0)) : ''}
    <div class="live-row">
      <button class="btn primary" data-act="live-set" data-key="${key}">LOG SET + REST</button>
      <label class="field live-rest-pick"><span class="lbl">REST</span>
        <select data-change="rest-sec">${restOptions}</select>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-act="live-prev" data-key="${key}">BACK</button>
      <button class="btn" data-act="live-next" data-key="${key}">NEXT MOVE</button>
      <button class="btn ghost" data-act="swap-open" data-key="${key}" data-i="${index}">SWAP</button>
      <button class="btn ghost" data-act="live-end" data-key="${key}">END SESSION</button>
    </div>
  `);
  paintRestClock();
}

function liveLogSet(key) {
  if (!liveSession) return;
  const log = ensureLog(key);
  const ex = log.exercises[liveSession.index];
  if (!ex) return;
  const reps = clampNum($('[data-set-field="reps"]')?.value, 0, 500, 0);
  const weight = clampNum($('[data-set-field="weight"]')?.value, 0, 500, 0);
  if (!reps && !weight) { toast('Enter reps or a weight first.', 'danger'); return; }
  const pr = prFor(ex.name, key);
  if (!Array.isArray(ex.log)) ex.log = [];
  ex.log.push({ reps, weight });
  const top = topOf(setsOf(ex));
  if (top && Number(top.weight) > 0) ex.weight = Number(top.weight);
  const planned = Number(ex.sets) || 0;
  if (planned && setsOf(ex).length >= planned) ex.done = true;
  liveSession.until = Date.now() + restSeconds() * 1000;
  persistLiveSession();
  renderLiveSession();
  if (pr && Number(weight) > pr.weight) toast(`NEW RECORD · ${ex.name} ${weight} kg`, 'gold');
}

function liveMove(delta) {
  if (!liveSession) return;
  const log = ensureLog(liveSession.key);
  const next = liveSession.index + delta;
  if (next < 0 || next >= log.exercises.length) { endLiveSession(); return; }
  liveSession.index = next;
  liveSession.until = 0;
  persistLiveSession();
  renderLiveSession();
}

/* ---------------- body measurements ---------------- */

const MEASURE_FIELDS = [
  ['waist', 'WAIST (CM)'],
  ['chest', 'CHEST (CM)'],
  ['arms', 'ARMS (CM)'],
  ['thighs', 'THIGHS (CM)'],
  ['fat', 'BODY FAT (%)']
];

function measureEntries() {
  const raw = state.measures || {};
  return Object.keys(raw)
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort()
    .map((key) => ({ key, ...raw[key] }));
}

function measureDelta(field) {
  const entries = measureEntries().filter((e) => Number(e[field]) > 0);
  if (entries.length < 2) return null;
  const first = entries[0];
  const last = entries[entries.length - 1];
  return { first, last, value: Math.round((Number(last[field]) - Number(first[field])) * 10) / 10 };
}

function logMeasures() {
  const entry = {};
  let any = false;
  MEASURE_FIELDS.forEach(([field]) => {
    const input = $(`[data-measure="${field}"]`);
    const value = Number(input ? input.value : 0);
    if (Number.isFinite(value) && value > 0) {
      entry[field] = Math.round(value * 10) / 10;
      any = true;
    }
  });
  if (!any) { toast('Enter at least one measurement.', 'danger'); return; }
  state.measures = state.measures || {};
  state.measures[todayKey()] = { ...(state.measures[todayKey()] || {}), ...entry };
  save();
  renderAll();
  toast('Measurements saved.', 'gold');
}

function measuresHtml() {
  const entries = measureEntries();
  const latest = entries.length ? entries[entries.length - 1] : {};
  const fields = MEASURE_FIELDS.map(([field, label]) => {
    const delta = measureDelta(field);
    const now = Number(latest[field]) || 0;
    return `
      <div class="stat">
        <div class="k">${label.replace(/ \(.*\)/, '')}</div>
        <div class="v">${now || '—'}${now ? ' <small>CM</small>' : ''}</div>
        ${delta ? `<div class="measure-delta">${delta.value > 0 ? '+' : ''}${delta.value}</div>` : ''}
      </div>`;
  }).join('');

  const inputs = MEASURE_FIELDS.map(([field, label]) => `
    <label class="field"><span class="lbl">${label}</span>
      <input type="number" min="0" max="300" step="0.5" inputmode="decimal" data-measure="${field}" value="${Number(latest[field]) || ''}" />
    </label>`).join('');

  return `
    <div class="section-head">
      <h2>BODY MEASUREMENTS</h2>
      <div class="line"></div>
      <span class="hint">${entries.length} measurement${entries.length === 1 ? '' : 's'}</span>
    </div>
    <div class="panel">
      <div class="stat-grid">${fields}</div>
      <p class="panel-sub" style="margin:12px 0;line-height:1.6">The scale alone hides recomposition. Log these once a week and watch the tape move while the weight stays flat.</p>
      <div class="form-grid three">${inputs}</div>
      <div class="modal-actions" style="margin-top:12px;justify-content:flex-start">
        <button class="btn primary" data-act="save-measures">SAVE MEASUREMENTS</button>
      </div>
    </div>`;
}

/* ---------------- adaptive targets ---------------- */

function targetsDue() {
  const meta = state.meta || {};
  const p = profileOf();
  if (!(p.weightKg > 0)) return false;
  if (!meta.calibratedAt) return true;
  const days = Math.round((parseKey(todayKey()) - parseKey(meta.calibratedAt)) / 86400000);
  const drift = Math.abs((Number(p.weightKg) || 0) - (Number(meta.calibratedKg) || 0));
  return days >= 14 || drift >= 2;
}

function recalibrateTargets() {
  const p = profileOf();
  if (!(p.weightKg > 0)) { toast('Set your height and weight first.', 'danger'); return; }
  applyProfileTargets();
  if (typeof maybeGenerateProgram === 'function' && targetsDue()) { /* no-op, kept for clarity */ }
  state.meta = {
    ...(state.meta || {}),
    calibratedAt: todayKey(),
    calibratedKg: p.weightKg
  };
  state.nutrition.manual = false;
  save();
  renderAll();
  toast(`Targets rebuilt for ${p.weightKg} kg: ${state.nutrition.kcal} kcal · ${state.nutrition.protein} g protein.`, 'gold');
}

function targetsHtml() {
  const p = profileOf();
  const trend = weightDelta(weightEntries());
  const due = targetsDue();
  const manual = !!(state.nutrition && state.nutrition.manual);
  const last = (state.meta && state.meta.calibratedAt) || '—';
  return `
    <div class="section-head">
      <h2>DAILY TARGETS</h2>
      <div class="line"></div>
      <span class="hint">${state.nutrition.kcal} kcal · ${state.nutrition.protein} g protein · ${(state.goals.water / 1000).toFixed(1)} L</span>
    </div>
    <div class="panel">
      <div class="stat-grid">
        <div class="stat"><div class="k">CALORIES</div><div class="v">${state.nutrition.kcal}</div></div>
        <div class="stat"><div class="k">PROTEIN</div><div class="v">${state.nutrition.protein} <small>G</small></div></div>
        <div class="stat"><div class="k">WATER</div><div class="v">${(state.goals.water / 1000).toFixed(1)} <small>L</small></div></div>
        <div class="stat"><div class="k">CALIBRATED</div><div class="v">${last === '—' ? '—' : 'NOW'}</div></div>
      </div>
      <p class="panel-sub" style="margin:12px 0;line-height:1.6">
        ${manual
          ? 'These targets are yours by hand, so a weigh-in no longer overwrites them. Recalibrate to follow your body again.'
          : `Derived from ${p.weightKg || '—'} kg and a ${p.goal === 'lose' ? 'fat-loss' : p.goal === 'gain' ? 'muscle-gain' : 'maintenance'} goal${trend ? `, with ${trend.kg > 0 ? '+' : ''}${trend.kg} kg over ${trend.days} days` : ''}.`}
        ${due ? ' Your body has moved since the last calibration — rebuild the numbers.' : ''}
      </p>
      <div class="modal-actions" style="margin-top:0;justify-content:flex-start">
        <button class="btn ${due ? 'primary' : ''}" data-act="recalibrate">RECALIBRATE TARGETS</button>
      </div>
    </div>`;
}

/* ---------------- weekly report ---------------- */

function weekReport() {
  const today = new Date();
  const start = addDays(today, -6);
  const startKey = keyOf(start);
  let sessions = 0;
  let planned = 0;
  let load = 0;
  let sets = 0;
  let waterDays = 0;
  let proteinDays = 0;
  let meals = 0;

  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const key = keyOf(date);
    const log = state.logs[key];
    const tplId = log ? (log.templateId || null) : (state.schedule[date.getDay()] || null);
    if (tplId) planned++;
    if (log && log.status === 'completed') sessions++;
    (log && log.exercises ? log.exercises : []).forEach((ex) => {
      const count = setsOf(ex).length || (Number(ex.sets) || 0);
      sets += count;
      const weight = Number(ex.weight) || 0;
      load += count * (Number(ex.reps) || 0) * weight;
    });
    if ((state.water[key] || 0) >= (state.goals.water || 2500)) waterDays++;
    const dayMeals = state.meals[key] || [];
    meals += dayMeals.length;
    const protein = dayMeals.reduce((n, m) => n + (Number(m.protein) || 0), 0);
    if (protein >= (state.nutrition.protein || 140)) proteinDays++;
  }

  const streak = computeStreak();
  const level = levelOf(state.xp);
  return {
    startKey,
    endKey: todayKey(),
    sessions,
    planned,
    load: Math.round(load),
    sets,
    waterDays,
    proteinDays,
    meals,
    streak,
    level,
    xp: state.xp
  };
}

function weekReportHtml() {
  const r = weekReport();
  const adherence = r.planned ? Math.round((r.sessions / r.planned) * 100) : 0;
  return `
    <div class="section-head">
      <h2>WEEKLY REPORT</h2>
      <div class="line"></div>
      <span class="hint">last 7 days</span>
    </div>
    <div class="panel">
      <div class="stat-grid">
        <div class="stat"><div class="k">SESSIONS</div><div class="v">${r.sessions} <small>/ ${r.planned}</small></div></div>
        <div class="stat"><div class="k">ADHERENCE</div><div class="v">${adherence}<small>%</small></div></div>
        <div class="stat"><div class="k">VOLUME</div><div class="v">${r.load.toLocaleString()} <small>KG</small></div></div>
        <div class="stat"><div class="k">SETS</div><div class="v">${r.sets}</div></div>
      </div>
      <ul class="coach" style="margin-top:14px">
        <li class="coach-note ${r.sessions >= r.planned && r.planned ? 'good' : 'go'}"><span class="coach-dot"></span><span>${r.sessions} of ${r.planned} planned sessions trained this week.</span></li>
        <li class="coach-note ${r.waterDays >= 5 ? 'good' : 'water'}"><span class="coach-dot"></span><span>Water goal hit on ${r.waterDays}/7 days.</span></li>
        <li class="coach-note ${r.proteinDays >= 4 ? 'good' : 'fuel'}"><span class="coach-dot"></span><span>Protein on target on ${r.proteinDays}/7 days · ${r.meals} meals logged.</span></li>
        <li class="coach-note overload"><span class="coach-dot"></span><span>${r.streak}-day streak · level ${r.level} · ${r.xp} XP.</span></li>
      </ul>
      <div class="modal-actions" style="margin-top:12px;justify-content:flex-start">
        <button class="btn primary" data-act="share-report">SHARE THIS WEEK</button>
      </div>
    </div>`;
}

/* Draws the report as a 1080×1350 card, then shares or downloads it. Text on
   a canvas is only reliable for the numbers, so the layout is deliberately
   blocky rather than clever. */
async function shareReportImage() {
  const r = weekReport();
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
  ctx.fillText('WEEKLY HUNTER REPORT', 96, 196);
  ctx.fillText(`${r.startKey} → ${r.endKey}`, 96, 234);

  ctx.fillStyle = '#dff2ff';
  ctx.font = '700 150px Orbitron, sans-serif';
  ctx.fillText(`LV ${r.level}`, 96, 430);
  ctx.font = '600 44px Rajdhani, sans-serif';
  ctx.fillStyle = '#5fe6ff';
  ctx.fillText(`RANK ${rankOf(r.level)} · ${r.streak}-DAY STREAK`, 96, 500);

  const rows = [
    ['SESSIONS', `${r.sessions} / ${r.planned}`],
    ['VOLUME', `${r.load.toLocaleString()} KG`],
    ['SETS', String(r.sets)],
    ['WATER GOAL', `${r.waterDays} / 7 DAYS`],
    ['PROTEIN GOAL', `${r.proteinDays} / 7 DAYS`],
    ['TOTAL XP', String(r.xp)]
  ];
  let y = 620;
  rows.forEach(([label, value]) => {
    ctx.fillStyle = 'rgba(95,230,255,.08)';
    ctx.fillRect(96, y - 50, 888, 96);
    ctx.fillStyle = '#8ea9c9';
    ctx.font = '500 30px Rajdhani, sans-serif';
    ctx.fillText(label, 128, y);
    ctx.fillStyle = '#dff2ff';
    ctx.font = '700 40px Orbitron, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value, 952, y + 2);
    ctx.textAlign = 'left';
    y += 112;
  });

  ctx.fillStyle = '#5fe6ff';
  ctx.font = '500 26px Rajdhani, sans-serif';
  ctx.fillText('THE SYSTEM · PERSONAL TRAINING INTERFACE', 96, 1220);

  const finish = async (blob) => {
    const file = blob && typeof File === 'function' ? new File([blob], `system-week-${r.endKey}.png`, { type: 'image/png' }) : null;
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'THE SYSTEM — weekly report', text: `Level ${r.level}, ${r.sessions}/${r.planned} sessions, ${r.streak}-day streak.` });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-week-${r.endKey}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Report card downloaded — post it anywhere.', 'gold');
  };

  if (canvas.toBlob) canvas.toBlob((blob) => { if (blob) finish(blob); }, 'image/png');
  else toast('This browser cannot export the card.', 'danger');
}

/* ---------------- program builder ---------------- */

const EQUIPMENT_OPTIONS = [
  ['gym', 'FULL GYM'],
  ['home', 'DUMBBELLS AT HOME'],
  ['bodyweight', 'BODYWEIGHT ONLY']
];

const EXPERIENCE_OPTIONS = [
  ['beginner', 'BEGINNER (0–6 MONTHS)'],
  ['intermediate', 'INTERMEDIATE (6–24 MONTHS)'],
  ['advanced', 'ADVANCED (2+ YEARS)']
];

const PROGRAM_LIBRARY = {
  gym: {
    'FULL BODY A': ['Back Squat', 'Bench Press', 'Barbell Row', 'Overhead Press', 'Face Pull'],
    'FULL BODY B': ['Deadlift', 'Lat Pulldown', 'Incline Dumbbell Press', 'Leg Curl', 'Lateral Raise'],
    'FULL BODY C': ['Leg Press', 'Overhead Press', 'Barbell Row', 'Romanian Deadlift', 'Barbell Curl'],
    'UPPER A': ['Bench Press', 'Barbell Row', 'Overhead Press', 'Lat Pulldown', 'Triceps Pushdown'],
    'UPPER B': ['Incline Dumbbell Press', 'Lat Pulldown', 'Lateral Raise', 'Barbell Curl', 'Face Pull'],
    'LOWER A': ['Back Squat', 'Romanian Deadlift', 'Leg Press', 'Leg Curl', 'Calf Raise'],
    'LOWER B': ['Deadlift', 'Back Squat', 'Leg Curl', 'Calf Raise', 'Face Pull'],
    PUSH: ['Bench Press', 'Overhead Press', 'Incline Dumbbell Press', 'Lateral Raise', 'Triceps Pushdown'],
    PULL: ['Deadlift', 'Lat Pulldown', 'Barbell Row', 'Face Pull', 'Barbell Curl'],
    LEGS: ['Back Squat', 'Romanian Deadlift', 'Leg Press', 'Leg Curl', 'Calf Raise']
  },
  home: {
    'FULL BODY A': ['Goblet Squat', 'Dumbbell Floor Press', 'Dumbbell Row', 'Dumbbell RDL', 'Plank'],
    'FULL BODY B': ['Dumbbell Split Squat', 'Dumbbell Overhead Press', 'Dumbbell Row', 'Glute Bridge', 'Dumbbell Curl'],
    'FULL BODY C': ['Goblet Squat', 'Dumbbell Floor Press', 'Dumbbell Lateral Raise', 'Dumbbell RDL', 'Hollow Hold'],
    UPPER: ['Dumbbell Floor Press', 'Dumbbell Row', 'Dumbbell Overhead Press', 'Dumbbell Curl', 'Dumbbell Lateral Raise'],
    LOWER: ['Goblet Squat', 'Dumbbell RDL', 'Dumbbell Split Squat', 'Glute Bridge', 'Plank']
  },
  bodyweight: {
    'FULL BODY A': ['Push-up', 'Bodyweight Squat', 'Inverted Row', 'Pike Push-up', 'Plank'],
    'FULL BODY B': ['Split Squat', 'Push-up', 'Glute Bridge', 'Inverted Row', 'Hollow Hold'],
    'FULL BODY C': ['Pike Push-up', 'Split Squat', 'Push-up', 'Wall Sit', 'Plank']
  }
};

/* Starting loads are deliberately light: a beginner should finish every rep
   and add weight next week, not fail on day one. Dumbbell numbers are per
   hand; bodyweight moves stay at 0. */
const START_LOADS = {
  'Back Squat': 30, 'Bench Press': 20, 'Deadlift': 40, 'Barbell Row': 25,
  'Overhead Press': 15, 'Lat Pulldown': 25, 'Leg Press': 50, 'Romanian Deadlift': 30,
  'Incline Dumbbell Press': 10, 'Lateral Raise': 5, 'Barbell Curl': 12.5,
  'Triceps Pushdown': 12.5, 'Face Pull': 10, 'Calf Raise': 25, 'Leg Curl': 20,
  'Goblet Squat': 10, 'Dumbbell Floor Press': 10, 'Dumbbell Row': 10,
  'Dumbbell RDL': 10, 'Dumbbell Overhead Press': 6, 'Dumbbell Split Squat': 8,
  'Dumbbell Curl': 6, 'Dumbbell Lateral Raise': 4, 'Glute Bridge': 0, 'Plank': 0,
  'Hollow Hold': 0, 'Push-up': 0, 'Bodyweight Squat': 0, 'Pike Push-up': 0,
  'Inverted Row': 0, 'Split Squat': 0, 'Wall Sit': 0
};

const SPLIT_BY_DAYS = {
  2: ['FULL BODY A', 'FULL BODY B'],
  3: ['FULL BODY A', 'FULL BODY B', 'FULL BODY C'],
  4: ['UPPER A', 'LOWER A', 'UPPER B', 'LOWER B'],
  5: ['PUSH', 'PULL', 'LEGS', 'UPPER A', 'LOWER A'],
  6: ['PUSH', 'PULL', 'LEGS', 'PUSH', 'PULL', 'LEGS']
};

const DOWS_BY_DAYS = {
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 5, 6],
  6: [1, 2, 3, 4, 5, 6]
};

function repsFor(experience, isCompound) {
  if (experience === 'advanced') return isCompound ? 6 : 12;
  if (experience === 'intermediate') return isCompound ? 8 : 12;
  return isCompound ? 10 : 12;
}

function setsFor(experience, isCompound, index) {
  if (experience === 'beginner') return isCompound && index < 2 ? 3 : 2;
  if (experience === 'intermediate') return isCompound ? 4 : 3;
  return isCompound ? 4 : 3;
}

function buildProgram(pref) {
  const equipment = PROGRAM_LIBRARY[pref.equipment] ? pref.equipment : 'gym';
  const experience = pref.experience || 'beginner';
  const days = Math.min(6, Math.max(2, Number(pref.days) || 3));
  const names = SPLIT_BY_DAYS[days];
  const available = PROGRAM_LIBRARY[equipment];

  // A 5-day split asks for PUSH/PULL/LEGS; the home and bodyweight libraries
  // do not have them, so fall back to their own rotation.
  const plan = names.map((name) => (available[name] ? name : Object.keys(available)[0])).slice(0, days);

  return plan.map((name, planIndex) => {
    const exercises = (available[name] || []).map((exName, i) => {
      const isCompound = i < 2;
      return {
        name: exName,
        sets: setsFor(experience, isCompound, i),
        reps: repsFor(experience, isCompound),
        weight: Number(START_LOADS[exName]) || 0
      };
    });
    return {
      id: `prog-${equipment}-${planIndex}`,
      name,
      focus: `${equipment === 'gym' ? 'Gym' : equipment === 'home' ? 'Home dumbbells' : 'Bodyweight'} · ${experience}`,
      exercises
    };
  });
}

/* Swaps the library and the weekly schedule for a starting program. Only runs
   on the first profile save, or when the hunter explicitly rebuilds it, so a
   hand-edited library is never silently replaced. */
function generateProgram(force) {
  const pref = (state.meta && state.meta.program) || {};
  const days = Math.min(6, Math.max(2, Number(pref.days) || 3));
  if (!force && state.meta && state.meta.programReady) return false;

  const templates = buildProgram({ ...pref, days });
  if (!templates.length) return false;

  state.templates = templates;
  const dows = DOWS_BY_DAYS[days] || DOWS_BY_DAYS[3];
  state.schedule = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
  dows.forEach((dow, i) => { state.schedule[dow] = templates[i % templates.length].id; });
  state.goals.weekly = days;

  // Today's plan follows the new schedule unless it is already cleared.
  const key = todayKey();
  const today = state.logs[key];
  if (today && today.status !== 'completed') delete state.logs[key];

  state.meta = { ...(state.meta || {}), programReady: true, program: { ...pref, days } };
  return true;
}

function maybeGenerateProgram() {
  return generateProgram(false);
}

function rebuildProgram() {
  const meta = state.meta || {};
  const pref = meta.program || {};
  const equipment = pref.equipment || 'gym';
  const experience = pref.experience || 'beginner';
  const days = Number(pref.days) || 3;
  const options = EQUIPMENT_OPTIONS.map(
    ([value, label]) => `<option value="${value}"${equipment === value ? ' selected' : ''}>${label}</option>`
  ).join('');
  const levels = EXPERIENCE_OPTIONS.map(
    ([value, label]) => `<option value="${value}"${experience === value ? ' selected' : ''}>${label}</option>`
  ).join('');

  openModal(`
    <h2>REBUILD PROGRAM</h2>
    <div class="sub">This replaces the workout library and the weekly schedule with a fresh split.</div>
    <label class="field"><span class="lbl">EQUIPMENT</span>
      <select data-program="equipment">${options}</select>
    </label>
    <label class="field"><span class="lbl">EXPERIENCE</span>
      <select data-program="experience">${levels}</select>
    </label>
    <label class="field"><span class="lbl">DAYS PER WEEK</span>
      <select data-program="days">
        ${[2, 3, 4, 5, 6].map((n) => `<option value="${n}"${Number(days) === n ? ' selected' : ''}>${n} days</option>`).join('')}
      </select>
    </label>
    <p class="panel-sub" style="margin:4px 0 0;line-height:1.6">Your logged history is untouched; only the plan for the days ahead changes.</p>
    <div class="modal-actions">
      <button class="btn primary" data-act="program-confirm">REBUILD</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

function confirmRebuildProgram() {
  const equipment = $('[data-program="equipment"]')?.value || 'gym';
  const experience = $('[data-program="experience"]')?.value || 'beginner';
  const days = Number($('[data-program="days"]')?.value) || 3;
  state.meta = { ...(state.meta || {}), program: { equipment, experience, days }, programReady: false };
  generateProgram(true);
  save();
  closeModal();
  renderAll();
  toast('Program rebuilt. The next quest follows the new split.', 'gold');
}

/* ---------------- removing a logged session ----------------
   A backfilled day can be wrong (wrong date, wrong workout), and it moved the
   streak, the quest map and the XP with it. Removing it reverses all three. */

function removeSession(key) {
  const log = state.logs[key];
  if (!log) return;
  if (!confirm(`Remove the session on ${shortDate(parseKey(key))}? Its XP is returned and the day stops counting.`)) return;
  revokeWorkoutXp(log);
  delete state.logs[key];
  if (state.meta && state.meta.startedAt === key) {
    const earliest = Object.keys(state.logs || {}).sort()[0];
    state.meta = { ...state.meta, startedAt: earliest || todayKey() };
  }
  save();
  renderAll();
  toast('Session removed. The day is no longer counted.');
}

/* ---------------- account removal ---------------- */

async function deleteAccount() {
  if (typeof auth === 'undefined' || !auth.user) {
    toast('Sign in first — a guest record has no account to delete.', 'danger');
    return;
  }
  const typed = window.prompt('This deletes the account and every record, on the server and in this browser. Type DELETE to confirm.');
  if (String(typed || '').trim().toUpperCase() !== 'DELETE') return;
  try {
    const res = await fetch('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' })
    });
    if (!res.ok) {
      toast('Deletion failed. Try again, or contact support.', 'danger');
      return;
    }
  } catch {
    toast('Could not reach the server. Nothing was deleted.', 'danger');
    return;
  }
  try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
  state = defaultState();
  save();
  closeModal();
  renderAll();
  toast('Account deleted. Everything is gone.', 'danger');
  setTimeout(() => { try { location.href = '/'; } catch (err) { /* ignore */ } }, 900);
}

/* ---------------- autoregulation ----------------
   A planned weight goes stale the moment the body adapts. These helpers turn
   the logged sets into an estimated one-rep max per session, then answer the
   three questions that matter in the gym: is it going up, has it stalled,
   and what should the next load be? */

function e1rmOf(set) {
  const weight = Number(set && set.weight) || 0;
  const reps = Number(set && set.reps) || 0;
  if (!(weight > 0) || !(reps > 0)) return 0;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

function e1rmSeries(name) {
  return exerciseSessions(name)
    .map((session) => ({
      key: session.key,
      e1rm: Math.max(0, ...session.sets.map(e1rmOf)),
      top: topOf(session.sets)
    }))
    .filter((point) => point.e1rm > 0);
}

function loadVerdict(name) {
  const series = e1rmSeries(name);
  if (!series.length) return { status: 'new', series, sessions: 0 };
  const best = Math.max(...series.map((point) => point.e1rm));
  const last = series[series.length - 1].e1rm;
  const previous = series.length > 1 ? series[series.length - 2].e1rm : 0;
  const recent = series.slice(-3);
  const flat = recent.length >= 3
    && Math.max(...recent.map((point) => point.e1rm)) <= Math.min(...recent.map((point) => point.e1rm)) * 1.02;

  if (series.length < 2) return { status: 'new', series, sessions: series.length, best, last };
  if (last > previous * 1.01) return { status: 'up', series, sessions: series.length, best, last };
  if (flat) return { status: 'stall', series, sessions: series.length, best, last, deload: deloadFor(best) };
  return { status: 'flat', series, sessions: series.length, best, last };
}

function deloadFor(e1rm) {
  const target = Math.max(BAR_KG, (e1rm / 1.15) * 0.9);
  return Math.round(target / 2.5) * 2.5;
}

function liftNames() {
  const names = [];
  (state.templates || []).forEach((template) => {
    const first = (template.exercises || [])[0];
    if (first && first.name && names.indexOf(first.name) < 0) names.push(first.name);
  });
  return names.slice(0, 4);
}

function loadCheckHtml() {
  const rows = liftNames()
    .map((name) => ({ name, verdict: loadVerdict(name) }))
    .filter((row) => row.verdict.sessions > 0);
  if (!rows.length) return '';

  const lines = rows.map(({ name, verdict }) => {
    const est = verdict.last ? `${verdict.last} kg e1RM` : 'no estimate yet';
    const advice = verdict.status === 'up'
      ? `ADD ${OVERLOAD_STEP} KG`
      : verdict.status === 'stall'
        ? `DELOAD TO ${verdict.deload} KG`
        : verdict.status === 'new'
          ? 'LOG ONE MORE SESSION'
          : `HOLD ${verdict.best} KG UNTIL REPS CLIMB`;
    const tone = verdict.status === 'up' ? 'is-good' : verdict.status === 'stall' ? 'is-warn' : '';
    const change = typeof liftChangePct === 'function' ? liftChangePct(verdict.series, 4) : null;
    const path = typeof sparklinePath === 'function'
      ? sparklinePath(verdict.series.map((point) => point.e1rm), 120, 30)
      : '';
    const changeTone = change == null ? '' : change > 0 ? 'is-good' : change < 0 ? 'is-warn' : '';
    const trend = change == null ? '' : `<span class="lift-change ${changeTone}">${change > 0 ? '+' : ''}${change}% in ${Math.min(verdict.series.length - 1, 4)} sessions</span>`;
    return `<li class="load-row">
      <span class="load-name">${esc(name)}</span>
      <span class="load-est">${esc(est)} · ${verdict.sessions} session${verdict.sessions === 1 ? '' : 's'}</span>
      <em class="load-advice ${tone}">${advice}</em>
      ${path ? `<div class="lift-bars"><svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" /></svg>${trend}</div>` : ''}
    </li>`;
  }).join('');

  const prs = typeof recentPrs === 'function' ? recentPrs(5) : [];
  const prRows = prs.map((pr) => `<li class="set-row">
      <span class="set-no">${esc(shortDate(parseKey(pr.key)))}</span>
      <span class="set-val">${esc(pr.name)} · ${pr.weight} kg × ${pr.reps}</span>
      <span class="swap-tag">${pr.gain > 0 ? `+${pr.gain} KG` : 'FIRST'}</span>
    </li>`).join('');

  return `
    <div class="section-head">
      <h2>LOAD CHECK</h2>
      <div class="line"></div>
      <span class="hint">estimated 1RM over time</span>
    </div>
    <div class="panel"><ul class="load-list">${lines}</ul>
      <p class="panel-sub" style="margin:10px 0 0;line-height:1.6">Each line is the best estimated 1RM of that lift per session (Epley). A rising line with flat bodyweight is the whole game — and three flat sessions in a row earn a deload, not more willpower.</p>
      ${prRows ? `<div class="section-head" style="margin:16px 0 8px"><h2 style="font-size:10px">RECORD TIMELINE</h2><div class="line"></div><span class="hint">newest first</span></div><ul class="set-list">${prRows}</ul>` : ''}
    </div>`;
}

/* ---------------- plate & warm-up maths ---------------- */

const BAR_KG = 20;
const PLATE_SET = [25, 20, 15, 10, 5, 2.5, 1.25];

function platesPerSide(target, bar = BAR_KG, plates = PLATE_SET) {
  let left = (Number(target) || 0) - bar;
  if (!(left > 0)) return { perSide: [], leftover: Math.round(Math.max(0, left) * 100) / 100, under: (Number(target) || 0) < bar };
  left /= 2;
  const perSide = [];
  plates.forEach((plate) => {
    while (left >= plate - 0.001) {
      perSide.push(plate);
      left -= plate;
    }
  });
  return { perSide, leftover: Math.round(left * 100) / 100, under: false };
}

function plateLine(target) {
  const { perSide, leftover, under } = platesPerSide(target);
  if (under) return `BAR ${BAR_KG} KG · below bar weight`;
  const load = perSide.length ? perSide.join(' + ') : 'bar only';
  const tail = leftover > 0.01 ? ` · ${leftover} kg short` : '';
  return `BAR ${BAR_KG} KG + ${load} per side${tail}`;
}

function warmupLadder(top) {
  const target = Number(top) || 0;
  if (!(target > BAR_KG)) return [];
  return [0.4, 0.6, 0.8].map((pct, i) => ({
    weight: Math.max(BAR_KG, Math.round((target * pct) / 2.5) * 2.5),
    reps: [8, 5, 3][i]
  })).filter((step, i, all) => i === 0 || step.weight > all[i - 1].weight);
}

function warmupHtml(top) {
  const ladder = warmupLadder(top);
  if (!ladder.length) return '';
  return `<p class="plate-warmup">WARM UP: ${ladder.map((step) => `${step.weight} × ${step.reps}`).join(' → ')}</p>`;
}

/* ---------------- sharing a program ----------------
   A split is the thing lifters actually ask each other for. The payload rides
   in the URL fragment, so there is no server work and nothing to delete. */

function encodeProgramCode(payload) {
  const json = JSON.stringify(payload);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeProgramCode(code) {
  const raw = String(code || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + (raw.length % 4 ? '='.repeat(4 - (raw.length % 4)) : '');
  return JSON.parse(decodeURIComponent(escape(atob(padded))));
}

function programPayload() {
  return {
    app: 'system-fitness',
    kind: 'program',
    version: 1,
    templates: state.templates,
    schedule: state.schedule,
    weekly: state.goals.weekly
  };
}

function programShareLink() {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#program=${encodeProgramCode(programPayload())}`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    /* fall through to the prompt */
  }
  window.prompt('Copy this link:', text);
  return false;
}

async function shareProgram() {
  const copied = await copyText(programShareLink());
  toast(copied ? 'Program link copied. Send it to anyone.' : 'Program link ready.', 'gold');
}

function importProgramCode(code) {
  let payload;
  try {
    payload = decodeProgramCode(code);
  } catch (err) {
    toast('That program link is not readable.', 'danger');
    return false;
  }
  if (!payload || payload.kind !== 'program' || !Array.isArray(payload.templates) || !payload.templates.length) {
    toast('That is not a System program link.', 'danger');
    return false;
  }
  const templates = payload.templates
    .filter((tpl) => tpl && typeof tpl.name === 'string' && Array.isArray(tpl.exercises))
    .map((tpl, i) => ({
      id: `shared-${i}`,
      name: String(tpl.name).slice(0, 40),
      focus: String(tpl.focus || 'shared program').slice(0, 80),
      exercises: tpl.exercises
        .filter((ex) => ex && typeof ex.name === 'string')
        .slice(0, 10)
        .map((ex) => ({
          name: String(ex.name).slice(0, 60),
          sets: clampNum(ex.sets, 1, 10, 3),
          reps: clampNum(ex.reps, 1, 50, 10),
          weight: clampNum(ex.weight, 0, 500, 0)
        }))
    }));
  if (!templates.length) { toast('That program has no usable workouts.', 'danger'); return false; }
  if (!confirm(`Replace your ${state.templates.length} workouts with these ${templates.length}? History is kept.`)) return false;

  state.templates = templates;
  state.schedule = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
  const dows = DOWS_BY_DAYS[Math.min(6, Math.max(2, templates.length))] || [1, 3, 5];
  dows.forEach((dow, i) => { state.schedule[dow] = templates[i % templates.length].id; });
  state.goals.weekly = clampNum(payload.weekly, 1, 14, templates.length);
  state.meta = { ...(state.meta || {}), programReady: true };
  save();
  renderAll();
  toast('Shared program loaded. Your history is untouched.', 'gold');
  return true;
}

function openProgramImport() {
  openModal(`
    <h2>IMPORT PROGRAM</h2>
    <div class="sub">Paste a program link or code someone shared with you.</div>
    <label class="field"><span class="lbl">LINK OR CODE</span>
      <textarea rows="3" data-program-incoming placeholder="https://…/#program=…"></textarea>
    </label>
    <div class="modal-actions">
      <button class="btn primary" data-act="program-import-save">IMPORT</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

function saveProgramImport() {
  const raw = String($('[data-program-incoming]')?.value || '').trim();
  const match = raw.match(/program=([A-Za-z0-9_-]+)/);
  if (importProgramCode(match ? match[1] : raw)) closeModal();
}

function importProgramFromHash() {
  const match = String(location.hash || '').match(/program=([A-Za-z0-9_-]+)/);
  if (!match) return;
  history.replaceState(null, '', location.pathname);
  importProgramCode(match[1]);
}

/* ---------------- paint ---------------- */

/* The views are rendered by app.js and nutrition.js; this adds its own blocks
   after them so neither file has to know about the training engine. */
function renderTrainingExtras() {
  const today = document.getElementById('view-today');
  if (today && !today.querySelector('.live-card')) {
    const quest = today.querySelector('.quest');
    const card = document.createElement('div');
    card.className = 'live-card panel';
    card.innerHTML = `
      <div class="panel-head">
        <div class="panel-title">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/></svg>
          LIVE SESSION
        </div>
        <div class="spacer"></div>
        <span class="panel-sub">${restSeconds()}s rest</span>
      </div>
      <p class="panel-sub" style="margin:8px 0 0;line-height:1.6">One exercise at a time, a tap per set and a rest timer between them. Every set is recorded, so records and next-load suggestions build up.</p>
      ${state.live && state.logs[state.live.key]
        ? `<p class="panel-sub" style="margin:8px 0 0;line-height:1.6">A session started ${esc(agoLabel(state.live.key))} is still open — pick it up where you left off.</p>`
        : ''}
      <div class="modal-actions" style="margin-top:12px;justify-content:flex-start">
        ${state.live && state.logs[state.live.key] ? '<button class="btn primary" data-act="live-resume">RESUME SESSION</button>' : ''}
        <button class="btn${state.live && state.logs[state.live.key] ? ' ghost' : ' primary'}" data-act="live-start" data-key="${todayKey()}">${ensureLog(todayKey()).exercises.length ? 'START SESSION' : 'PICK A WORKOUT FIRST'}</button>
      </div>`;
    if (quest && quest.parentNode) quest.parentNode.insertBefore(card, quest.nextSibling);
    else today.insertBefore(card, today.firstChild);
  }

  const progress = document.getElementById('view-progress');
  if (progress) {
    progress.querySelectorAll('[data-training-block]').forEach((el) => el.remove());
    const wrap = document.createElement('div');
    wrap.setAttribute('data-training-block', '1');
    wrap.innerHTML = `${loadCheckHtml()}${targetsHtml()}${measuresHtml()}${weekReportHtml()}
      <div class="section-head">
        <h2>PROGRAM</h2>
        <div class="line"></div>
        <span class="hint">${state.templates.length} workouts · ${state.goals.weekly} days a week</span>
      </div>
      <div class="panel">
        <p class="panel-sub" style="margin:0;line-height:1.6">Rebuild the split when your equipment, experience or available days change. The library and schedule are replaced; history is kept.</p>
        <div class="modal-actions" style="margin-top:12px;justify-content:flex-start">
          <button class="btn" data-act="rebuild-program">REBUILD PROGRAM</button>
          <button class="btn ghost" data-act="program-share">SHARE PROGRAM</button>
          <button class="btn ghost" data-act="program-import">IMPORT PROGRAM</button>
        </div>
      </div>`;
    progress.appendChild(wrap);
  }
}

/* ---------------- events ---------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const key = el.dataset.key;
  const index = el.dataset.i !== undefined ? Number(el.dataset.i) : null;

  if (act === 'session-del') removeSession(key);
  else if (act === 'sets-open') openSetLogger(key, index);
  else if (act === 'set-add') addSet(key, index);
  else if (act === 'set-rm') removeSet(key, index, Number(el.dataset.s));
  else   if (act === 'live-start') startLiveSession(todayKey());
  else if (act === 'live-resume') resumeLiveSession();
  else if (act === 'live-set') liveLogSet(key);
  else if (act === 'live-next') liveMove(1);
  else if (act === 'live-prev') liveMove(-1);
  else if (act === 'live-end') endLiveSession();
  else if (act === 'save-measures') logMeasures();
  else if (act === 'recalibrate') recalibrateTargets();
  else if (act === 'share-report') shareReportImage();
  else if (act === 'rebuild-program') rebuildProgram();
  else if (act === 'program-confirm') confirmRebuildProgram();
  else if (act === 'delete-account') deleteAccount();
  else if (act === 'program-share') shareProgram();
  else if (act === 'program-import') openProgramImport();
  else if (act === 'program-import-save') saveProgramImport();
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  if (el.dataset.change === 'set-weight') {
    const line = document.querySelector('.plate-line');
    if (line) line.textContent = plateLine(Number(el.value) || 0);
    return;
  }
  if (el.dataset.change === 'rest-sec') {
    state.meta = { ...(state.meta || {}), restSec: Number(el.value) || 90 };
    save();
    if (liveSession) renderLiveSession();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && liveSession) { e.stopPropagation(); endLiveSession(); }
}, true);

/* A session left open while the phone is put away should not keep a timer
   running forever; closing the tab ends it naturally. */
window.addEventListener('beforeunload', () => {
  if (liveSession) clearInterval(liveSession.timer);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && liveSession) requestWakeLock();
});

renderAll = (() => {
  const base = renderAll;
  return function renderAllWithTraining() {
    base();
    try { renderTrainingExtras(); } catch (err) { console.error('[training] extras failed', err); }
  };
})();

/* A session started in the last few hours is resumed automatically; an older
   one is stale and is cleared so it never blocks a new session. */
function maybeRestoreLive() {
  const saved = state.live;
  if (!saved || !saved.key) return;
  const fresh = Date.now() - (Number(saved.startedAt) || 0) < 6 * 3600 * 1000;
  if (saved.key === todayKey() && fresh && state.logs[saved.key]) resumeLiveSession();
  else { state.live = null; save(); }
}

setTimeout(() => {
  try { maybeRestoreLive(); } catch (err) { console.error('[training] resume failed', err); }
}, 700);
setTimeout(() => {
  try { importProgramFromHash(); } catch (err) { console.error('[training] import failed', err); }
}, 900);

// Paint the extras once the shell exists (and never during a headless test).
if (typeof document !== 'undefined' && document.getElementById('view-today')) renderAll();
