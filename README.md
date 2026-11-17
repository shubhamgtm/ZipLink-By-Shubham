# ZipLink

**Shorten. Share. Track.**

ZipLink is a self-hosted URL shortener built with Node.js and Express. It stores everything in plain JSON files, so there is no database to install or manage. Sign in to a clean dark dashboard, create short links, share them with QR codes, and watch real click analytics come in.

Created by **Shubham Gautam Upadhyaya** ([@ShubhamGtm_](https://github.com/shubhamgtm)) and released under the MIT License.

## Features

- Shorten any `http://` or `https://` URL
- Random short codes or your own custom alias
- QR code for every link, downloadable as PNG or SVG
- Click tracking per link, plus a dashboard with totals and analytics
- Creation date for every link
- Optional expiration date and time
- Optional password protection per link (hashed with bcrypt)
- One-click copy for short links
- Search, filter, sort and delete links
- Secure admin login, rate limiting and input validation
- No database: data lives in `data/` as JSON files
- Responsive dark interface for phone, tablet and desktop

## Requirements

- Node.js 18 or newer
- npm (included with Node.js)

## Quick start

```bash
git clone https://github.com/ShubhamGtm_/ziplink.git
cd ziplink
npm install
npm run setup
npm start
```

Open <http://localhost:3000> and sign in with the username and password you chose during setup.

`npm run setup` asks for an admin username and password, then writes a `.env` file containing the bcrypt hash of your password and a freshly generated session secret. Your plain password is never stored.

### Manual setup

If you prefer to configure things by hand:

```bash
cp .env.example .env
npm run hash -- "your-strong-password"
npm run secret
```

Copy the line printed by `npm run hash` (it starts with `ADMIN_PASSWORD_HASH=`) into `.env`, and paste the output of `npm run secret` after `SESSION_SECRET=`. Keep the single quotes around the hash, because bcrypt hashes contain `$` characters.

## Configuration

All settings come from environment variables, normally set in `.env`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD_HASH` | Yes | none | bcrypt hash of the admin password. Create it with `npm run hash`. |
| `SESSION_SECRET` | Yes | none | Random string of at least 32 characters used to sign session cookies. Create it with `npm run secret`. |
| `ADMIN_USERNAME` | No | `admin` | Admin username. |
| `PORT` | No | `3000` | Port to listen on. |
| `HOST` | No | `127.0.0.1` | Interface to bind to. Use `0.0.0.0` to allow other devices on your network. |
| `BASE_URL` | No | request address | Public address used in short links and QR codes, for example `https://zip.example.com`. No trailing path. |
| `SESSION_HOURS` | No | `12` | How long an admin session stays valid. |
| `TRUST_PROXY` | No | off | Number of reverse proxies in front of ZipLink, for example `1`. Needed for correct client IPs behind a proxy. |

ZipLink refuses to start if a required value is missing or malformed, and tells you what to fix.

## Using ZipLink

1. Paste a long URL and press **Shorten**. If you leave out `https://`, ZipLink adds it.
2. Open **Options** to set a custom alias, an expiration date and time, or a password.
3. Copy the new link with **Copy link**, or open its **QR code** to scan or download it.
4. Track results on the dashboard: total links, total clicks, active links, password-protected links, a 14-day click chart, top links, referrers and devices.
5. Use the search box, status filter and sort menu to find links in the **Recent links** table. **Delete** removes a link and its click history after confirmation.

Short links work for anyone, but creating and managing them requires the admin login.

### Behavior worth knowing

- **Expired links** show an "expired" page (HTTP 410) and no longer redirect. They stay in the table so you can review their stats, and they are counted under "Expired" instead of "Active".
- **Password-protected links** show an unlock page. The visitor is redirected only after entering the correct password, and only then is a click counted. Wrong guesses are rate limited.
- **Aliases** are 3 to 32 characters: letters, numbers, `-` and `_`. They are unique regardless of letter case, and a few names such as `api` and `admin` are reserved.
- **Self-referencing links** (a URL that points back at your own ZipLink) are rejected to prevent redirect loops.

## How analytics work

Every analytic comes from real redirects. Nothing is simulated.

For each click ZipLink records the time, the referring site (or "Direct"), and a device type guessed from the user agent (Desktop, Mobile, Tablet or Other). It does **not** store IP addresses.

Requests that are not real visits are skipped: `HEAD` requests, browser prefetches, and well-known crawlers and link-preview bots. The 14-day chart uses your browser's time zone for day boundaries.

## Data storage

| File | Contents |
| --- | --- |
| `data/links.json` | Every link: code, destination, creation date, expiration, and the bcrypt hash of its password if it has one. |
| `data/clicks.jsonl` | One JSON object per line for each recorded click. |

Files are created automatically on first use. Link changes are written atomically (temporary file, then rename), and clicks are appended. If `links.json` is damaged, ZipLink stops with an error instead of overwriting it.

To back up ZipLink, copy the `data/` folder. Stop the server before editing these files by hand.

## API

The dashboard uses a small JSON API. All endpoints except `/api/session` and `/api/login` need the session cookie that login sets. State-changing requests must be sent as `application/json`.

| Method and path | Purpose |
| --- | --- |
| `GET /api/session` | Whether you are signed in. |
| `POST /api/login` | Body `{ "username", "password" }`. Sets the session cookie. |
| `POST /api/logout` | Ends the session. Send `{}` as the body. |
| `GET /api/links` | All links, newest first, with click counts. |
| `POST /api/links` | Body `{ "url", "alias"?, "expiresAt"?, "password"? }`. `expiresAt` is an ISO 8601 date in the future. |
| `DELETE /api/links/:code` | Delete a link and its clicks. |
| `GET /api/links/:code/qr` | QR code image. Query: `format=png\|svg`, `size=128..1024`, `download=1`. |
| `GET /api/stats` | Totals, 14-day series, top links, referrers and devices. Query: `offset` (minutes from UTC). |
| `GET /health` | Returns `{ "status": "ok" }`. |

Example with curl:

```bash
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}' \
  http://localhost:3000/api/login

curl -b cookies.txt -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/some/long/path","alias":"demo"}' \
  http://localhost:3000/api/links
```

## Security

- Admin password is stored only as a bcrypt hash (12 rounds). Link passwords are bcrypt hashes too (10 rounds).
- Sessions use a random ID signed with HMAC-SHA256 in an `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` over HTTPS. Sessions live in memory, so restarting the server signs everyone out.
- Rate limits: failed logins (10 per 15 minutes per IP), wrong link passwords (10 per 15 minutes per IP), link creation (30 per minute), and a general cap on API and redirect traffic.
- Input is validated on the server: URL scheme and length, alias format, future-only expiry dates, password length, and a 10 KB limit on request bodies.
- State-changing requests are checked for a matching `Origin` and a JSON content type.
- Helmet sets a strict Content Security Policy and other security headers. The interface loads no external scripts, fonts or images.
- Secrets live in `.env`, which is ignored by git.

Use HTTPS in production. See [SECURITY.md](SECURITY.md) for the deployment checklist and how to report a vulnerability.

The password library is [`bcryptjs`](https://github.com/dcodeIO/bcrypt.js), a pure JavaScript implementation of bcrypt. Its hashes are interchangeable with native bcrypt, and it installs on every platform without a compiler.

## Deploying

ZipLink is a single Node process, so any host that runs Node works. A typical setup:

1. Run it with a process manager such as systemd or PM2, using `npm start`.
2. Put a reverse proxy with HTTPS in front of it.
3. In `.env`, set `BASE_URL=https://your.domain` and `TRUST_PROXY=1`.

Minimal nginx location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Run a single instance. Sessions are held in memory and data is stored in local files, so ZipLink is not designed to be load balanced across several processes. It suits personal and small-team use rather than very high traffic.

To reach it from another device on your network, set `HOST=0.0.0.0` and open the machine's address, for example `http://192.168.1.20:3000`.

## Project structure

```
ziplink/
├── server.js          Express app, JSON storage, auth, API, setup commands
├── package.json
├── .env.example       Template for configuration
├── .gitignore
├── public/
│   ├── index.html     Login and dashboard
│   ├── styles.css     Dark theme
│   └── app.js         Dashboard logic
├── data/              links.json and clicks.jsonl (created at runtime)
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── CHANGELOG.md
└── SECURITY.md
```

## npm scripts

| Script | What it does |
| --- | --- |
| `npm start` | Start the server. |
| `npm run dev` | Start the server and restart on file changes. |
| `npm run setup` | Create `.env` interactively. |
| `npm run hash -- "password"` | Print an `ADMIN_PASSWORD_HASH` line for a password. |
| `npm run secret` | Print a random session secret. |

## Troubleshooting

- **"ZipLink cannot start"**: the message lists exactly which `.env` values are missing or invalid. Run `npm run setup` to regenerate them.
- **Port already in use**: change `PORT` in `.env`.
- **Forgot the admin password**: run `npm run setup` again, or generate a new hash with `npm run hash` and replace `ADMIN_PASSWORD_HASH` in `.env`. Existing links are not affected.
- **Too many sign-in attempts**: wait 15 minutes, or restart the server to clear the counter.
- **Short links show `localhost`**: set `BASE_URL` to your public address.
- **Copy button does nothing on a LAN address**: browsers restrict the clipboard API on plain HTTP. ZipLink falls back to a legacy method, but HTTPS is the reliable fix.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

MIT License. Copyright (c) 2026 Shubham Gautam Upadhyaya. See [LICENSE](LICENSE).
