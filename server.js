require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
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

const VALID_ROLES = ['user', 'admin', 'super_admin'];
const BCRYPT_ROUNDS = 12;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Compared against on every failed lookup so a login attempt for a
// nonexistent username takes the same time as one for a real user — without
// this, response timing would leak which usernames/emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

// Looks up this user's role in the `profiles` table (see supabase/profiles.sql),
// creating a default 'user' row if one is somehow missing (registration
// normally creates it up front). Promotions to admin/super_admin happen
// through PATCH /api/users/:id or manually in Supabase, never here.
async function resolveRole(supabase, userId) {
  try {
    const { data: existing } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (existing && VALID_ROLES.includes(existing.role)) return existing.role;

    const { data: inserted } = await supabase
      .from('profiles')
      .insert({ id: userId, role: 'user' })
      .select('role')
      .maybeSingle();

    return inserted && VALID_ROLES.includes(inserted.role) ? inserted.role : 'user';
  } catch (err) {
    console.warn('Could not resolve role from profiles table:', err.message);
    return 'user';
  }
}

const app = express();
const PORT = process.env.PORT || 4000;

// --- middleware --------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
// Raised from the default 100kb so a base64-encoded screenshot (see
// POST /api/education) fits in the request body alongside its JSON wrapper.
app.use(express.json({ limit: '6mb' }));

// Keyed per-IP: 5 login attempts / 15 min blocks brute-forcing, 10 signups / hour blocks spam accounts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this address. Try again later.' }
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-deploying-anywhere-real', // dev only
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 2 // 2 hours
  }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login.html');
}

// JSON-API counterpart to requireAuth/role checks — used by /api/users so a
// logged-out or under-privileged caller gets a 401/403 instead of a redirect.
function requireRole(minRole) {
  const minRank = VALID_ROLES.indexOf(minRole);
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    const rank = VALID_ROLES.indexOf(req.session.role || 'user');
    if (rank < minRank) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

// Registered before express.static so the auth check below actually runs —
// a static handler for /public would otherwise serve this file to anyone.
app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/words.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'words.html'));
});
app.get('/practice.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'practice.html'));
});
app.get('/side-quests.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'side-quests.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// --- auth routes ---------------------------------------------------
// This app owns its own accounts (see supabase/users.sql) — passwords are
// hashed here with bcrypt before ever reaching Supabase.
app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required.' });
  }
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, . _ - only).' });
  }
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { data: user, error } = await supabase
    .from('users')
    .insert({ username, email, password_hash: passwordHash })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username or email is already taken.' });
    }
    return res.status(500).json({ error: 'Could not create account.' });
  }

  const { error: profileError } = await supabase.from('profiles').insert({ id: user.id, role: 'user' });
  if (profileError) console.warn('Could not create profile row on register:', profileError.message);

  res.json({ ok: true });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  let { data: user } = await supabase
    .from('users')
    .select('id, username, email, password_hash')
    .eq('username', identifier)
    .maybeSingle();

  if (!user) {
    ({ data: user } = await supabase
      .from('users')
      .select('id, username, email, password_hash')
      .eq('email', identifier)
      .maybeSingle());
  }

  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

  // Same error for missing user vs wrong password — don't leak which one failed.
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: 'Invalid username/email or password.' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.email = user.email;
  req.session.role = await resolveRole(supabase, user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', async (req, res) => {
  if (req.session && req.session.userId) {
    try {
      const supabase = getServiceRoleClient();
      req.session.role = await resolveRole(supabase, req.session.userId);
    } catch (err) {
      // Supabase unreachable/unconfigured — fall back to the cached session role.
    }
    return res.json({
      loggedIn: true,
      id: req.session.userId,
      username: req.session.username,
      email: req.session.email,
      role: req.session.role || 'user'
    });
  }
  res.json({ loggedIn: false });
});

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// --- admin user management ---------------------------------------------
// Both routes run as the service role (bypasses RLS) — authorization is
// enforced here in Express, not by Supabase policies.
app.get('/api/users', requireRole('admin'), async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, username, email, created_at, profiles(role, display_name, status, notes)')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const users = (data || []).map((u) => {
    const profile = Array.isArray(u.profiles) ? u.profiles[0] : u.profiles;
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      display_name: profile ? profile.display_name : null,
      role: profile ? profile.role : 'user',
      status: profile ? profile.status : 'active',
      notes: profile ? profile.notes : null
    };
  });

  res.json({ users });
});

app.patch('/api/users/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { display_name, status, notes, role } = req.body;
  const updates = { id };

  if (display_name !== undefined) updates.display_name = display_name;
  if (notes !== undefined) updates.notes = notes;

  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'Status must be active or disabled.' });
    }
    updates.status = status;
  }

  if (role !== undefined) {
    if (req.session.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admins can change roles.' });
    }
    if (id === req.session.userId) {
      return res.status(400).json({ error: 'You cannot change your own role.' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    updates.role = role;
  }

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data: targetUser } = await supabase
    .from('users')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (!targetUser) return res.status(404).json({ error: 'User not found.' });

  const { data, error } = await supabase
    .from('profiles')
    .upsert(updates, { onConflict: 'id' })
    .select('id, role, display_name, status, notes')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// Decodes a data URL (e.g. "data:image/png;base64,...") from the Content
// Management form, validates its type/size, and uploads it to the public
// 'education-content' storage bucket (see supabase/education_content.sql).
// Returns the public URL to store in education_content.image_url.
async function uploadEducationImage(supabase, dataUrl) {
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) {
    throw new Error('Image must be a PNG, JPEG, GIF, or WEBP file.');
  }

  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image must be smaller than 4MB.');
  }

  const filePath = `${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('education-content')
    .upload(filePath, buffer, { contentType: `image/${ext}` });

  if (uploadError) throw new Error(uploadError.message);

  const { data } = supabase.storage.from('education-content').getPublicUrl(filePath);
  return data.publicUrl;
}

// --- education content ---------------------------------------------------
// Lesson posts (title, body, optional image) that super admins publish and
// every logged-in user — any role — can read. Only requireRole('super_admin')
// gates the write routes below; GET just requires being logged in.
app.get('/api/education', requireRole('user'), async (req, res) => {
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

app.post('/api/education', requireRole('super_admin'), async (req, res) => {
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
      created_by: req.session.userId
    })
    .select('id, title, body, image_url, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ post: data });
});

app.delete('/api/education/:id', requireRole('super_admin'), async (req, res) => {
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

// --- word bank -----------------------------------------------------------
// The shared vocabulary every learner draws from — for flashcard review and
// for Side Quest stories. Any logged-in user can browse it; only admins and
// super admins can add or remove words.
app.get('/api/words', requireRole('user'), async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('words')
    .select('id, term, definition, example_sentence, part_of_speech, difficulty, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ words: data || [] });
});

app.post('/api/words', requireRole('admin'), async (req, res) => {
  const { term, definition, example_sentence, part_of_speech, difficulty } = req.body;
  if (!term || !term.trim() || !definition || !definition.trim()) {
    return res.status(400).json({ error: 'Term and definition are required.' });
  }
  if (difficulty && !['easy', 'medium', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: 'Difficulty must be easy, medium, or hard.' });
  }

  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('words')
    .insert({
      term: term.trim(),
      definition: definition.trim(),
      example_sentence: example_sentence && example_sentence.trim() ? example_sentence.trim() : null,
      part_of_speech: part_of_speech && part_of_speech.trim() ? part_of_speech.trim() : null,
      difficulty: difficulty || 'medium',
      created_by: req.session.userId
    })
    .select('id, term, definition, example_sentence, part_of_speech, difficulty, created_at')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'That word is already in the bank.' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ word: data });
});

app.delete('/api/words/:id', requireRole('admin'), async (req, res) => {
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
// GET returns words due for review (or never-studied ones) — see
// pickWordsForUser in lib/learning.js. POST records a right/wrong answer and
// reschedules that word with a simplified SM-2 algorithm, so weaker words
// resurface sooner and mastered ones drift further out.
app.get('/api/practice/next', requireRole('user'), async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  try {
    const words = await pickWordsForUser(supabase, req.session.userId, 10);
    res.json({ words });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/practice/answer', requireRole('user'), async (req, res) => {
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
    const progress = await recordAnswer(supabase, req.session.userId, word_id, correct);
    res.json({ progress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- side quests -----------------------------------------------------------
// Each quest is an AI-written short conversation weaving in up to 5 words
// from the learner's word bank (see generateSideQuestStory in
// lib/learning.js), plus a short comprehension quiz. `quiz` in the DB row
// holds correct answers — stripQuizAnswers keeps those out of the response
// until the quest is completed, so it's enforced here, not just hidden by
// the UI.
app.post('/api/side-quests/generate', requireRole('user'), async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  let words;
  try {
    words = await pickWordsForUser(supabase, req.session.userId, MAX_QUEST_WORDS);
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
    .eq('user_id', req.session.userId);
  if (countError) return res.status(500).json({ error: countError.message });

  const { data, error } = await supabase
    .from('side_quests')
    .insert({
      user_id: req.session.userId,
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

app.get('/api/side-quests', requireRole('user'), async (req, res) => {
  let supabase;
  try {
    supabase = getServiceRoleClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase
    .from('side_quests')
    .select('id, sequence_number, title, status, score, created_at, completed_at')
    .eq('user_id', req.session.userId)
    .order('sequence_number', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ quests: data || [] });
});

app.get('/api/side-quests/:id', requireRole('user'), async (req, res) => {
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
    .eq('user_id', req.session.userId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Side quest not found.' });
  res.json({ quest: data.status === 'completed' ? data : stripQuizAnswers(data) });
});

app.post('/api/side-quests/:id/complete', requireRole('user'), async (req, res) => {
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
    .eq('user_id', req.session.userId)
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
      await recordAnswer(supabase, req.session.userId, item.word_id, correct);
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
