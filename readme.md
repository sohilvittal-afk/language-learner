# Local Login App

## Run it

```
npm install
npm start
```

Then open http://localhost:3000/login.html

## What's actually happening

- Passwords are hashed with bcrypt (12 rounds) before they ever touch disk — `users.json` never stores plaintext.
- Sessions are server-side (`express-session`), tied to an httpOnly cookie your JS can't read or steal via XSS.
- `/dashboard.html` is protected server-side by middleware, not by hiding a link — you can't get in by guessing the URL.
- Login and "user doesn't exist" return the identical error, so an attacker can't enumerate valid usernames.

## Known gaps you should close before this touches the internet

- The session secret in `server.js` is a placeholder. Replace it and load it from an environment variable.
- No rate limiting on `/api/login` — add something like `express-rate-limit` or an attacker can brute-force passwords all day.
- `users.json` is fine for local dev, not for concurrent writes at any real scale — swap to SQLite/Postgres before this is anything but a toy.
- No HTTPS here — cookies marked `httpOnly` still travel in plaintext over HTTP. Fine for localhost, not fine once this leaves your machine.

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