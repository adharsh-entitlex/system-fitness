'use strict';

/* ======================================================================
   AI meal planner
   ----------------------------------------------------------------------
   Sends the pantry, the remaining macro budget and a diet preference to
   the server, which asks the model and returns structured meals. Results
   are cached in the record so they survive a reload.
   ====================================================================== */

const AI_DIETS = [
  ['balanced', 'BALANCED'],
  ['high-protein', 'HIGH PROTEIN'],
  ['low-carb', 'LOW CARB'],
  ['vegetarian', 'VEGETARIAN'],
  ['kerala', 'KERALA HOME']
];

function aiState() {
  if (!state.ai) state.ai = { diet: 'balanced', notes: '', results: [], at: 0, error: '', detail: '', busy: false, remaining: null };
  return state.ai;
}

function aiPanelHtml() {
  const ai = aiState();
  const diets = AI_DIETS.map(
    ([value, label]) => `<option value="${value}"${ai.diet === value ? ' selected' : ''}>${label}</option>`
  ).join('');

  const cards = (ai.results || []).map((meal, i) => `
    <article class="food-card ai-card">
      <div class="food-head">
        <h3>${esc(meal.name)}</h3>
        <span class="food-meal">AI</span>
      </div>
      <div class="food-macros"><b>${meal.kcal}</b> kcal · <b>${meal.protein} g</b> protein${meal.carbs ? ` · ${meal.carbs} g carbs` : ''}</div>
      ${meal.ingredients && meal.ingredients.length ? `<div class="food-ings">${meal.ingredients.map((item) => `<span class="ing">${esc(item)}</span>`).join('')}</div>` : ''}
      ${meal.why ? `<p class="panel-sub" style="font-size:12.5px;line-height:1.5;margin:8px 0 0">${esc(meal.why)}</p>` : ''}
      ${meal.steps && meal.steps.length ? `<ol class="ai-steps">${meal.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
      <button class="btn block" data-act="ai-log" data-i="${i}">LOG THIS MEAL</button>
    </article>`).join('');

  const budget = ai.remaining
    ? `<span class="hint">${ai.remaining.kcal} kcal · ${ai.remaining.protein} g protein left today</span>`
    : '<span class="hint">pantry-aware</span>';

  return `
    <div class="section-head">
      <h2>AI MEAL PLAN</h2>
      <div class="line"></div>
      ${budget}
    </div>
    <div class="panel ${ai.error ? '' : 'glow'}">
      <p class="panel-sub" style="margin:0 0 12px">
        The System reads your pantry, what you have already eaten and your remaining macros, then builds meals you can cook right now.
      </p>
      <div class="form-grid two">
        <label class="field"><span class="lbl">DIET</span>
          <select data-change="ai-diet">${diets}</select>
        </label>
        <label class="field"><span class="lbl">ANYTHING TO AVOID?</span>
          <input type="text" data-ai="notes" maxlength="300" placeholder="e.g. no coconut, light on oil" value="${esc(ai.notes || '')}" />
        </label>
      </div>
      <div class="modal-actions" style="margin-top:12px;justify-content:flex-start">
        <button class="btn primary" data-act="ai-plan" ${ai.busy ? 'disabled' : ''}>${ai.busy ? 'THINKING…' : 'GENERATE PLAN'}</button>
        ${ai.at ? `<span class="hint" style="align-self:center">built ${new Date(ai.at).toLocaleTimeString()}</span>` : ''}
      </div>
      ${ai.error ? `<p class="ai-error">${esc(ai.error)}</p>` : ''}
      ${ai.error && ai.detail ? `<p class="ai-detail">${esc(ai.detail)}</p>` : ''}
    </div>
    ${cards ? `<div class="panel"><div class="food-grid">${cards}</div></div>` : ''}
  `;
}

async function requestAiPlan() {
  const ai = aiState();
  if (ai.busy) return;
  if (!auth.user) {
    toast('Sign in to use the AI planner — it runs on the server.', 'danger');
    return;
  }
  const pantry = state.pantry || [];
  if (!pantry.length) {
    toast('Tick a few pantry ingredients first.', 'danger');
    return;
  }

  const notesEl = document.querySelector('[data-ai="notes"]');
  ai.notes = notesEl ? notesEl.value.slice(0, 300) : ai.notes;
  ai.busy = true;
  ai.error = '';
  ai.detail = '';
  renderAll();

  const today = todayKey();
  const meals = (state.meals[today] || []).reduce(
    (acc, meal) => ({ kcal: acc.kcal + (Number(meal.kcal) || 0), protein: acc.protein + (Number(meal.protein) || 0) }),
    { kcal: 0, protein: 0 }
  );

  try {
    const res = await fetch('/api/ai/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pantry,
        diet: ai.diet,
        notes: ai.notes,
        meal: typeof mealNow === 'function' ? mealNow() : 'lunch',
        goals: state.nutrition,
        eaten: meals
      })
    });
    const body = await res.json().catch(() => null);

    if (!res.ok || !body || !body.meals) {
      ai.error = (body && body.hint) || (body && body.error) || `The planner failed (HTTP ${res.status}).`;
      ai.detail = (body && body.detail) || '';
    } else {
      ai.results = body.meals;
      ai.at = Date.now();
      ai.remaining = body.remaining || null;
      ai.detail = '';
      toast('Plan ready — three meals from your pantry.', 'gold');
    }
  } catch {
    ai.error = 'Could not reach the server. Try again in a moment.';
    ai.detail = '';
  } finally {
    ai.busy = false;
    save();
    renderAll();
  }
}

function logAiMeal(index) {
  const meal = (aiState().results || [])[index];
  if (!meal) return;
  addMeal({ name: meal.name, kcal: meal.kcal, protein: meal.protein });
  toast(`${meal.name} logged (+${meal.kcal} kcal, ${meal.protein} g protein).`, 'gold');
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'ai-plan') requestAiPlan();
  else if (el.dataset.act === 'ai-log') logAiMeal(Number(el.dataset.i));
});

document.addEventListener('change', (e) => {
  if (!e.target.matches || !e.target.matches('[data-change="ai-diet"]')) return;
  aiState().diet = e.target.value;
  save();
});

/* The nutrition view rendered before this file loaded, so paint it once more
   now that the AI panel markup exists. */
if (typeof renderAll === 'function') renderAll();
