// Powers Side Quest generation (see generateSideQuestStory in lib/learning.js)
// via Kimi (Moonshot AI). The API is OpenAI-compatible, so this calls
// /chat/completions directly with Node's built-in fetch — no SDK needed.
// JSON mode (response_format json_object) guarantees syntactically valid JSON;
// the caller still validates the shape since there's no server-enforced schema.

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2-turbo-preview';

async function kimiChatJson({ system, user, maxTokens = 2500 }) {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new Error('Side Quests are not configured: set MOONSHOT_API_KEY.');
  }

  const baseUrl = (process.env.KIMI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = process.env.KIMI_MODEL || DEFAULT_MODEL;

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
      detail = body.error && body.error.message ? `: ${body.error.message}` : '';
    } catch (err) {
      // Non-JSON error body — the status code alone will have to do.
    }
    throw new Error(`Kimi API error ${res.status}${detail}`);
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) throw new Error('Kimi returned no content.');

  return JSON.parse(content);
}

module.exports = { kimiChatJson };
