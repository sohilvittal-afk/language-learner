const { kimiChatJson } = require('./kimiClient');

const MAX_QUEST_WORDS = 5;

// Simplified SM-2 spaced repetition. A missing progress row means "never
// studied" and is treated as immediately due (see pickWordsForUser).
function nextProgress(base, correct) {
  let { repetitions, ease_factor: easeFactor, interval_days: intervalDays } = base;

  if (correct) {
    repetitions += 1;
    easeFactor = Math.min(2.8, easeFactor + 0.1);
    if (repetitions === 1) intervalDays = 1;
    else if (repetitions === 2) intervalDays = 3;
    else intervalDays = Math.max(1, Math.round(intervalDays * easeFactor));
  } else {
    repetitions = 0;
    easeFactor = Math.max(1.3, easeFactor - 0.2);
    intervalDays = 1;
  }

  const nextReviewAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString();
  return { repetitions, ease_factor: easeFactor, interval_days: intervalDays, next_review_at: nextReviewAt };
}

// Records one flashcard/quiz answer and returns the updated progress row.
async function recordAnswer(supabase, userId, wordId, correct) {
  const { data: existing } = await supabase
    .from('user_word_progress')
    .select('repetitions, ease_factor, interval_days, correct_count, incorrect_count')
    .eq('user_id', userId)
    .eq('word_id', wordId)
    .maybeSingle();

  const base = existing || { repetitions: 0, ease_factor: 2.5, interval_days: 0, correct_count: 0, incorrect_count: 0 };
  const updated = nextProgress(base, correct);

  const { data, error } = await supabase
    .from('user_word_progress')
    .upsert(
      {
        user_id: userId,
        word_id: wordId,
        repetitions: updated.repetitions,
        ease_factor: updated.ease_factor,
        interval_days: updated.interval_days,
        next_review_at: updated.next_review_at,
        last_result: correct ? 'correct' : 'incorrect',
        correct_count: base.correct_count + (correct ? 1 : 0),
        incorrect_count: base.incorrect_count + (correct ? 0 : 1),
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,word_id' }
    )
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

// Picks up to `count` words for this user, prioritizing words that are due
// for review (or have never been studied) over ones that were reviewed
// recently — this is what makes a word "come back around for revision".
async function pickWordsForUser(supabase, userId, count) {
  const { data: words, error: wordsError } = await supabase
    .from('words')
    .select('id, term, definition, example_sentence, part_of_speech, language, grammar_forms');
  if (wordsError) throw new Error(wordsError.message);
  if (!words || words.length === 0) return [];

  const { data: progress, error: progressError } = await supabase
    .from('user_word_progress')
    .select('word_id, next_review_at')
    .eq('user_id', userId);
  if (progressError) throw new Error(progressError.message);

  const progressByWord = new Map((progress || []).map((p) => [p.word_id, p]));
  const now = Date.now();

  const scored = words.map((word) => {
    const p = progressByWord.get(word.id);
    const overdueMs = p ? now - new Date(p.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
    return { word, overdueMs };
  });

  const due = scored.filter((s) => s.overdueMs >= 0).sort((a, b) => b.overdueMs - a.overdueMs);
  const notDue = scored.filter((s) => s.overdueMs < 0).sort(() => Math.random() - 0.5);

  return [...due, ...notDue].slice(0, count).map((s) => s.word);
}

function buildQuestPrompt(words) {
  const wordList = words
    .map((w) => `- "${w.term}"${w.part_of_speech ? ` (${w.part_of_speech})` : ''}: ${w.definition}`)
    .join('\n');

  return [
    'Write a short, natural conversation (a dialogue between two or three named characters) for a language-learning app.',
    'It must naturally use every one of these vocabulary words at least once, in a form a learner would recognize:',
    wordList,
    '',
    'Keep it friendly and easy to follow: 8-14 lines total, each line one or two sentences.',
    'Then write exactly one multiple-choice comprehension question per vocabulary word, testing whether the reader',
    'understood what the word means from how it was used in the conversation (not just restating the dictionary',
    'definition). Each question needs exactly 4 options with exactly one correct answer.',
    '',
    'Respond with a single JSON object in exactly this shape (no extra keys, no markdown):',
    '{',
    '  "title": "A short, fun title for this side quest",',
    '  "setting": "One sentence setting the scene for the conversation",',
    '  "lines": [ { "speaker": "Name", "text": "What they say" } ],',
    '  "quiz": [',
    '    {',
    '      "word": "the exact vocabulary word this question tests, as given above",',
    '      "question": "the comprehension question",',
    '      "options": ["option A", "option B", "option C", "option D"],',
    '      "correctIndex": 0',
    '    }',
    '  ]',
    '}',
    '"correctIndex" is the 0-3 index of the correct option.'
  ].join('\n');
}

// Kimi's JSON mode guarantees valid JSON but not this exact shape, so check
// everything POST /api/side-quests/generate depends on before it's stored.
function validateQuestShape(quest) {
  if (!quest || typeof quest !== 'object') throw new Error('The model returned no quest object.');
  if (!quest.title || typeof quest.title !== 'string') throw new Error('The model returned a quest without a title.');
  if (!Array.isArray(quest.lines) || quest.lines.length === 0) throw new Error('The model returned a quest without dialogue.');
  for (const line of quest.lines) {
    if (!line || typeof line.speaker !== 'string' || typeof line.text !== 'string') {
      throw new Error('The model returned malformed dialogue lines.');
    }
  }
  if (!Array.isArray(quest.quiz) || quest.quiz.length === 0) throw new Error('The model returned a quest without a quiz.');
  for (const item of quest.quiz) {
    if (
      !item ||
      typeof item.word !== 'string' ||
      typeof item.question !== 'string' ||
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      !item.options.every((o) => typeof o === 'string') ||
      !Number.isInteger(item.correctIndex) ||
      item.correctIndex < 0 ||
      item.correctIndex > 3
    ) {
      throw new Error('The model returned a malformed quiz question.');
    }
  }
  return quest;
}

// Calls Kimi to write the quest story + quiz for the given words (max 5).
async function generateSideQuestStory(words) {
  // A full quest (dialogue + one quiz question per word) is the largest
  // response this app asks for, so give it a bigger budget than the default.
  const quest = await kimiChatJson({
    system:
      'You write short, fun, level-appropriate conversational stories ("side quests") for a language-learning app. You always respond with a single valid JSON object in exactly the shape the user requests — no markdown, no commentary.',
    user: buildQuestPrompt(words),
    maxTokens: 4000
  });

  return validateQuestShape(quest);
}

// Matches each quiz item's word text back to a word_id from the chosen
// words, and drops any quiz item that doesn't match (the model is expected
// to use the exact given terms, but this guards against drift).
function attachWordIds(quest, words) {
  const byTermLower = new Map(words.map((w) => [w.term.toLowerCase(), w]));
  const quiz = (quest.quiz || [])
    .map((item) => {
      const match = byTermLower.get(String(item.word || '').toLowerCase());
      return match ? { ...item, word_id: match.id, word: match.term } : null;
    })
    .filter(Boolean);

  return { ...quest, quiz };
}

function stripQuizAnswers(quest) {
  return {
    ...quest,
    quiz: (quest.quiz || []).map(({ correctIndex, ...rest }) => rest)
  };
}

module.exports = {
  MAX_QUEST_WORDS,
  nextProgress,
  recordAnswer,
  pickWordsForUser,
  generateSideQuestStory,
  attachWordIds,
  stripQuizAnswers
};
