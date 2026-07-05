const { kimiChatJson, kimiVisionChatJson } = require('./kimiClient');

// Which extra grammar forms the AI must provide for each part of speech.
// Mirrors what a learner's paper dictionary would list: verbs get their two
// past tenses, nouns their article + plural, adjectives their comparison forms.
const GRAMMAR_FORM_KEYS = {
  verb: ['imperfectum', 'perfectum'],
  noun: ['article', 'plural'],
  adjective: ['comparative', 'superlative']
};

const PARTS_OF_SPEECH = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'preposition',
  'conjunction',
  'interjection',
  'phrase',
  'other'
];

const DIFFICULTIES = ['easy', 'medium', 'hard'];

function buildEnrichmentPrompt(term, language) {
  return [
    `A vocabulary word is being added to a language-learning app: "${term}" (${language}).`,
    'Fill in its dictionary entry.',
    '',
    'Respond with a single JSON object in exactly this shape (no extra keys, no markdown):',
    '{',
    '  "definition": "a short, clear definition in English",',
    `  "part_of_speech": "one of: ${PARTS_OF_SPEECH.join(', ')}",`,
    `  "example_sentence": "one natural example sentence in ${language} using the word",`,
    '  "difficulty": "easy, medium, or hard — how hard this word is for a beginner learner",',
    '  "grammar_forms": { }',
    '}',
    '',
    'Rules for "grammar_forms", based on the part of speech:',
    `- verb: { "imperfectum": "the simple past tense (imperfectum) in ${language}", "perfectum": "the present perfect (perfectum) in ${language}, including the auxiliary verb" }`,
    `- noun: { "article": "the definite article used with this noun in ${language} (empty string if ${language} has none)", "plural": "the plural form in ${language}" }`,
    `- adjective: { "comparative": "the comparative form in ${language}", "superlative": "the superlative form in ${language}" }`,
    '- any other part of speech: {} (an empty object)',
    '',
    `If "${term}" is misspelled or is not a real ${language} word, respond with {"error": "a short explanation"} instead.`
  ].join('\n');
}

// Keeps only the grammar forms defined for this part of speech, dropping
// anything malformed — a partially filled entry is better than a failed add.
function cleanGrammarForms(partOfSpeech, raw) {
  const keys = GRAMMAR_FORM_KEYS[partOfSpeech];
  if (!keys || !raw || typeof raw !== 'object') return null;

  const forms = {};
  for (const key of keys) {
    if (typeof raw[key] === 'string' && raw[key].trim()) {
      forms[key] = raw[key].trim();
    }
  }
  return Object.keys(forms).length > 0 ? forms : null;
}

// Asks Kimi for everything the admin no longer types by hand: definition,
// part of speech, example sentence, difficulty, and the part-of-speech
// specific grammar forms. Throws with a user-facing message when the model
// rejects the word or returns an unusable entry.
async function enrichWord(term, language) {
  const result = await kimiChatJson({
    system:
      'You are a precise multilingual dictionary for a language-learning app. You always respond with a single valid JSON object in exactly the shape the user requests — no markdown, no commentary.',
    user: buildEnrichmentPrompt(term, language),
    maxTokens: 800
  });

  if (result && typeof result.error === 'string' && result.error.trim()) {
    throw new Error(`The AI could not add "${term}": ${result.error.trim()}`);
  }
  if (!result || typeof result.definition !== 'string' || !result.definition.trim()) {
    throw new Error('The AI returned no definition. Try again.');
  }

  const partOfSpeech = typeof result.part_of_speech === 'string' ? result.part_of_speech.trim().toLowerCase() : '';

  return {
    definition: result.definition.trim(),
    part_of_speech: PARTS_OF_SPEECH.includes(partOfSpeech) ? partOfSpeech : null,
    example_sentence:
      typeof result.example_sentence === 'string' && result.example_sentence.trim()
        ? result.example_sentence.trim()
        : null,
    difficulty: DIFFICULTIES.includes(result.difficulty) ? result.difficulty : 'medium',
    grammar_forms: cleanGrammarForms(partOfSpeech, result.grammar_forms)
  };
}

// Cap on how many candidate words one image can yield — keeps the response
// (and the add-selected loop that follows, one enrichment call per word)
// from ballooning on a dense screenshot.
const MAX_IMAGE_WORDS = 30;

function buildImageExtractionPrompt(language) {
  return [
    'A language learner uploaded this image to their vocabulary app. It could be anything:',
    'a screenshot of an app or website, a photo of a book page or worksheet, a vocabulary',
    'list, subtitles, or a photo of objects.',
    '',
    `Find the ${language} vocabulary words in it that are worth adding to a word bank.`,
    '',
    'Rules:',
    '- Read all visible text. If the image mostly shows objects rather than text, name the main objects in ' + language + '.',
    '- Return every word in its dictionary form: infinitive for verbs, singular without article for nouns, base form for adjectives.',
    `- Only include real ${language} words. Skip words in other languages, proper names, numbers,`,
    '  URLs, abbreviations, and app UI labels (menus, buttons, navigation).',
    '- Prefer content words a learner would actually study (nouns, verbs, adjectives, adverbs) over articles, pronouns, and prepositions.',
    `- No duplicates. At most ${MAX_IMAGE_WORDS} words — if there are more, keep the most useful ones for a learner.`,
    '',
    'Respond with a single JSON object in exactly this shape (no extra keys, no markdown):',
    '{ "words": ["word1", "word2"] }',
    '',
    `If the image contains no usable ${language} words, respond with { "words": [] }.`
  ].join('\n');
}

// Asks a vision-capable Kimi model to read an uploaded image and pull out the
// vocabulary words in the given language, normalized to dictionary form and
// deduplicated. Returns an array of terms (possibly empty).
async function extractWordsFromImage(imageDataUrl, language) {
  const result = await kimiVisionChatJson({
    system:
      'You are a precise multilingual vocabulary extractor for a language-learning app. You always respond with a single valid JSON object in exactly the shape the user requests — no markdown, no commentary.',
    text: buildImageExtractionPrompt(language),
    imageDataUrl,
    maxTokens: 1200
  });

  if (result && typeof result.error === 'string' && result.error.trim()) {
    throw new Error(`The AI could not read the image: ${result.error.trim()}`);
  }
  if (!result || !Array.isArray(result.words)) {
    throw new Error('The AI returned no word list for this image. Try again.');
  }

  const seen = new Set();
  const words = [];
  for (const raw of result.words) {
    if (typeof raw !== 'string') continue;
    const term = raw.trim();
    // Same 80-char cap as the manual add form's input.
    if (!term || term.length > 80) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(term);
    if (words.length >= MAX_IMAGE_WORDS) break;
  }
  return words;
}

module.exports = { enrichWord, extractWordsFromImage };
