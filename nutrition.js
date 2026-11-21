'use strict';

/* ======================================================================
   Workout history · Kerala nutrition engine · trainer notes
   Loaded after app.js; shares the same state and render helpers.
   ====================================================================== */

let historyFilter = 'all';

/* ---------------- data helpers ---------------- */

function mealsFor(key) { return state.meals[key] || []; }

function sumMeals(meals) {
  return meals.reduce((acc, m) => ({
    kcal: acc.kcal + (Number(m.kcal) || 0),
    protein: acc.protein + (Number(m.protein) || 0)
  }), { kcal: 0, protein: 0 });
}

function pantryHas(name) { return (state.pantry || []).includes(name); }

function mealNow() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

function suggestFoods(limit) {
  const pantry = new Set(state.pantry || []);
  const totals = sumMeals(mealsFor(todayKey()));
  const proteinLeft = Math.max(0, state.nutrition.protein - totals.protein);
  const kcalLeft = Math.max(0, state.nutrition.kcal - totals.kcal);
  const now = mealNow();
  const scored = FOOD_DB.map((f) => {
    const missing = f.ingredients.filter((i) => !pantry.has(i));
    const have = f.ingredients.filter((i) => pantry.has(i));
    const coverage = f.ingredients.length ? have.length / f.ingredients.length : 1;
    let score = coverage * 100 - missing.length * 22;
    if (f.meals.indexOf(now) >= 0) score += 25;
    if (proteinLeft > 30) score += Math.min(f.protein, proteinLeft) * 1.1;
    else score += Math.min(f.kcal, Math.max(kcalLeft, 0)) * 0.02;
    return { ...f, missing, have, coverage, score };
  });
  const tolerance = pantry.size > 4 ? 2 : 4;
  const usable = scored.filter((f) => f.missing.length <= tolerance);
  usable.sort((a, b) => b.score - a.score);
  return usable.slice(0, limit || 6);
}

/* ---------------- history ---------------- */

function renderHistory() {
  const entries = Object.entries(state.logs)
    .filter(([, l]) => l && (l.status === 'completed' || l.status === 'skipped' || (l.exercises && l.exercises.length)))
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));

  /* Compare date keys, not Date objects: keyOf() stamps YYYY-MM-DD and parsing
     back gives midnight, so a Date comparison silently dropped the 6th day. */
  const weekAgoKey = keyOf(addDays(new Date(), -6));
  const filtered = entries.filter(([k, l]) => {
    if (historyFilter === 'done') return l.status === 'completed';
    if (historyFilter === 'skip') return l.status === 'skipped';
    if (historyFilter === 'week') return k >= weekAgoKey;
    return true;
  });

  let totalLoad = 0;
  let totalSets = 0;
  entries.forEach(([, l]) => {
    (l.exercises || []).forEach((e) => {
      const sets = Number(e.sets) || 0;
      totalSets += sets;
      totalLoad += sets * (Number(e.reps) || 0) * (Number(e.weight) || 0);
    });
  });

  const sessions = filtered.map(([k, l]) => {
    const d = parseKey(k);
    const tpl = state.templates.find((t) => t.id === l.templateId);
    const name = tpl ? tpl.name : 'AD-HOC SESSION';
    const tag = l.status === 'completed' ? 'cleared' : l.status === 'skipped' ? 'skipped' : 'pending';
    const tagClass = tag === 'cleared' ? 'done' : tag === 'skipped' ? 'skip' : '';
    const load = (l.exercises || []).reduce((a, e) => a + (Number(e.sets) || 0) * (Number(e.reps) || 0) * (Number(e.weight) || 0), 0);
    const rows = (l.exercises || []).map((e, i) => `
      <li class="ex ${e.done ? 'is-done' : ''}">
        <div class="ex-body">
          <span class="ex-name">${esc(e.name)}</span>
          <span class="ex-meta">${e.sets} × ${e.reps}${Number(e.weight) > 0 ? ` · ${e.weight} kg` : ' · bodyweight'}</span>
        </div>
        <button class="icon-btn sm" data-act="edit-ex" data-key="${k}" data-i="${i}" aria-label="Edit ${esc(e.name)}">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 6l4 4" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
      </li>`).join('');

    return `
      <article class="session">
        <div class="session-head">
          <div>
            <div class="session-date">${shortDate(d)}</div>
            <div class="session-name">${esc(name)}</div>
          </div>
          <span class="quest-tag ${tagClass}">${tag.toUpperCase()}</span>
        </div>
        <ul class="ex-list compact">
          ${rows || '<li class="ex"><div class="ex-body"><span class="ex-meta">No exercises recorded for this day.</span></div></li>'}
        </ul>
        <div class="session-foot">LOAD ${Math.round(load).toLocaleString()} KG · ${(l.exercises || []).length} MOVES</div>
      </article>`;
  }).join('');

  const filters = [['all', 'ALL SESSIONS'], ['done', 'CLEARED'], ['skip', 'SKIPPED'], ['week', 'LAST 7 DAYS']]
    .map(([id, label]) => `<button class="chip ${historyFilter === id ? 'on' : ''}" data-act="history-filter" data-filter="${id}">${label}</button>`)
    .join('');

  $('#view-history').innerHTML = `
    <div class="section-head">
      <h2>WORKOUT HISTORY</h2>
      <div class="line"></div>
      <span class="hint">${entries.length} session${entries.length === 1 ? '' : 's'} logged</span>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="k">SESSIONS</div><div class="v">${entries.length}</div></div>
      <div class="stat"><div class="k">TOTAL LOAD</div><div class="v">${Math.round(totalLoad).toLocaleString()} <small>KG</small></div></div>
      <div class="stat"><div class="k">SETS LOGGED</div><div class="v">${totalSets}</div></div>
      <div class="stat"><div class="k">THIS WEEK</div><div class="v">${completedThisWeek()} <small>/ ${state.goals.weekly}</small></div></div>
    </div>

    <div class="section-head" style="margin-top:22px">
      <h2>SESSION LOG</h2>
      <div class="line"></div>
      <span class="hint">tap the pencil to correct a weight</span>
    </div>

    <div class="filters">${filters}</div>
    <div class="sessions">
      ${sessions || '<div class="empty">No sessions logged yet. Clear today\'s quest and it will appear here with every exercise and weight.</div>'}
    </div>
  `;
}

/* ---------------- nutrition ---------------- */

function renderNutrition() {
  const key = todayKey();
  const meals = mealsFor(key);
  const totals = sumMeals(meals);
  const g = state.nutrition;
  const kPct = Math.min(1, totals.kcal / g.kcal);
  const pPct = Math.min(1, totals.protein / g.protein);
  const suggestions = suggestFoods(6);
  const pantryCount = (state.pantry || []).length;

  const mealRows = meals.map((m) => `
    <li class="meal">
      <div class="meal-main">
        <span class="meal-name">${esc(m.name)}</span>
        <span class="meal-meta">${Math.round(m.kcal)} kcal · ${Math.round(m.protein)} g protein</span>
      </div>
      <button class="icon-btn sm" data-act="del-meal" data-id="${m.id}" aria-label="Remove meal">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M10 7V5h4v2M8 7l1 13h6l1-13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </li>`).join('');

  const pantryHtml = INGREDIENT_GROUPS.map((grp) => `
    <div class="pantry-group">
      <span class="lbl">${esc(grp.name)}</span>
      <div class="chips">
        ${grp.items.map((it) => `<button class="chip ${pantryHas(it) ? 'on' : ''}" data-act="toggle-pantry" data-item="${esc(it)}">${esc(it)}</button>`).join('')}
      </div>
    </div>`).join('');

  const suggestHtml = suggestions.length
    ? suggestions.map((f) => `
      <article class="food-card">
        <div class="food-head">
          <h3>${esc(f.name)}</h3>
          <span class="food-meal">${esc((f.meals[0] || '').toUpperCase())}</span>
        </div>
        <div class="food-macros"><b>${f.kcal}</b> kcal · <b>${f.protein} g</b> protein</div>
        <div class="food-ings">
          ${f.ingredients.map((i) => `<span class="ing ${f.missing.indexOf(i) >= 0 ? 'missing' : ''}">${esc(i)}</span>`).join('')}
        </div>
        ${f.missing.length ? `<div class="panel-sub" style="font-size:12px">Missing: ${esc(f.missing.join(', '))}</div>` : '<div class="panel-sub" style="font-size:12px;color:var(--green)">Everything you need is in your pantry</div>'}
        <button class="btn block" data-act="log-dish" data-id="${f.id}">LOG THIS MEAL</button>
      </article>`).join('')
    : '<div class="empty">Tick a few pantry ingredients and the System will surface Kerala dishes you can actually cook today.</div>';

  const quickHtml = QUICK_FOODS.map((q) => `
    <button class="chip" data-act="quick-log" data-name="${esc(q.name)}" data-kcal="${q.kcal}" data-protein="${q.protein}">
      ${esc(q.name)} · ${q.kcal} kcal
    </button>`).join('');

  $('#view-nutrition').innerHTML = `
    <div class="section-head">
      <h2>FUEL TODAY</h2>
      <div class="line"></div>
      <button class="btn" data-act="open-meal">+ LOG MEAL</button>
    </div>

    <div class="panel">
      <div class="meter">
        <div class="meter-head"><span>CALORIES</span><span>${Math.round(totals.kcal)} / ${g.kcal} KCAL</span></div>
        <div class="meter-bar"><span style="width:${kPct * 100}%"></span></div>
      </div>
      <div class="meter">
        <div class="meter-head"><span>PROTEIN</span><span>${Math.round(totals.protein)} / ${g.protein} G</span></div>
        <div class="meter-bar protein"><span style="width:${pPct * 100}%"></span></div>
      </div>
      ${meals.length ? `<ul class="meal-list">${mealRows}</ul>` : '<div class="empty" style="margin-top:16px">Nothing logged yet. Add your first meal to start the fuel record.</div>'}
      <div class="meal-total">${Math.max(0, g.kcal - totals.kcal)} kcal · ${Math.max(0, g.protein - totals.protein)} g protein remaining</div>
    </div>

    <div class="section-head">
      <h2>QUICK ADD</h2>
      <div class="line"></div>
      <span class="hint">one tap</span>
    </div>
    <div class="panel"><div class="chips">${quickHtml}</div></div>

    <div class="section-head">
      <h2>PANTRY</h2>
      <div class="line"></div>
      <span class="hint">${pantryCount} ingredients</span>
    </div>
    <div class="panel">
      <p class="panel-sub" style="margin:0 0 14px">Tap everything you have at home. Suggestions only use what is here.</p>
      ${pantryHtml}
      <button class="btn ghost" data-act="pantry-clear" style="margin-top:16px">CLEAR PANTRY</button>
    </div>

    <div class="section-head">
      <h2>WHAT TO COOK</h2>
      <div class="line"></div>
      <span class="hint">Kerala kitchen · ${mealNow()}</span>
    </div>
    <div class="panel"><div class="food-grid">${suggestHtml}</div></div>

    <div class="section-head">
      <h2>TRAINER NOTES</h2>
      <div class="line"></div>
      <span class="hint">based on your data</span>
    </div>
    <div class="panel">${coachNotesHtml()}</div>
  `;
}

/* ---------------- trainer ---------------- */

function coachNotes() {
  const notes = [];
  const key = todayKey();
  const p = planFor(key);
  const st = dayState(key);
  const week = completedThisWeek();
  const goal = state.goals.weekly;
  const totals = sumMeals(mealsFor(key));
  const g = state.nutrition;
  const water = state.water[key] || 0;

  if (st === 'done') {
    notes.push({ tone: 'good', text: 'Today\'s quest is cleared. Get 20–30 g protein in within the next couple of hours to start recovery.' });
  } else if (p.template && p.exercises.length) {
    const first = p.exercises[0];
    notes.push({ tone: 'go', text: `${p.template.name} is active. Open with ${first.name} — ${first.sets}×${first.reps}${Number(first.weight) > 0 ? ` at ${first.weight} kg` : ''}.` });
  } else {
    notes.push({ tone: 'rest', text: 'Rest day. A 20-minute walk and light stretching keeps recovery moving without adding fatigue.' });
  }

  if (week < goal) {
    notes.push({ tone: 'go', text: `You are ${goal - week} session${goal - week === 1 ? '' : 's'} short of this week's target. Put the next one on the calendar now.` });
  } else {
    notes.push({ tone: 'good', text: `Weekly target met: ${week}/${goal} sessions. Anything more is bonus XP.` });
  }

  const proteinLeft = Math.max(0, g.protein - totals.protein);
  if (proteinLeft > 20) {
    const pick = suggestFoods(1)[0];
    if (pick) {
      notes.push({ tone: 'fuel', text: `Protein is ${Math.round(proteinLeft)} g short. ${pick.name} adds ${pick.protein} g and ${pick.kcal} kcal from what you have.` });
    } else {
      notes.push({ tone: 'fuel', text: `Protein is ${Math.round(proteinLeft)} g short. Add eggs, curd, fish or dal to your pantry for a suggestion.` });
    }
  } else if (totals.protein > 0) {
    notes.push({ tone: 'good', text: 'Protein is on schedule today. Keep meals steady rather than one heavy late meal.' });
  }

  if (water < state.goals.water) {
    notes.push({ tone: 'water', text: `${state.goals.water - water} ml water left today. Sip between sets instead of all at once.` });
  }

  const skipped = Object.keys(state.logs).filter((k) => state.logs[k].status === 'skipped').length;
  if (skipped >= 2) {
    notes.push({ tone: 'warn', text: `${skipped} skipped days on record. Shrink tomorrow's session instead of skipping again — 3 moves, 25 minutes, done.` });
  }

  const lastCompleted = Object.keys(state.logs).filter((k) => state.logs[k].status === 'completed').sort().pop();
  if (lastCompleted) {
    const log = state.logs[lastCompleted];
    const heavy = (log.exercises || [])
      .filter((e) => Number(e.weight) > 0)
      .sort((a, b) => Number(b.weight) - Number(a.weight))[0];
    if (heavy) {
      notes.push({ tone: 'overload', text: `Progressive overload: next session take ${heavy.name} from ${heavy.weight} kg to ${Number(heavy.weight) + 2.5} kg.` });
    }
  } else {
    notes.push({ tone: 'warn', text: 'No completed sessions yet. Clear one quest today and the System starts tracking your trajectory.' });
  }

  return notes.slice(0, 6);
}

function coachNotesHtml(limit) {
  return `<ul class="coach">${coachNotes().slice(0, limit || 6).map((n) => `
    <li class="coach-note ${n.tone}"><span class="coach-dot"></span><span>${esc(n.text)}</span></li>`).join('')}</ul>`;
}

function coachIntoToday() {
  const view = $('#view-today');
  if (!view) return;
  view.insertAdjacentHTML('beforeend', `
    <div class="section-head">
      <h2>TRAINER</h2>
      <div class="line"></div>
      <span class="hint">adapted to today</span>
    </div>
    <div class="panel">${coachNotesHtml(4)}</div>
  `);
}

/* ---------------- mutation ---------------- */

function addMeal(entry) {
  const key = todayKey();
  if (!state.meals[key]) state.meals[key] = [];
  state.meals[key].push({ id: uid(), name: entry.name, kcal: entry.kcal, protein: entry.protein });
  save();
  renderAll();
}

function openMealModal() {
  openModal(`
    <h2>LOG A MEAL</h2>
    <div class="sub">Home food, canteen or anything from the suggestions.</div>
    <div class="form-grid">
      <label class="field"><span class="lbl">WHAT DID YOU EAT?</span>
        <input type="text" data-meal="name" placeholder="e.g. Puttu + Kadala Curry" />
      </label>
      <div class="form-grid two">
        <label class="field"><span class="lbl">CALORIES (KCAL)</span>
          <input type="number" min="0" max="3000" data-meal="kcal" value="350" />
        </label>
        <label class="field"><span class="lbl">PROTEIN (G)</span>
          <input type="number" min="0" max="200" data-meal="protein" value="15" />
        </label>
      </div>
    </div>
    <div class="section-head" style="margin:18px 0 8px"><h2 style="font-size:10px">QUICK ADD</h2><div class="line"></div></div>
    <div class="chips">
      ${QUICK_FOODS.map((q) => `<button class="chip" data-act="fill-meal" data-name="${esc(q.name)}" data-kcal="${q.kcal}" data-protein="${q.protein}">${esc(q.name)}</button>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-act="save-meal">LOG MEAL</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

function saveMealFromModal() {
  const name = ($('[data-meal="name"]')?.value || '').trim();
  if (!name) { toast('Name the meal first.', 'danger'); return; }
  const kcal = clampNum($('[data-meal="kcal"]')?.value, 0, 3000, 300);
  const protein = clampNum($('[data-meal="protein"]')?.value, 0, 200, 10);
  closeModal();
  addMeal({ name, kcal, protein });
  toast(`Meal logged: ${name}.`);
}

function logDish(id) {
  const dish = FOOD_DB.find((f) => f.id === id);
  if (!dish) return;
  addMeal({ name: dish.name, kcal: dish.kcal, protein: dish.protein });
  toast(`${dish.name} logged (+${dish.kcal} kcal, ${dish.protein} g protein).`, 'gold');
}

function togglePantryItem(item) {
  if (!Array.isArray(state.pantry)) state.pantry = DEFAULT_PANTRY.slice();
  const at = state.pantry.indexOf(item);
  if (at >= 0) state.pantry.splice(at, 1);
  else state.pantry.push(item);
  save();
  renderAll();
}

/* ---------------- events ---------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'history-filter') {
    historyFilter = el.dataset.filter;
    renderHistory();
  } else if (act === 'open-meal') {
    openMealModal();
  } else if (act === 'save-meal') {
    saveMealFromModal();
  } else if (act === 'fill-meal') {
    const nameEl = $('[data-meal="name"]');
    if (nameEl) nameEl.value = el.dataset.name || '';
    const kcalEl = $('[data-meal="kcal"]');
    if (kcalEl) kcalEl.value = el.dataset.kcal || '';
    const protEl = $('[data-meal="protein"]');
    if (protEl) protEl.value = el.dataset.protein || '';
  } else if (act === 'quick-log') {
    addMeal({
      name: el.dataset.name,
      kcal: Number(el.dataset.kcal) || 0,
      protein: Number(el.dataset.protein) || 0
    });
    toast(`${el.dataset.name} logged.`);
  } else if (act === 'del-meal') {
    const key = todayKey();
    state.meals[key] = (state.meals[key] || []).filter((m) => m.id !== el.dataset.id);
    save();
    renderAll();
  } else if (act === 'log-dish') {
    logDish(el.dataset.id);
  } else if (act === 'toggle-pantry') {
    togglePantryItem(el.dataset.item);
  } else if (act === 'pantry-clear') {
    if (confirm('Clear every pantry ingredient? Suggestions will reset.')) {
      state.pantry = [];
      save();
      renderAll();
    }
  }
});

/* ---------------- boot ---------------- */

renderAll();
