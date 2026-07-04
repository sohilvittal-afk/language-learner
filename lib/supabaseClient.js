const { createClient } = require('@supabase/supabase-js');

let client = null;

// Created lazily so a server without Supabase configured can still boot and
// serve static pages — only the auth routes need this to succeed.
function getSupabaseClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }

  client = createClient(url, key);
  return client;
}

// Per-request client scoped to one user's access token, so Supabase's row-level
// security (auth.uid()) evaluates as that user instead of the shared anon client.
function getSupabaseClientForToken(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

module.exports = { getSupabaseClient, getSupabaseClientForToken };
