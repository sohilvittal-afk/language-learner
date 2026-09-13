require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { getServiceRoleClient } = require('./lib/supabaseClient');
const {
  MAX_QUEST_WORDS,
  recordAnswer,
  pickWordsForUser,
  generateSideQuestStory,
  attachWordIds,
  stripQuizAnswers
} = require('./lib/learning');
const {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  attachTranslations
} = require('./lib/translation');
const { enrichWord, extractWordsFromImage } = require('./lib/enrichment');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Mock user ID for development (no authentication)
const MOCK_USER_ID = 'dev-user-001';

const app = express();
const PORT = process.env.PORT || 4000;

// --- middleware --------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
// Raised from the default 100kb so a base64-encoded screenshot (see
// POST /api/education) fits in the request body alongside its JSON wrapper.
app.use(express.json({ limit: '6mb' }));

// Middleware to inject mock user into all requests (no authentication)
app.use((req, res, next) => {
  req.user = { id: MOCK_USER_ID };
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- home route --------------------------------------------------------
app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});


// Decodes and validates an image data URL (e.g. "data:image/png;base64,...")
// as uploaded by the browser forms. Throws a user-facing message on a wrong
// type or oversized image; returns the decoded bytes plus extension.
function parseImageDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) {
    throw new Error('Image must be a PNG, JPEG, GIF, or WEBP file.');
  }

  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image must be smaller than 4MB.');
  }
  return { ext, buffer };
}

// Uploads a validated image from the Content Management form to the public
// 'education-content' storage bucket (see supabase/education_content.sql).
// Returns the public URL to store in education_content.image_url.
async function uploadEducationImage(supabase, dataUrl) {
  const { ext, buffer } = parseImageDataUrl(dataUrl);

  const filePath = `${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('education-content')
    .upload(filePath, buffer, { contentType: `image/${ext}` });

  if (uploadError) throw new Error(uploadError.message);

  const { data } = supabase.storage.from('education-content').getPublicUrl(filePath);
  return data.publicUrl;
}

// --- education content ---------------------------------------------------
app.get('/api/education', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('education_content')
    .select('id, title, body, image_url, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ posts: data || [] });
});

app.post('/api/education', async (req, res) => {
  const { title, body, image } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  let imageUrl = null;
  if (image) {
    try {
      imageUrl = await uploadEducationImage(supabase, image);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const { data, error } = await supabase
    .from('education_content')
    .insert({
      title: title.trim(),
      body: body ? body.trim() : null,
      image_url: imageUrl,
      created_by: req.user.id
    })
    .select('id, title, body, image_url, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ post: data });
});

app.delete('/api/education/:id', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { error } = await supabase.from('education_content').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// --- own profile -----------------------------------------------------------
// Unlike /api/users (admins editing OTHER people), these routes let any
// logged-in user read and update their own learning settings — currently just
// preferred_language, the language the word bank gets translated into.

// The language everything gets translated into for this user. Falls back to
// the default if the profile row is missing or predates the language column.
async function getPreferredLanguage(supabase, userId) {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('preferred_language')
      .eq('id', userId)
      .maybeSingle();
    if (data && isSupportedLanguage(data.preferred_language)) return data.preferred_language;
  } catch (err) {
    console.warn('Could not read preferred language:', err.message);
  }
  return DEFAULT_LANGUAGE;
}

// The one list of languages the UI can offer — used by the Profile page's
// selector and the admin add-word form.
app.get('/api/languages', (req, res) => {
  res.json({ languages: SUPPORTED_LANGUAGES, default: DEFAULT_LANGUAGE });
});

app.get('/api/profile', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const preferredLanguage = await getPreferredLanguage(supabase, req.user.id);
  res.json({
    profile: {
      username: 'dev-user',
      email: 'dev@example.com',
      role: 'admin',
      preferred_language: preferredLanguage
    }
  });
});

app.patch('/api/profile', async (req, res) => {
  const { preferred_language } = req.body;
  if (!isSupportedLanguage(preferred_language)) {
    return res.status(400).json({ error: 'Pick one of the supported languages.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: req.user.id, preferred_language }, { onConflict: 'id' })
    .select('preferred_language')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: { preferred_language: data ? data.preferred_language : preferred_language } });
});

// --- word bank -----------------------------------------------------------
app.get('/api/words', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('words')
    .select('id, term, definition, example_sentence, part_of_speech, difficulty, language, grammar_forms, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Each learner sees the bank translated into their own preferred language
  // (set on the Profile page). Translations are cached, so only words never
  // requested in this language before cost a Kimi call.
  const preferredLanguage = await getPreferredLanguage(supabase, req.user.id);
  const words = await attachTranslations(supabase, data || [], preferredLanguage);
  res.json({ words, translation_language: preferredLanguage });
});

app.post('/api/words', async (req, res) => {
  const { term, language } = req.body;
  if (!term || !term.trim()) {
    return res.status(400).json({ error: 'Term is required.' });
  }
  if (language && !isSupportedLanguage(language)) {
    return res.status(400).json({ error: 'Pick one of the supported languages.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const wordLanguage = language || DEFAULT_LANGUAGE;

  let enriched;
  try {
    enriched = await enrichWord(term.trim(), wordLanguage);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const { data, error } = await supabase
    .from('words')
    .insert({
      term: term.trim(),
      definition: enriched.definition,
      example_sentence: enriched.example_sentence,
      part_of_speech: enriched.part_of_speech,
      difficulty: enriched.difficulty,
      language: wordLanguage,
      grammar_forms: enriched.grammar_forms,
      created_by: req.user.id
    })
    .select('id, term, definition, example_sentence, part_of_speech, difficulty, language, grammar_forms, created_at')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'That word is already in the bank for that language.' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ word: data });
});

app.post('/api/words/extract-image', async (req, res) => {
  const { image, language } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'Attach an image first.' });
  }
  if (language && !isSupportedLanguage(language)) {
    return res.status(400).json({ error: 'Pick one of the supported languages.' });
  }

  try {
    parseImageDataUrl(image);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const wordLanguage = language || DEFAULT_LANGUAGE;

  let terms;
  try {
    terms = await extractWordsFromImage(image, wordLanguage);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  // Flag words already in the bank for this language so the UI can uncheck
  // them up front instead of surfacing duplicate errors one by one later.
  const existingTerms = new Set();
  if (terms.length > 0) {
    const { data: existing, error } = await supabase
      .from('words')
      .select('term')
      .eq('language', wordLanguage);
    if (error) return res.status(500).json({ error: error.message });
    for (const row of existing || []) existingTerms.add(row.term.toLowerCase());
  }

  res.json({
    language: wordLanguage,
    words: terms.map((term) => ({ term, exists: existingTerms.has(term.toLowerCase()) }))
  });
});

app.delete('/api/words/:id', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { error } = await supabase.from('words').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// --- flashcard review (spaced repetition) ---------------------------------
app.get('/api/practice/next', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  try {
    const words = await pickWordsForUser(supabase, req.user.id, 10);
    const preferredLanguage = await getPreferredLanguage(supabase, req.user.id);
    res.json({
      words: await attachTranslations(supabase, words, preferredLanguage),
      translation_language: preferredLanguage
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/practice/answer', async (req, res) => {
  const { word_id, correct } = req.body;
  if (!word_id || typeof correct !== 'boolean') {
    return res.status(400).json({ error: 'word_id and correct (boolean) are required.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data: word } = await supabase.from('words').select('id').eq('id', word_id).maybeSingle();
  if (!word) return res.status(404).json({ error: 'Word not found.' });

  try {
    const progress = await recordAnswer(supabase, req.user.id, word_id, correct);
    res.json({ progress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- side quests -----------------------------------------------------------
app.post('/api/side-quests/generate', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  let words;
  try {
    words = await pickWordsForUser(supabase, req.user.id, MAX_QUEST_WORDS);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (words.length === 0) {
    return res.status(400).json({ error: 'No words in the word bank yet — ask an admin to add some first.' });
  }

  let story;
  try {
    story = await generateSideQuestStory(words);
  } catch (err) {
    return res.status(502).json({ error: `Could not generate a side quest: ${err.message}` });
  }

  const withIds = attachWordIds(story, words);
  if (!withIds.quiz.length) {
    return res.status(502).json({ error: 'Could not generate a valid side quest. Try again.' });
  }

  const { count, error: countError } = await supabase
    .from('side_quests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.id);
  if (countError) return res.status(500).json({ error: countError.message });

  const { data, error } = await supabase
    .from('side_quests')
    .insert({
      user_id: req.user.id,
      sequence_number: (count || 0) + 1,
      title: withIds.title,
      setting: withIds.setting || null,
      lines: withIds.lines,
      quiz: withIds.quiz,
      word_ids: words.map((w) => w.id),
      status: 'in_progress'
    })
    .select('id, sequence_number, title, setting, lines, quiz, status, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ quest: stripQuizAnswers(data) });
});

app.get('/api/side-quests', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('side_quests')
    .select('id, sequence_number, title, status, score, created_at, completed_at')
    .eq('user_id', req.user.id)
    .order('sequence_number', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ quests: data || [] });
});

app.get('/api/side-quests/:id', async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('side_quests')
    .select('id, sequence_number, title, setting, lines, quiz, status, score, created_at, completed_at')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Side quest not found.' });
  res.json({ quest: data.status === 'completed' ? data : stripQuizAnswers(data) });
});

app.post('/api/side-quests/:id/complete', async (req, res) => {
  const { answers } = req.body;
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers array is required.' });

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data: quest, error } = await supabase
    .from('side_quests')
    .select('id, quiz, status')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!quest) return res.status(404).json({ error: 'Side quest not found.' });
  if (quest.status === 'completed') return res.status(400).json({ error: 'This side quest is already complete.' });

  const selectedByWordId = new Map(answers.map((a) => [a.word_id, a.selectedIndex]));
  const results = [];
  const gradedQuiz = [];
  let correctCount = 0;

  for (const item of quest.quiz) {
    const selectedIndex = selectedByWordId.has(item.word_id) ? selectedByWordId.get(item.word_id) : null;
    const correct = selectedIndex === item.correctIndex;
    if (correct) correctCount += 1;
    results.push({ word_id: item.word_id, word: item.word, correct, correctIndex: item.correctIndex, selectedIndex });
    gradedQuiz.push({ ...item, selectedIndex });

    try {
      await recordAnswer(supabase, req.user.id, item.word_id, correct);
    } catch (err) {
      console.warn(`Could not update progress for word ${item.word_id}:`, err.message);
    }
  }

  const score = quest.quiz.length ? Math.round((correctCount / quest.quiz.length) * 100) : 0;

  const { data: updatedQuest, error: updateError } = await supabase
    .from('side_quests')
    .update({ status: 'completed', score, completed_at: new Date().toISOString(), quiz: gradedQuiz })
    .eq('id', req.params.id)
    .select('id, sequence_number, title, setting, lines, quiz, status, score, created_at, completed_at')
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });
  res.json({ quest: updatedQuest, results, score });
});

app.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}`);
});
