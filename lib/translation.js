const { kimiChatJson } = require('./kimiClient');

// Languages a word can be stored in and a learner can translate into. Kept in
// one place so the words routes, profile routes, and /api/languages all agree.
// Validated here in Express rather than with a DB check constraint so adding
// a language later is a one-line change, not a migration.
const SUPPORTED_LANGUAGES = [
  'english',
  'dutch',
  'german',
  'french',
  'spanish',
  'italian',
  'portuguese',
  'japanese',
  'korean',
  'mandarin',
  'hindi',
  'arabic'
];

const DEFAULT_LANGUAGE = 'english';

function isSupportedLanguage(language) {
  return SUPPORTED_LANGUAGES.includes(language);
}

function buildTranslationPrompt(words, targetLanguage) {
  const wordList = words
    .map((w) =>
      JSON.stringify({
        id: w.id,
        term: w.term,
        language: w.language,
        // The definition disambiguates homographs (e.g. "bank" the institution
        // vs "bank" of a river) so the model picks the right translation.
        meaning: w.definition
      })
    )
    .join('\n');

  return [
    `Translate each vocabulary word below into ${targetLanguage}.`,
    'Each line is a JSON object with the word\'s id, the term, the language the term is written in,',
    'and its meaning (use the meaning to pick the correct sense of the word).',
    '',
    wordList,
    '',
    'Respond with a single JSON object in exactly this shape (no extra keys, no markdown):',
    '{',
    '  "translations": [',
    '    { "id": "the id exactly as given", "translation": "the word translated into ' + targetLanguage + '" }',
    '  ]',
    '}',
    'Include exactly one entry per word. The translation must be the single most natural',
    `${targetLanguage} equivalent of the term — just the word or short phrase, no explanations.`
  ].join('\n');
}

// Calls Kimi once for a batch of words and returns a Map of word id ->
// translated term. Malformed entries are skipped rather than failing the batch.
async function translateBatch(words, targetLanguage) {
  const result = await kimiChatJson({
    system:
      'You are a precise multilingual dictionary for a language-learning app. You always respond with a single valid JSON object in exactly the shape the user requests — no markdown, no commentary.',
    user: buildTranslationPrompt(words, targetLanguage)
  });

  const byId = new Map();
  if (result && Array.isArray(result.translations)) {
    const validIds = new Set(words.map((w) => w.id));
    for (const item of result.translations) {
      if (item && typeof item.id === 'string' && typeof item.translation === 'string' && item.translation.trim() && validIds.has(item.id)) {
        byId.set(item.id, item.translation.trim());
      }
    }
  }
  return byId;
}

// Returns a copy of `words` with a `translation` field: the term rendered in
// `targetLanguage`. Cached translations come from the word_translations table;
// anything missing is translated in one Kimi call and cached for next time.
// Never throws — if Kimi is unconfigured or the lookup fails, the words come
// back with translation: null so the rest of the page still works.
async function attachTranslations(supabase, words, targetLanguage) {
  if (!Array.isArray(words) || words.length === 0) return [];

  const translationByWordId = new Map();

  // A word already in the learner's chosen language is its own translation.
  const needsTranslation = words.filter((w) => {
    if ((w.language || DEFAULT_LANGUAGE) === targetLanguage) {
      translationByWordId.set(w.id, w.term);
      return false;
    }
    return true;
  });

  try {
    if (needsTranslation.length > 0) {
      const { data: cached, error } = await supabase
        .from('word_translations')
        .select('word_id, translation')
        .eq('language', targetLanguage)
        .in('word_id', needsTranslation.map((w) => w.id));
      if (error) throw new Error(error.message);

      for (const row of cached || []) {
        translationByWordId.set(row.word_id, row.translation);
      }

      const missing = needsTranslation.filter((w) => !translationByWordId.has(w.id));
      if (missing.length > 0) {
        const fresh = await translateBatch(missing, targetLanguage);
        if (fresh.size > 0) {
          const rows = [...fresh.entries()].map(([wordId, translation]) => ({
            word_id: wordId,
            language: targetLanguage,
            translation
          }));
          const { error: upsertError } = await supabase
            .from('word_translations')
            .upsert(rows, { onConflict: 'word_id,language' });
          if (upsertError) console.warn('Could not cache word translations:', upsertError.message);

          for (const [wordId, translation] of fresh) {
            translationByWordId.set(wordId, translation);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Could not translate words into ${targetLanguage}:`, err.message);
  }

  return words.map((w) => ({
    ...w,
    translation: translationByWordId.has(w.id) ? translationByWordId.get(w.id) : null
  }));
}

module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  attachTranslations
};
