# Local Login App

## Set up Supabase

This app does not use Supabase Auth — it manages its own accounts in two tables
and talks to Supabase only through the service role key (RLS is enabled on
both tables with zero policies, so nothing gets in except via that key).

1. Create a project at [supabase.com](https://supabase.com) (or use an existing one).
2. Copy the project URL and the **service_role** secret key from **Settings → API**.
3. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Also set `MOONSHOT_API_KEY` (from [platform.moonshot.ai](https://platform.moonshot.ai)) if you want Side Quests to work — everything else runs fine without it.
4. Open **SQL Editor** in your Supabase project and run, in order:
   1. `supabase/users.sql` — creates the `users` table (username, email, bcrypt password hash).
   2. `supabase/profiles.sql` — creates the `profiles` table (role, display name, status, notes), linked 1:1 to `users`.
   3. `supabase/education_content.sql` — creates the `education_content` table and a public `education-content` storage bucket for lesson images/screenshots.
   4. `supabase/words.sql` — creates the `words` table, the shared vocabulary bank.
   5. `supabase/user_word_progress.sql` — creates `user_word_progress`, each learner's spaced-repetition record per word.
   6. `supabase/side_quests.sql` — creates `side_quests`, the AI-generated story + quiz journey entries.
   7. `supabase/word_translations.sql` — adds `words.language` and `profiles.preferred_language`, and creates `word_translations`, the per-language cache of AI word translations. Safe to run on an existing database — it's all idempotent alters/creates.
   8. `supabase/words_grammar_forms.sql` — adds `words.grammar_forms`, the AI-filled grammar forms. Only needed if your `words` table predates this column; fresh installs get it from `words.sql`.

## Run it

```
npm install
npm start
```

While developing, use `npm run dev` instead — it runs Node in watch mode, restarting the server automatically whenever `server.js`, anything in `lib/`, or `.env` changes. Pages in `public/` never need a restart either way; they're read from disk on every request, so a browser reload is enough.

Then open http://localhost:4000 (redirects to the login page)

## What's actually happening

- Registration and login are handled entirely by this app. Passwords are
  hashed with bcrypt (`bcryptjs`, 12 rounds) in `server.js` before being
  written to the `users` table's `password_hash` column — plaintext and
  reversible encryption are never used, and Supabase never sees the raw
  password.
- Login accepts either username or email, looked up in two separate `eq()`
  queries (not a single interpolated `.or()` filter) to keep the identifier
  out of any hand-built filter string.
- A failed login always runs `bcrypt.compare` once — against the real hash if
  the account exists, against a fixed dummy hash if it doesn't — so response
  timing doesn't leak which usernames/emails are registered. The error message
  is identical either way, too.
- Sessions are server-side (`express-session`), tied to an httpOnly cookie your JS can't read or steal via XSS.
- `/dashboard.html` is protected server-side by middleware, not by hiding a link — you can't get in by guessing the URL.
- `/api/login` and `/api/register` are rate-limited per IP (`express-rate-limit`) — 5 login attempts per 15 minutes, 10 signups per hour — so brute-forcing or spamming accounts gets a `429` instead of unlimited tries.
- Every user has a role — `user`, `admin`, or `super_admin` — plus `display_name`, `status` (`active`/`disabled`), and `notes`, all stored in the `profiles` table, linked 1:1 to `users`. A row is created at registration (with a lazy-create fallback on login, in case one is ever missing). `/dashboard.html` shows different panels depending on role, and `/api/me` reports it alongside the session's username/email.
- Admins and super admins see a **User Management** panel on the dashboard, backed by `GET /api/users` (joins `users` + `profiles`) and `PATCH /api/users/:id`. Both routes check the caller's role in Express (`requireRole`) before touching Supabase — there's no RLS policy backing this up, since there's no Supabase Auth session for RLS to key off of, so this authorization check is the only gate and needs to stay correct.
  - Admins can edit any user's `display_name` and `status`.
  - Only super admins can change `role`, and a super admin can't change their own role (avoids locking yourself out).
  - Promoting the *first* super admin still has to happen manually: open **Table Editor → profiles** in Supabase and edit the `role` column directly, since there's no one with super-admin rights yet to do it through the app.
- Every logged-in user (any role) sees an **Education** panel listing lesson posts (title, description, optional image). Super admins additionally see a **Content Management** panel to publish, attach an image/screenshot to, and delete those posts — backed by `GET/POST /api/education` and `DELETE /api/education/:id`. Images are sent from the browser as a base64 data URL, validated and uploaded server-side (via the service role key) to the public `education-content` Supabase Storage bucket, capped at 4MB.
- The top bar (`public/nav.js`) is on every page after login, with hover dropdown menus (**Learn** → Practice/Side Quests/Word Bank, **Manage** for admins+) — see `supabase/words.sql`, `supabase/user_word_progress.sql`, `supabase/side_quests.sql`.
- **Word Bank** (`words.html`, `GET/POST/DELETE /api/words`) is the shared vocabulary every learner draws from. Anyone logged in can browse it; admins and super admins can add or remove words. Adding a word only takes the **term** and **which language the word is in** (English, Dutch, German, etc.; the list lives in `lib/translation.js`) — the AI (Kimi, via `lib/enrichment.js`) fills in the definition, part of speech, example sentence, difficulty, and part-of-speech specific grammar forms: **imperfectum + perfectum** for verbs, **article + plural** for nouns, **comparative + superlative** for adjectives, stored in `words.grammar_forms` and shown on the word cards and Practice flashcards. This means adding words requires `MOONSHOT_API_KEY` to be set.
- **Translations**: every learner picks a preferred language on the **Profile** page (`profile.html`, `GET/PATCH /api/profile`, stored in `profiles.preferred_language`), and the Word Bank and Practice flashcards show each word translated into that language. Translations are generated by Kimi in one batched call (`lib/translation.js`) the first time any user needs a given word in a given language, then cached in the `word_translations` table — so changing your language re-translates the bank once, not on every page load. If `MOONSHOT_API_KEY` isn't set, everything still works; words just appear without translations. Words already in your preferred language skip translation entirely.
- **Practice** (`practice.html`, `GET /api/practice/next`, `POST /api/practice/answer`) is flashcard review driven by a simplified SM-2 spaced-repetition algorithm (`lib/learning.js`): each right/wrong answer adjusts an ease factor and reschedules the word's `next_review_at` in `user_word_progress`, so struggled-with words resurface sooner and mastered ones drift further out. A word with no progress row yet counts as immediately due, so new words get introduced automatically.
- **Side Quests** (`side-quests.html`, `POST /api/side-quests/generate`, `GET /api/side-quests[/:id]`, `POST /api/side-quests/:id/complete`) is a journey map of AI-generated short conversations. Each quest calls Kimi (Moonshot AI, default model `kimi-k2-turbo-preview`, overridable via `KIMI_MODEL`/`KIMI_BASE_URL`) through its OpenAI-compatible `/chat/completions` endpoint (`lib/kimiClient.js`, plain `fetch`, JSON mode) to weave up to 5 of the learner's due/new words into a short story with a per-word comprehension quiz; the response shape is validated server-side before storing. Completing a quest grades the quiz and feeds each word's result back into the same spaced-repetition system as Practice. Correct quiz answers are stripped from the API response until a quest is completed, so the check is enforced server-side.

## Known gaps you should close before this touches the internet

- Rolling your own auth means you now own everything Supabase Auth used to give you for free: no password-reset/forgot-password flow exists, no email verification, no breach-password checking, no built-in abuse detection beyond the IP rate limiter below. Worth weighing before this goes further.
- The session secret in `server.js` falls back to a placeholder if `SESSION_SECRET` isn't set — always set it via `.env` outside local dev.
- The rate limiter keys on IP address, which is easy to work around with rotating IPs/proxies.
- No HTTPS here — cookies marked `httpOnly` still travel in plaintext over HTTP, and so does the password on its way to `/api/login`/`/api/register`. Fine for localhost, not fine once this leaves your machine.
- `.env` holds your Supabase service role key — it bypasses row-level security entirely and is already gitignored, but double-check it never gets committed or logged.

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