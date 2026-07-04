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