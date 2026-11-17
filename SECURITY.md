# Security Policy

## Supported versions

Security fixes are applied to the latest release.

| Version | Supported |
| --- | --- |
| 1.x | Yes |

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub:

<https://github.com/ShubhamGtm_/ziplink/security/advisories/new>

Include:

- A description of the problem and its impact
- Steps to reproduce, or a proof of concept
- The ZipLink version and your Node.js version
- Any suggested fix

You can expect an acknowledgement within a few days. Valid reports are fixed as quickly as possible, and you will be credited in the changelog unless you prefer to stay anonymous. Please give a reasonable amount of time to release a fix before sharing details publicly.

## Scope

In scope: authentication and session handling, input validation, redirect behavior, password-protected links, the JSON API, and the stored data format.

Out of scope: problems that require an attacker to already control the server, the `.env` file or the `data/` folder, and issues in third-party packages that have not been fixed upstream (report those to the package maintainers).

## Deployment checklist

ZipLink ships with sensible defaults, but safe operation also depends on how you run it.

- Serve it over HTTPS and set `BASE_URL` to the `https://` address.
- Choose a strong admin password. `npm run setup` requires at least 10 characters.
- Keep `.env` private. It is listed in `.gitignore`, and `npm run setup` creates it readable only by you. Never commit it.
- Generate `SESSION_SECRET` randomly, with at least 32 characters, and rotate it if you suspect exposure. Rotating it signs everyone out.
- Set `TRUST_PROXY` to the exact number of reverse proxies in front of ZipLink. Leave it unset when there is none, otherwise clients could spoof their IP address and weaken rate limiting.
- Bind to `127.0.0.1` (the default) unless other devices must reach the server directly.
- Back up the `data/` folder and restrict access to it, because `links.json` contains password hashes for protected links.
- Keep Node.js and dependencies up to date, and run `npm audit` regularly.

## Design notes

- Passwords, for both the admin and individual links, are stored only as bcrypt hashes.
- Session cookies are `HttpOnly` and `SameSite=Strict`, and `Secure` over HTTPS. Sessions are kept in memory and expire after `SESSION_HOURS`.
- Rate limiting and input validation apply on the server. Client-side checks exist only for convenience.
- Short links can only be created by the signed-in admin, and only `http://` and `https://` destinations are accepted.
- IP addresses are not stored with click records.
