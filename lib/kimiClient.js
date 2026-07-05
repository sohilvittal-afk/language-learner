// Powers Side Quest generation (see generateSideQuestStory in lib/learning.js)
// and AI word enrichment/translation via Kimi (Moonshot AI). The API is
// OpenAI-compatible, so this calls /chat/completions directly with Node's
// built-in fetch — no SDK needed. JSON mode (response_format json_object)
// guarantees syntactically valid JSON; the caller still validates the shape
// since there's no server-enforced schema.

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2-turbo-preview';

// Not every Moonshot account can use every model — some keys get a 404
// "Not found the model ... or Permission denied" for the default. When that
// happens we ask the API which models this key CAN use, pick the best one in
// this order, and remember it for the rest of the process.
const FALLBACK_PREFERENCE = [
  /^kimi-k2-turbo/,
  /^kimi-k2(?!-thinking)/,
  /^kimi-latest/,
  /^moonshot-v1-auto/,
  /^moonshot-v1-8k/,
  /^moonshot-v1/
];

let resolvedModel = null;

function isModelNotFoundError(status, detail) {
  return status === 404 && /model|permission/i.test(detail || '');
}

async function fetchAvailableModels(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.data) ? data.data.map((m) => m && m.id).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

function pickFallbackModel(models, failedModel) {
  // Skip the model that just failed and anything that isn't a plain chat model.
  const candidates = models.filter(
    (m) => m !== failedModel && !/embed|vision|thinking|audio|image|moderation/i.test(m)
  );
  for (const pattern of FALLBACK_PREFERENCE) {
    const match = candidates.find((m) => pattern.test(m));
    if (match) return match;
  }
  return candidates[0] || null;
}

// One raw chat-completions call. Throws an Error carrying .status and .detail
// so the caller can recognize a model-not-found and retry with a fallback.
async function requestChat({ baseUrl, apiKey, model, system, user, maxTokens }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error && body.error.message ? body.error.message : '';
    } catch (err) {
      // Non-JSON error body — the status code alone will have to do.
    }
    // A 401 is always a configuration problem on our side — say how to fix it.
    const message =
      res.status === 401
        ? 'Kimi rejected the API key (401). Check MOONSHOT_API_KEY in .env (no quotes or spaces), ' +
          'and that KIMI_BASE_URL matches where the key was created: keys from platform.moonshot.ai ' +
          'need https://api.moonshot.ai/v1 (the default), keys from platform.moonshot.cn need https://api.moonshot.cn/v1.'
        : `Kimi API error ${res.status}${detail ? `: ${detail}` : ''}`;
    const error = new Error(message);
    error.status = res.status;
    error.detail = detail;
    throw error;
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) throw new Error('Kimi returned no content.');

  return JSON.parse(content);
}

async function kimiChatJson({ system, user, maxTokens = 2500 }) {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new Error('AI features are not configured: set MOONSHOT_API_KEY.');
  }

  const baseUrl = (process.env.KIMI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = resolvedModel || process.env.KIMI_MODEL || DEFAULT_MODEL;

  try {
    return await requestChat({ baseUrl, apiKey, model, system, user, maxTokens });
  } catch (err) {
    if (!isModelNotFoundError(err.status, err.detail)) throw err;

    const available = await fetchAvailableModels(baseUrl, apiKey);
    const fallback = pickFallbackModel(available, model);
    if (!fallback) {
      throw new Error(
        `Kimi model "${model}" is not available to your API key` +
          (available.length ? ` — set KIMI_MODEL in .env to one of: ${available.join(', ')}` : '') +
          '. Check your Moonshot account and KIMI_BASE_URL.'
      );
    }

    console.warn(`Kimi model "${model}" is not available to this API key — falling back to "${fallback}".`);
    const result = await requestChat({ baseUrl, apiKey, model: fallback, system, user, maxTokens });
    resolvedModel = fallback;
    return result;
  }
}

module.exports = { kimiChatJson };
