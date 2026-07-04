# Local Login App

## Set up Supabase

1. Create a project at [supabase.com](https://supabase.com) (or use an existing one).
2. Email/password auth is on by default — nothing to enable in the dashboard.
3. Copy the project URL and `anon` public key from **Settings → API**.
4. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
5. Open **SQL Editor** in your Supabase project and run `supabase/profiles.sql` once — this creates the `profiles` table that backs role-based access on the dashboard.

By default Supabase requires users to confirm their email before they can log in
(**Authentication → Providers → Email → Confirm email**). Turn that off in the
dashboard if you want to log in immediately after registering during local dev.

## Run it

```
npm install
npm start
```

Then open http://localhost:4000 (redirects to the login page)

## What's actually happening

- Registration and login go straight to Supabase Auth (`supabase.auth.signUp` /
  `signInWithPassword`) — this app never stores an email or password itself.
  Supabase hashes and stores credentials on its end; our server only ever holds
  a session pointer (the user's id) and a Supabase user id.
- Sessions are server-side (`express-session`), tied to an httpOnly cookie your JS can't read or steal via XSS.
- `/dashboard.html` is protected server-side by middleware, not by hiding a link — you can't get in by guessing the URL.
- Login and "user doesn't exist" return the identical error, so an attacker can't enumerate valid emails.
- `/api/login` and `/api/register` are rate-limited per IP (`express-rate-limit`) — 5 login attempts per 15 minutes, 10 signups per hour — so brute-forcing or spamming accounts gets a `429` instead of unlimited tries.
- Every user has a role — `user`, `admin`, or `super_admin` — stored in the `profiles` table (`supabase/profiles.sql`). A row is created automatically with role `user` the first time someone logs in. `/dashboard.html` shows different panels depending on role, and `/api/me` reports it alongside the session's email.
- Promoting someone to `admin` or `super_admin` is a manual step: open **Table Editor → profiles** in Supabase and edit their `role` column. There's no update policy on the table and no in-app way to change roles, so a user can never grant themselves (or anyone else) a higher role.

## Known gaps you should close before this touches the internet

- The session secret in `server.js` falls back to a placeholder if `SESSION_SECRET` isn't set — always set it via `.env` outside local dev.
- The rate limiter keys on IP address, which is easy to work around with rotating IPs/proxies — fine as a first line of defense, not a substitute for Supabase's own abuse protections.
- No HTTPS here — cookies marked `httpOnly` still travel in plaintext over HTTP. Fine for localhost, not fine once this leaves your machine.
- `.env` holds your Supabase keys — it's already gitignored, but double-check it never gets committed.

## Branch workflow

Three long-lived branches, one direction of travel: `dev` → `staging` → `main`.

- **`dev`** — where you test against `localhost`. Push here freely.
- **`staging`** — only ever updated by a PR from `dev`. Opened manually, merged manually.
- **`main`** — only ever updated by a PR from `staging`. Always a manual merge, never automated, so `main` stays the one branch you can trust.

Two workflows in `.github/workflows/` back this up:

- `branch-flow-guard.yml` — fails a PR into `staging` if its source isn't `dev`, and fails a PR into `main` if its source isn't `staging`. Wrong-branch merges get blocked at the check, not caught after the fact.
- `ci.yml` — installs dependencies and confirms the server actually boots, on every push/PR to `dev`, `staging`, or `main`.

For this to actually block bad merges (rather than just show a red X), turn on branch protection in **Settings → Branches** for this repo:

1. Add a rule for `main`:
   - Require a pull request before merging (require at least 1 approval if you work with others).
   - Require status checks to pass before merging → select `check-source-branch` and `smoke-test`.
   - Do not allow bypassing the above settings (applies to admins too, if you want it airtight).
2. Add the same rule for `staging`.
3. Leave `dev` unprotected, or add just the `smoke-test` check if you want early warning — it's your working branch.

With that in place, `main` can only change through a manually-reviewed PR from `staging` that has already passed CI, and `staging` can only change from `dev` the same way.