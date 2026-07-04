const { createClient } = require('@supabase/supabase-js');

let serviceClient = null;

// This app owns its own accounts (see supabase/users.sql) — there is no
// Supabase Auth session to scope requests to, so every query runs through the
// service role key, which bypasses row-level security. Created lazily so a
// server without Supabase configured can still boot and serve static pages.
function getServiceRoleClient() {
  if (serviceClient) return serviceClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  serviceClient = createClient(url, key, { auth: { persistSession: false } });
  return serviceClient;
}

module.exports = { getServiceRoleClient };
