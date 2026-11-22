/* ======================================================================
   AI meal planner transport, shared by the hosted Worker and the local
   Node backend so the two never drift apart.

   A key is enough — no base URL to edit:
     gsk_…    → Groq (free tier: openai/gpt-oss-120b)
     sk-…     → OpenAI
     anything else → Freebuff
   AI_BASE_URL still wins when set (any OpenAI-compatible provider), and an
   endpoint that rejects the key falls through to the others.
   ====================================================================== */

const AI_ENDPOINTS = {
  freebuff: 'https://freebuff.com/api/v1/paid',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1'
};

/* Each provider names models differently, so the default follows the host. */
const AI_MODELS = {
  freebuff: 'gpt-4o-mini',
  openai: 'gpt-4o-mini',
  groq: 'openai/gpt-oss-120b'
};

const AI_RETRY_STATUS = [400, 401, 403, 404];
const AI_TIMEOUT_MS = 30000;

// Whichever endpoint answered for this isolate is remembered first next time.
let workingEndpoint = '';

/* Env values copied out of a README often keep the trailing "# comment", and
   that would make an unparseable URL, so cut at the first whitespace. */
function cleanValue(raw) {
  return String(raw == null ? '' : raw).trim().split(/\s+/)[0].replace(/\/+$/, '');
}

export function chatUrl(base) {
  const clean = cleanValue(base);
  return /\/chat\/completions$/.test(clean) ? clean : `${clean}/chat/completions`;
}

function endpointLabel(base) {
  try {
    return new URL(base).host;
  } catch {
    return cleanValue(base) || '(empty base URL)';
  }
}

function guessedEndpoint(env) {
  const key = String((env && env.OPENAI_API_KEY) || '').trim();
  if (/^gsk_/.test(key)) return AI_ENDPOINTS.groq;
  if (/^sk-/.test(key)) return AI_ENDPOINTS.openai;
  return AI_ENDPOINTS.freebuff;
}

/* Ordered endpoints to try: an explicit base, then whatever the key looks
   like, then the other providers. */
export function aiEndpoints(env) {
  const explicit = cleanValue(env && env.AI_BASE_URL);
  const order = [
    explicit,
    workingEndpoint,
    guessedEndpoint(env),
    AI_ENDPOINTS.openai,
    AI_ENDPOINTS.freebuff,
    AI_ENDPOINTS.groq
  ];
  return order.filter((base, index) => base && order.indexOf(base) === index);
}

export function modelFor(base) {
  const clean = cleanValue(base);
  const known = Object.keys(AI_ENDPOINTS).find((name) => AI_ENDPOINTS[name] === clean);
  return (known && AI_MODELS[known]) || AI_MODELS.freebuff;
}

/* POSTs the chat completion body and returns
   { ok: true, payload, base, model } or { ok: false, detail }. */
export async function requestAi(env, body) {
  const attempts = [];
  const override = String((env && env.AI_MODEL) || '').trim();
  for (const base of aiEndpoints(env)) {
    const model = override || modelFor(base);
    let res;
    try {
      res = await fetch(chatUrl(base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS)
      });
    } catch (err) {
      attempts.push(`${endpointLabel(base)}: ${(err && err.message) || err}`);
      continue; // network failure or a bad base URL: the next endpoint may answer
    }

    if (res.ok) {
      workingEndpoint = base;
      return { ok: true, payload: await res.json(), base, model };
    }

    const detail = (await res.text().catch(() => '')).slice(0, 200);
    attempts.push(`${endpointLabel(base)} ${res.status}${detail ? `: ${detail}` : ''}`);
    console.error('[system] ai request rejected:', endpointLabel(base), res.status, detail);
    // A rate limit or an outage is not a key problem, so do not hammer the other hosts.
    if (!AI_RETRY_STATUS.includes(res.status)) break;
  }
  return { ok: false, detail: attempts.join(' | ').slice(0, 600) };
}

/* The model's JSON is untrusted: clamp every field the UI renders. */
export function cleanMeals(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 4)
    .map((meal, index) => ({
      name: String((meal && meal.name) || `Meal ${index + 1}`).slice(0, 90),
      kcal: Math.max(0, Math.round(Number(meal && meal.kcal) || 0)),
      protein: Math.max(0, Math.round(Number(meal && meal.protein) || 0)),
      carbs: Math.max(0, Math.round(Number(meal && meal.carbs) || 0)),
      ingredients: (Array.isArray(meal && meal.ingredients) ? meal.ingredients : [])
        .map((item) => String(item).slice(0, 40))
        .slice(0, 12),
      steps: (Array.isArray(meal && meal.steps) ? meal.steps : [])
        .map((item) => String(item).slice(0, 200))
        .slice(0, 5),
      why: String((meal && (meal.why || meal.note)) || '').slice(0, 260)
    }))
    .filter((meal) => meal.name && (meal.kcal > 0 || meal.protein > 0));
}
