# Changelog

All notable changes to ZipLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-17

First release.

### Added

- URL shortening with random codes or custom aliases
- QR code for every link, downloadable as PNG or SVG
- Click tracking with real recorded data: referrer, device type and timestamp
- Dashboard with total links, total clicks, active links and password-protected links
- Analytics: 14-day click chart, top links, referrers and devices
- Link creation dates and optional expiration dates
- Optional password protection for individual links, hashed with bcrypt
- One-click copy for short links
- Search, status filter, sort and confirmed deletion for links
- Secure admin login with signed `HttpOnly` session cookies
- Rate limiting for logins, password attempts, link creation and general traffic
- Server-side input validation and origin checks for state-changing requests
- JSON file storage with atomic writes and no database
- `npm run setup` to create `.env` interactively, plus `npm run hash` and `npm run secret`
- Responsive dark interface for phone, tablet and desktop
- Project documentation: README, CONTRIBUTING, SECURITY and MIT license
