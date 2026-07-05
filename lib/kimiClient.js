// Powers Side Quest generation (see generateSideQuestStory in lib/learning.js)
// and AI word enrichment/translation via Kimi (Moonshot AI). The API is
// OpenAI-compatible, so this calls /chat/completions directly with Node's
// built-in fetch — no SDK needed. JSON mode (response_format json_object)
// guarantees syntactically valid JSON only when the model finishes within
// max_tokens — a truncated answer is retried with a bigger budget below.
// The caller still validates the shape since there's no server-enforced schema.

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2-turbo-preview';
// The default text model can't see images, so image requests (reading words
// out of an uploaded screenshot) go to a vision-capable model instead.
const DEFAULT_VISION_MODEL = 'moonshot-v1-8k-vision-preview';

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

// kimi-latest also accepts images, so it doubles as the last-resort vision model.
const VISION_FALLBACK_PREFERENCE = [
  /^moonshot-v1-8k-vision/,
  /^moonshot-v1-32k-vision/,
  /^moonshot-v1-128k-vision/,
  /vision/i,
  /^kimi-latest/
];

const DEFAULT_TEMPERATURE = 0.6;

// What this API key is known to accept, learned from failed calls: the model
// (see the fallback preferences above) and the temperature (some models
// reject anything but 1). Cached per model family for the rest of the
// process so later calls go straight through.
const resolved = {
  text: { model: null, temperature: null },
  vision: { model: null, temperature: null }
};

const FAMILIES = {
  text: { envVar: 'KIMI_MODEL', defaultModel: DEFAULT_MODEL },
  vision: { envVar: 'KIMI_VISION_MODEL', defaultModel: DEFAULT_VISION_MODEL }
};

function isModelNotFoundError(status, detail) {
  return status === 404 && /model|permission/i.test(detail || '');
}

function isTemperatureError(status, detail) {
  return status === 400 && /temperature/i.test(detail || '');
}

// Some (mostly vision) models reject response_format json_object outright —
// when that happens we drop JSON mode and rely on the prompt + lenient parsing.
function isJsonModeError(status, detail) {
  return status === 400 && /response_format|json_object|json mode/i.test(detail || '');
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

function pickVisionFallbackModel(models, failedModel) {
  // Only models that can actually accept images are candidates here.
  const candidates = models.filter(
    (m) => m !== failedModel && (/vision/i.test(m) || /^kimi-latest/.test(m))
  );
  for (const pattern of VISION_FALLBACK_PREFERENCE) {
    const match = candidates.find((m) => pattern.test(m));
    if (match) return match;
  }
  return candidates[0] || null;
}

// Best-effort JSON extraction for models running without JSON mode: strips
// markdown code fences, then falls back to the outermost {...} in the text.
function parseLenientJson(content) {
  try {
    return JSON.parse(content);
  } catch (err) {
    // Keep going with the cleaned-up variants below.
  }

  const unfenced = content
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch (err) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw err;
  }
}

// One raw chat-completions call. Throws an Error carrying .status and .detail
// so the caller can recognize a model-not-found and retry with a fallback.
async function requestChat({ baseUrl, apiKey, model, temperature, messages, maxTokens, jsonMode }) {
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
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
  const choice = data.choices && data.choices[0] ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : null;
  const finishReason = choice ? choice.finish_reason : null;

  if (!content) {
    // Log what actually came back so an empty answer is diagnosable from the
    // server console (reasoning models can burn the whole max_tokens budget
    // on hidden reasoning and finish with an empty message).
    console.warn('Kimi returned no content. Raw response:', JSON.stringify(data).slice(0, 2000));
    const error = new Error(
      finishReason === 'length'
        ? 'Kimi ran out of tokens before finishing its answer.'
        : 'Kimi returned no content.'
    );
    error.emptyContent = true;
    error.finishReason = finishReason;
    throw error;
  }

  try {
    return parseLenientJson(content);
  } catch (parseErr) {
    // JSON mode only guarantees valid JSON when the model gets to finish.
    // If it hit the max_tokens limit mid-answer, the content is valid JSON
    // cut off partway through ("Unterminated string in JSON at ...").
    console.warn(
      `Kimi returned unparseable JSON (finish_reason: ${finishReason}). Content tail:`,
      content.slice(-300)
    );
    const error = new Error(
      finishReason === 'length'
        ? 'Kimi ran out of tokens before finishing its answer.'
        : `Kimi returned malformed JSON: ${parseErr.message}`
    );
    error.malformedJson = true;
    error.finishReason = finishReason;
    throw error;
  }
}

// The shared request loop for both model families ('text' and 'vision') —
// same recoverable-complaint retries either way, but each family keeps its
// own default model, env override, fallback picker, and resolved cache.
async function runChatJson({ messages, maxTokens, family }) {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new Error('AI features are not configured: set MOONSHOT_API_KEY.');
  }

  const config = FAMILIES[family];
  const cache = resolved[family];
  const pickFallback = family === 'vision' ? pickVisionFallbackModel : pickFallbackModel;

  const baseUrl = (process.env.KIMI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let model = cache.model || process.env[config.envVar] || config.defaultModel;
  let temperature = cache.temperature !== null ? cache.temperature : DEFAULT_TEMPERATURE;
  let jsonMode = true;
  let modelFallbackTried = false;
  let temperatureFallbackTried = false;
  let jsonModeFallbackTried = false;
  let tokenBumpTried = false;
  let reaskTried = false;

  // One request, plus at most one retry per recoverable complaint (unknown
  // model, rejected temperature, rejected JSON mode, token budget exhausted).
  // Whatever model + temperature combination finally works is cached so the
  // next call skips the failed attempts.
  while (true) {
    try {
      const result = await requestChat({ baseUrl, apiKey, model, temperature, messages, maxTokens, jsonMode });
      cache.model = model;
      cache.temperature = temperature;
      return result;
    } catch (err) {
      if (!modelFallbackTried && isModelNotFoundError(err.status, err.detail)) {
        modelFallbackTried = true;
        const available = await fetchAvailableModels(baseUrl, apiKey);
        const fallback = pickFallback(available, model);
        if (!fallback) {
          throw new Error(
            `Kimi model "${model}" is not available to your API key` +
              (available.length ? ` — set ${config.envVar} in .env to one of: ${available.join(', ')}` : '') +
              '. Check your Moonshot account and KIMI_BASE_URL.'
          );
        }
        console.warn(`Kimi model "${model}" is not available to this API key — falling back to "${fallback}".`);
        model = fallback;
        continue;
      }

      if (!temperatureFallbackTried && isTemperatureError(err.status, err.detail)) {
        temperatureFallbackTried = true;
        console.warn(`Kimi model "${model}" rejected temperature ${temperature} — retrying with temperature 1.`);
        temperature = 1;
        continue;
      }

      if (!jsonModeFallbackTried && jsonMode && isJsonModeError(err.status, err.detail)) {
        jsonModeFallbackTried = true;
        console.warn(`Kimi model "${model}" rejected JSON mode — retrying without response_format.`);
        jsonMode = false;
        continue;
      }

      // Reasoning models spend tokens thinking before they answer, so a
      // budget sized for the answer alone can come back empty — or, in JSON
      // mode, truncated partway through the object. Try once more with a
      // much larger budget before giving up.
      if (!tokenBumpTried && (err.emptyContent || err.malformedJson) && err.finishReason === 'length') {
        tokenBumpTried = true;
        console.warn(`Kimi hit the ${maxTokens}-token limit before answering — retrying with ${maxTokens * 4}.`);
        maxTokens *= 4;
        continue;
      }

      // Malformed JSON without a token-limit excuse is rare in JSON mode;
      // one fresh attempt usually clears a bad sample.
      if (!reaskTried && err.malformedJson && err.finishReason !== 'length') {
        reaskTried = true;
        console.warn('Kimi returned malformed JSON — retrying once.');
        continue;
      }

      throw err;
    }
  }
}

async function kimiChatJson({ system, user, maxTokens = 2500 }) {
  return runChatJson({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    maxTokens,
    family: 'text'
  });
}

// Same contract as kimiChatJson, plus an image the model can see. The image
// travels as a data URL (data:image/png;base64,...) in the OpenAI-style
// multimodal content array, so nothing needs to be uploaded anywhere first.
async function kimiVisionChatJson({ system, text, imageDataUrl, maxTokens = 2500 }) {
  return runChatJson({
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text }
        ]
      }
    ],
    maxTokens,
    family: 'vision'
  });
}

module.exports = { kimiChatJson, kimiVisionChatJson };
