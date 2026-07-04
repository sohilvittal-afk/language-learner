require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { getSupabaseClient, getSupabaseClientForToken } = require('./lib/supabaseClient');

const VALID_ROLES = ['user', 'admin', 'super_admin'];

// Looks up this user's role in the `profiles` table (see supabase/profiles.sql),
// creating a default 'user' row on first login. Promotions to admin/super_admin
// happen manually in Supabase, never through this app.
async function resolveRole(userClient, user) {
  try {
    const { data: existing } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (existing && VALID_ROLES.includes(existing.role)) return existing.role;

    const { data: inserted } = await userClient
      .from('profiles')
      .insert({ id: user.id, email: user.email, role: 'user' })
      .select('role')
      .maybeSingle();

    return inserted && VALID_ROLES.includes(inserted.role) ? inserted.role : 'user';
  } catch (err) {
    // profiles table not set up yet, or a transient Supabase error — fall back
    // rather than blocking login over a non-critical lookup.
    console.warn('Could not resolve role from profiles table:', err.message);
    return 'user';
  }
}

const app = express();
const PORT = process.env.PORT || 4000;

// --- middleware --------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

// Registered before express.static so the auth check below actually runs —
// a static handler for /public would otherwise serve this file to anyone.
app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// --- auth routes ---------------------------------------------------
// User + password never touch our own storage — Supabase Auth owns both.
app.post('/api/register', registerLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return res.status(400).json({ error: error.message });
  }

  // With email confirmation enabled (the Supabase default), signUp succeeds
  // but no session is issued until the user clicks the confirmation link.
  res.json({ ok: true, needsConfirmation: !data.session });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (err) {
    return res.status(500).json({ error: 'Supabase is not configured on this server.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  // Same error for missing user vs wrong password — don't leak which one failed.
  if (error || !data.session) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  req.session.userId = data.user.id;
  req.session.email = data.user.email;
  req.session.role = await resolveRole(getSupabaseClientForToken(data.session.access_token), data.user);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ loggedIn: true, email: req.session.email, role: req.session.role || 'user' });
  }
  res.json({ loggedIn: false });
});

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}`);
});
