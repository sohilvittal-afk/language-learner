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

module.exports = { getSupabaseClient };
