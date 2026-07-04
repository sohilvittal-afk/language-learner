require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');
const { getServiceRoleClient } = require('./lib/supabaseClient');

const VALID_ROLES = ['user', 'admin', 'super_admin'];
const BCRYPT_ROUNDS = 12;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

app.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}`);
});
