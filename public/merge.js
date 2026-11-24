'use strict';

/* ======================================================================
   Record merge
   ----------------------------------------------------------------------
   Two devices can both log a workout offline. The old rule adopted whichever
   copy had the later timestamp, which silently deleted the other device's
   sets. This module keeps both: the newer copy wins for scalars, while the
   additive collections (days, sets, entries) are unioned.

   Loaded after app.js so normalizeState is available; sync.js and the tests
   both call mergeStates().
   ====================================================================== */

function mergeSetList(a, b) {
  const out = Array.isArray(a) ? a.map((set) => ({ ...set })) : [];
  const seen = new Set(out.map((set) => `${Number(set.weight) || 0}x${Number(set.reps) || 0}`));
  (Array.isArray(b) ? b : []).forEach((set) => {
    if (!set || typeof set !== 'object') return;
    const sig = `${Number(set.weight) || 0}x${Number(set.reps) || 0}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ ...set });
  });
  return out;
}

function mergeExerciseList(baseList, otherList) {
  const byName = new Map();
  (Array.isArray(baseList) ? baseList : []).forEach((ex) => {
    if (!ex || !ex.name) return;
    byName.set(String(ex.name).toLowerCase(), { ...ex });
  });
  (Array.isArray(otherList) ? otherList : []).forEach((ex) => {
    if (!ex || !ex.name) return;
    const key = String(ex.name).toLowerCase();
    const current = byName.get(key);
    if (!current) {
      byName.set(key, { ...ex });
      return;
    }
    current.log = mergeSetList(current.log, ex.log);
    current.done = !!(current.done || ex.done);
    current.weight = Number(current.weight) || Number(ex.weight) || 0;
    current.reps = Number(current.reps) || Number(ex.reps) || 0;
    current.sets = Math.max(Number(current.sets) || 0, Number(ex.sets) || 0);
  });
  return Array.from(byName.values());
}

function mergeLogDay(baseDay, otherDay) {
  const a = baseDay && typeof baseDay === 'object' ? baseDay : {};
  const b = otherDay && typeof otherDay === 'object' ? otherDay : {};
  return {
    ...b,
    ...a,
    status: a.status === 'completed' || b.status === 'completed' ? 'completed' : (a.status || b.status || 'pending'),
    templateId: a.templateId || b.templateId || null,
    exercises: mergeExerciseList(a.exercises, b.exercises)
  };
}

function mergeLogs(baseLogs, otherLogs) {
  const out = { ...(otherLogs || {}) };
  Object.keys(baseLogs || {}).forEach((key) => {
    out[key] = out[key] ? mergeLogDay(baseLogs[key], out[key]) : baseLogs[key];
  });
  return out;
}

/* Water is a running total, so the larger number is the one that saw more
   glasses; everything else that is a per-day map keeps the newer copy. */
function mergeWater(baseWater, otherWater) {
  const out = { ...(otherWater || {}) };
  Object.keys(baseWater || {}).forEach((key) => {
    out[key] = Math.max(Number(out[key]) || 0, Number(baseWater[key]) || 0);
  });
  return out;
}

function mergeKeys(baseMap, otherMap) {
  return { ...(otherMap || {}), ...(baseMap || {}) };
}

/*
  local + remote -> one record. Either order gives the same collections, and
  the copy with the later meta.updatedAt wins every scalar field.
*/
function mergeStates(local, remote) {
  const a = normalizeState(local);
  const b = normalizeState(remote);
  const aAt = Number((a.meta || {}).updatedAt) || 0;
  const bAt = Number((b.meta || {}).updatedAt) || 0;
  const base = aAt >= bAt ? a : b; // newer
  const other = aAt >= bAt ? b : a; // older

  const started = [a.meta && a.meta.startedAt, b.meta && b.meta.startedAt]
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')))
    .sort()[0];

  return {
    ...base,
    xp: Math.max(Number(a.xp) || 0, Number(b.xp) || 0),
    logs: mergeLogs(base.logs, other.logs),
    water: mergeWater(base.water, other.water),
    waterBonus: mergeKeys(base.waterBonus, other.waterBonus),
    readiness: mergeKeys(base.readiness, other.readiness),
    constraints: {
      avoid: Array.from(new Set([...((base.constraints || {}).avoid || []), ...((other.constraints || {}).avoid || [])])),
      swaps: mergeKeys((base.constraints || {}).swaps, (other.constraints || {}).swaps)
    },
    weights: mergeKeys(base.weights, other.weights),
    measures: mergeKeys(base.measures, other.measures),
    meals: mergeKeys(base.meals, other.meals),
    pantry: Array.from(new Set([...(base.pantry || []), ...(other.pantry || [])])).filter((item) => typeof item === 'string'),
    achievements: { unlocked: { ...((other.achievements || {}).unlocked || {}), ...((base.achievements || {}).unlocked || {}) } },
    bonus: { claimed: { ...((other.bonus || {}).claimed || {}), ...((base.bonus || {}).claimed || {}) } },
    meta: {
      ...base.meta,
      updatedAt: Date.now(),
      startedAt: started || base.meta.startedAt || ''
    }
  };
}
