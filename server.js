'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Writable } = require('stream');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE_FILE = path.join(ROOT, '.env.example');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const CLICKS_FILE = path.join(DATA_DIR, 'clicks.jsonl');

require('dotenv').config({ path: ENV_FILE, quiet: true });

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

const SESSION_COOKIE = 'zl_session';
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RESERVED_ALIASES = new Set([
  'api', 'admin', 'login', 'logout', 'dashboard', 'unlock', 'qr', 'health',
  'index', 'static', 'assets', 'public', 'app', 'ziplink'
]);
const BOT_PATTERN = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slurp|headless|embedly|lighthouse/i;
const MAX_URL_LENGTH = 2048;
const LINK_PASSWORD_ROUNDS = 10;
const ADMIN_PASSWORD_ROUNDS = 12;
const DAY_MS = 86400000;
const CHART_DAYS = 14;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const LOGO_SVG =
  '<svg class="logo-mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">' +
  '<rect width="32" height="32" rx="8" fill="#7c3aed"/>' +
  '<path d="M9 10h14L9 22h14" fill="none" stroke="#22d3ee" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

let config;

const store = {
  links: [],
  byCode: new Map(),
  byId: new Map(),
  clicks: [],
  counts: new Map(),
  lastClick: new Map()
};

const sessions = new Map();

let writeChain = Promise.resolve();

function enqueue(task) {
  const run = writeChain.then(task);
  writeChain = run.catch(() => {});
  return run;
}

async function writeFileAtomic(file, contents) {
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, contents);
  await fsp.rename(temp, file);
}

function persistLinks() {
  return enqueue(() =>
    writeFileAtomic(LINKS_FILE, JSON.stringify({ version: 1, links: store.links }, null, 2))
  );
}

function persistClicks() {
  return enqueue(() => {
    const lines = store.clicks.map((event) => JSON.stringify(event)).join('\n');
    return writeFileAtomic(CLICKS_FILE, lines ? `${lines}\n` : '');
  });
}

function isStoredLink(link) {
  return (
    link &&
    typeof link.id === 'string' &&
    typeof link.code === 'string' &&
    typeof link.url === 'string' &&
    typeof link.createdAt === 'string'
  );
}

function indexLink(link) {
  store.links.push(link);
  store.byCode.set(link.code.toLowerCase(), link);
  store.byId.set(link.id, link);
}

function unindexLink(link) {
  store.links = store.links.filter((item) => item.id !== link.id);
  store.byCode.delete(link.code.toLowerCase());
  store.byId.delete(link.id);
  store.counts.delete(link.id);
  store.lastClick.delete(link.id);
  store.clicks = store.clicks.filter((event) => event.l !== link.id);
}

function indexClick(event) {
  store.clicks.push(event);
  store.counts.set(event.l, (store.counts.get(event.l) || 0) + 1);
  if (event.t > (store.lastClick.get(event.l) || 0)) store.lastClick.set(event.l, event.t);
}

async function loadStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  try {
    const parsed = JSON.parse(await fsp.readFile(LINKS_FILE, 'utf8'));
    const stored = Array.isArray(parsed.links) ? parsed.links : [];
    const valid = stored.filter(isStoredLink);
    if (valid.length !== stored.length) {
      console.warn(`Ignored ${stored.length - valid.length} malformed link record(s) in data/links.json`);
    }
    valid.forEach(indexLink);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Cannot read data/links.json (${err.message}). Fix or move the file and start again.`);
    }
  }

  let raw = '';
  try {
    raw = await fsp.readFile(CLICKS_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (store.byId.has(event.l) && Number.isFinite(event.t)) indexClick(event);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (skipped) console.warn(`Skipped ${skipped} unreadable or orphaned click record(s) in data/clicks.jsonl`);
}

function loadConfig() {
  const env = process.env;
  const errors = [];

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT must be a whole number between 1 and 65535.');
  }

  let baseUrl = '';
  if (env.BASE_URL && env.BASE_URL.trim()) {
    try {
      const url = new URL(env.BASE_URL.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('invalid');
      }
      baseUrl = url.origin;
    } catch {
      errors.push('BASE_URL must be a plain address such as https://zip.example.com (no path).');
    }
  }

  const adminUsername = (env.ADMIN_USERNAME || 'admin').trim();
  if (!adminUsername || adminUsername.length > 64) {
    errors.push('ADMIN_USERNAME must be between 1 and 64 characters.');
  }

  const adminHash = (env.ADMIN_PASSWORD_HASH || '').trim();
  if (!BCRYPT_HASH_PATTERN.test(adminHash)) {
    errors.push('ADMIN_PASSWORD_HASH is missing or is not a valid bcrypt hash.');
  }

  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) {
    errors.push('SESSION_SECRET must be at least 32 characters long.');
  }

  const sessionHours = Number(env.SESSION_HOURS || 12);
  if (!Number.isFinite(sessionHours) || sessionHours < 1 || sessionHours > 720) {
    errors.push('SESSION_HOURS must be a number between 1 and 720.');
  }

  let trustProxy = false;
  if (env.TRUST_PROXY && env.TRUST_PROXY.trim()) {
    const hops = Number(env.TRUST_PROXY);
    if (!Number.isInteger(hops) || hops < 0) errors.push('TRUST_PROXY must be a whole number such as 1.');
    else trustProxy = hops;
  }

  if (errors.length) {
    const missingEnvFile = !fs.existsSync(ENV_FILE);
    console.error('\nZipLink cannot start:\n');
    errors.forEach((message) => console.error(`  - ${message}`));
    console.error(
      missingEnvFile
        ? '\nNo .env file found. Run "npm run setup" to create one.\n'
        : '\nFix the values in .env or run "npm run setup" to create a new one.\n'
    );
    process.exit(1);
  }

  return {
    port,
    host: env.HOST || '127.0.0.1',
    baseUrl,
    adminUsername,
    adminHash,
    sessionSecret,
    sessionMs: sessionHours * 3600000,
    trustProxy
  };
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function safeEqual(a, b) {
  const first = crypto.createHash('sha256').update(String(a)).digest();
  const second = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(first, second);
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function baseUrlFor(req) {
  return config.baseUrl || `${req.protocol}://${req.get('host')}`;
}

function isExpired(link, now = Date.now()) {
  return Boolean(link.expiresAt) && Date.parse(link.expiresAt) <= now;
}

function serializeLink(link, req) {
  const last = store.lastClick.get(link.id);
  return {
    id: link.id,
    code: link.code,
    url: link.url,
    shortUrl: `${baseUrlFor(req)}/${link.code}`,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt || null,
    expired: isExpired(link),
    protected: Boolean(link.passwordHash),
    custom: Boolean(link.custom),
    clicks: store.counts.get(link.id) || 0,
    lastClickedAt: last ? new Date(last).toISOString() : null
  };
}

function generateCode() {
  for (let length = 6; length <= 10; length++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = '';
      for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!store.byCode.has(code) && !RESERVED_ALIASES.has(code)) return code;
    }
  }
  throw new Error('Could not generate a unique short code.');
}

function parseTarget(value, req) {
  if (typeof value !== 'string' || !value.trim()) return { error: 'Enter the URL you want to shorten.' };
  const raw = value.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: `URLs can be at most ${MAX_URL_LENGTH} characters long.` };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'That does not look like a valid URL. Include http:// or https://.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only http:// and https:// URLs can be shortened.' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'URLs that contain a username or password are not allowed.' };
  }

  const ownHosts = [req.get('host'), config.baseUrl && new URL(config.baseUrl).host]
    .filter(Boolean)
    .map((host) => host.toLowerCase());
  if (ownHosts.includes(parsed.host.toLowerCase())) {
    return { error: 'You cannot shorten a link that points back to this ZipLink.' };
  }

  return { value: parsed.href };
}

function parseAlias(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Alias must be text.' };
  const alias = value.trim();
  if (!alias) return { value: null };
  if (!ALIAS_PATTERN.test(alias)) {
    return { error: 'Alias must be 3 to 32 characters: letters, numbers, hyphens or underscores.' };
  }
  if (RESERVED_ALIASES.has(alias.toLowerCase())) {
    return { error: 'That alias is reserved. Please choose another one.' };
  }
  return { value: alias };
}

function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Choose a valid expiration date and time.' };
  const time = Date.parse(value);
  if (Number.isNaN(time)) return { error: 'Choose a valid expiration date and time.' };
  if (time <= Date.now()) return { error: 'The expiration date must be in the future.' };
  return { value: new Date(time).toISOString() };
}

function parsePassword(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Password must be text.' };
  if (value.length < 4 || value.length > 128) return { error: 'Link passwords must be 4 to 128 characters long.' };
  return { value };
}

function validateCreate(body, req) {
  const data = body && typeof body === 'object' ? body : {};
  const checks = [
    ['url', parseTarget(data.url, req)],
    ['alias', parseAlias(data.alias)],
    ['expiresAt', parseExpiry(data.expiresAt)],
    ['password', parsePassword(data.password)]
  ];
  for (const [field, result] of checks) {
    if (result.error) return { error: result.error, field };
  }
  const [url, alias, expiresAt, password] = checks.map(([, result]) => result.value);
  return { value: { url, alias, expiresAt, password } };
}

function referrerOf(req) {
  const header = req.get('referer');
  if (!header) return 'Direct';
  try {
    const host = new URL(header).hostname.replace(/^www\./, '');
    return host ? host.slice(0, 100) : 'Direct';
  } catch {
    return 'Direct';
  }
}

function deviceOf(userAgent) {
  if (/ipad|tablet|kindle|silk/i.test(userAgent) || (/android/i.test(userAgent) && !/mobile/i.test(userAgent))) {
    return 'Tablet';
  }
  if (/mobi|iphone|ipod|android/i.test(userAgent)) return 'Mobile';
  if (/windows|macintosh|linux|cros|x11/i.test(userAgent)) return 'Desktop';
  return 'Other';
}

function recordClick(link, req) {
  if (req.method === 'HEAD') return;
  if (/prefetch|prerender/i.test(req.get('sec-purpose') || req.get('purpose') || '')) return;
  const userAgent = req.get('user-agent') || '';
  if (BOT_PATTERN.test(userAgent)) return;

  const event = { l: link.id, t: Date.now(), r: referrerOf(req), d: deviceOf(userAgent) };
  indexClick(event);
  enqueue(() => fsp.appendFile(CLICKS_FILE, `${JSON.stringify(event)}\n`)).catch((err) => {
    console.error('Could not save click:', err.message);
  });
}

function rank(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, clicks]) => ({ name, clicks }));
}

function buildStats(req, offsetMinutes) {
  const now = Date.now();
  const shift = offsetMinutes * 60000;
  const today = Math.floor((now + shift) / DAY_MS);
  const daily = new Array(CHART_DAYS).fill(0);
  const referrers = new Map();
  const devices = new Map();

  for (const event of store.clicks) {
    const index = CHART_DAYS - 1 - (today - Math.floor((event.t + shift) / DAY_MS));
    if (index >= 0 && index < CHART_DAYS) daily[index]++;
    referrers.set(event.r, (referrers.get(event.r) || 0) + 1);
    devices.set(event.d, (devices.get(event.d) || 0) + 1);
  }

  const expired = store.links.filter((link) => isExpired(link, now)).length;
  const topLinks = store.links
    .map((link) => ({ link, clicks: store.counts.get(link.id) || 0 }))
    .filter((entry) => entry.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5)
    .map(({ link, clicks }) => ({ code: link.code, url: link.url, shortUrl: `${baseUrlFor(req)}/${link.code}`, clicks }));

  return {
    totals: {
      links: store.links.length,
      clicks: store.clicks.length,
      active: store.links.length - expired,
      expired,
      protected: store.links.filter((link) => link.passwordHash).length
    },
    daily: daily.map((clicks, i) => ({
      date: new Date((today - (CHART_DAYS - 1) + i) * DAY_MS).toISOString().slice(0, 10),
      clicks
    })),
    topLinks,
    referrers: rank(referrers, 5),
    devices: rank(devices, 5)
  };
}

function signSession(id) {
  return crypto.createHmac('sha256', config.sessionSecret).update(id).digest('base64url');
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function currentSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const [id, signature] = token.split('.');
  if (!id || !signature || !safeEqual(signature, signSession(id))) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expires <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

function cookieOptions(req, maxAge) {
  const options = {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || config.baseUrl.startsWith('https://'),
    path: '/'
  };
  if (maxAge !== undefined) options.maxAge = maxAge;
  return options;
}

function requireAuth(req, res, next) {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.session = session;
  next();
}

function originGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin) {
    const allowed = [req.get('host'), config.baseUrl && new URL(config.baseUrl).host];
    if (config.trustProxy !== false) allowed.push(req.get('x-forwarded-host'));
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || !allowed.filter(Boolean).includes(originHost)) {
      return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }
  }

  if (req.method !== 'DELETE' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Requests must be sent as JSON.' });
  }
  next();
}

function renderPage(res, status, title, body) {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<title>${esc(title)} - ZipLink</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="gate-page">
<main class="gate">
<div class="brand">${LOGO_SVG}<span>ZipLink</span></div>
<section class="card gate-card">
${body}
</section>
</main>
</body>
</html>`);
}

function notFoundPage(res) {
  renderPage(res, 404, 'Link not found', '<h1>Link not found</h1><p class="muted">This short link does not exist or has been deleted.</p>');
}

function expiredPage(res) {
  renderPage(res, 410, 'Link expired', '<h1>This link has expired</h1><p class="muted">The owner set an expiration date and it has passed.</p>');
}

function unlockPage(res, link, error) {
  const message = error ? `<p class="form-error" role="alert">${esc(error)}</p>` : '';
  renderPage(
    res,
    error ? 401 : 200,
    'Protected link',
    `<h1>This link is protected</h1>
<p class="muted">Enter the password to continue.</p>
<form method="post" action="/${esc(link.code)}/unlock" class="stack">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="off" maxlength="128" required autofocus>
${message}
<button class="btn btn-primary" type="submit">Unlock link</button>
</form>`
  );
}

function limiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      if (req.originalUrl.startsWith('/api')) return res.status(429).json({ error: message });
      return renderPage(res, 429, 'Too many requests', `<h1>Slow down</h1><p class="muted">${esc(message)}</p>`);
    }
  });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"]
        }
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
    })
  );

  const apiLimiter = limiter({ windowMs: 60000, limit: 300, message: 'Too many requests. Please wait a moment.' });
  const loginLimiter = limiter({
    windowMs: 15 * 60000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: 'Too many failed sign-in attempts. Try again in 15 minutes.'
  });
  const createLimiter = limiter({ windowMs: 60000, limit: 30, message: 'You are creating links too quickly. Please wait a minute.' });
  const redirectLimiter = limiter({ windowMs: 60000, limit: 300, message: 'Too many requests. Please try again shortly.' });
  const unlockLimiter = limiter({
    windowMs: 15 * 60000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: 'Too many wrong passwords. Try again in 15 minutes.'
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api', apiLimiter, originGuard, express.json({ limit: '10kb' }));

  app.get('/api/session', (req, res) => {
    const session = currentSession(req);
    res.json(session ? { authenticated: true, username: session.user } : { authenticated: false });
  });

  app.post('/api/login', loginLimiter, asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (
      typeof username !== 'string' || typeof password !== 'string' ||
      !username || !password || username.length > 64 || password.length > 256
    ) {
      return res.status(400).json({ error: 'Enter your username and password.' });
    }

    const passwordOk = await bcrypt.compare(password, config.adminHash);
    const usernameOk = safeEqual(username, config.adminUsername);
    if (!passwordOk || !usernameOk) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { user: config.adminUsername, expires: Date.now() + config.sessionMs });
    res.cookie(SESSION_COOKIE, `${id}.${signSession(id)}`, cookieOptions(req, config.sessionMs));
    res.json({ authenticated: true, username: config.adminUsername });
  }));

  app.post('/api/logout', (req, res) => {
    const session = currentSession(req);
    if (session) sessions.delete(session.id);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  app.get('/api/links', requireAuth, (req, res) => {
    const links = store.links.slice().reverse().map((link) => serializeLink(link, req));
    res.json({ links });
  });

  app.post('/api/links', requireAuth, createLimiter, asyncHandler(async (req, res) => {
    const result = validateCreate(req.body, req);
    if (result.error) return res.status(400).json({ error: result.error, field: result.field });
    const { url, alias, expiresAt, password } = result.value;

    const passwordHash = password ? await bcrypt.hash(password, LINK_PASSWORD_ROUNDS) : null;

    if (alias && store.byCode.has(alias.toLowerCase())) {
      return res.status(409).json({ error: 'That alias is already taken.', field: 'alias' });
    }

    const link = {
      id: crypto.randomUUID(),
      code: alias || generateCode(),
      url,
      createdAt: new Date().toISOString(),
      expiresAt,
      passwordHash,
      custom: Boolean(alias)
    };

    indexLink(link);
    try {
      await persistLinks();
    } catch (err) {
      unindexLink(link);
      throw err;
    }
    res.status(201).json(serializeLink(link, req));
  }));

  app.delete('/api/links/:code', requireAuth, asyncHandler(async (req, res) => {
    const link = store.byCode.get(req.params.code.toLowerCase());
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    const hadClicks = (store.counts.get(link.id) || 0) > 0;
    unindexLink(link);
    await persistLinks();
    if (hadClicks) await persistClicks();
    res.status(204).end();
  }));

  app.get('/api/links/:code/qr', requireAuth, asyncHandler(async (req, res) => {
    const link = store.byCode.get(req.params.code.toLowerCase());
    if (!link) return res.status(404).json({ error: 'Link not found.' });

    const format = req.query.format === 'svg' ? 'svg' : 'png';
    const size = Math.min(Math.max(Number.parseInt(req.query.size, 10) || 320, 128), 1024);
    const text = `${baseUrlFor(req)}/${link.code}`;
    const options = {
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#0b0d12', light: '#ffffff' }
    };

    if (req.query.download === '1') {
      res.attachment(`ziplink-${link.code}.${format}`);
    }
    res.set('Cache-Control', 'private, max-age=300');

    if (format === 'svg') {
      const svg = await QRCode.toString(text, { ...options, type: 'svg' });
      return res.type('image/svg+xml').send(svg);
    }
    const png = await QRCode.toBuffer(text, { ...options, type: 'png', width: size });
    return res.type('image/png').send(png);
  }));

  app.get('/api/stats', requireAuth, (req, res) => {
    const offset = Math.min(Math.max(Number.parseInt(req.query.offset, 10) || 0, -840), 840);
    res.json(buildStats(req, offset));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(PUBLIC_DIR, { maxAge: '10m' }));

  app.get('/:code', redirectLimiter, (req, res, next) => {
    if (!ALIAS_PATTERN.test(req.params.code)) return next();
    const link = store.byCode.get(req.params.code.toLowerCase());
    if (!link) return notFoundPage(res);
    if (isExpired(link)) return expiredPage(res);
    if (link.passwordHash) return unlockPage(res, link);

    recordClick(link, req);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, link.url);
  });

  app.post('/:code/unlock', unlockLimiter, express.urlencoded({ extended: false, limit: '2kb' }), asyncHandler(async (req, res, next) => {
    if (!ALIAS_PATTERN.test(req.params.code)) return next();
    const link = store.byCode.get(req.params.code.toLowerCase());
    if (!link) return notFoundPage(res);
    if (isExpired(link)) return expiredPage(res);
    if (!link.passwordHash) return res.redirect(303, `/${link.code}`);

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const matches = password && (await bcrypt.compare(password, link.passwordHash));
    if (!matches) return unlockPage(res, link, 'Incorrect password. Please try again.');

    recordClick(link, req);
    res.set('Cache-Control', 'no-store');
    res.redirect(303, link.url);
  }));

  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found.' });
    return notFoundPage(res);
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    console.error(err);
    if (req.originalUrl.startsWith('/api')) return res.status(500).json({ error: 'Something went wrong on the server.' });
    return renderPage(res, 500, 'Server error', '<h1>Something went wrong</h1><p class="muted">Please try again in a moment.</p>');
  });

  return app;
}

async function start() {
  config = loadConfig();
  await loadStore();

  const app = createApp();
  const server = app.listen(config.port, config.host);

  server.on('listening', () => {
    const shownHost = ['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host;
    console.log(`ZipLink is running at ${config.baseUrl || `http://${shownHost}:${config.port}`}`);
    console.log(`Admin username: ${config.adminUsername}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Change PORT in .env and try again.`);
    else console.error(err);
    process.exit(1);
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  }, 10 * 60000).unref();

  const shutdown = () => {
    server.close();
    writeChain.finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    }
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();

  return {
    async ask(label, { hidden = false } = {}) {
      process.stdout.write(label);
      muted = hidden;
      const { value } = await lines.next();
      muted = false;
      if (hidden) process.stdout.write('\n');
      const text = value || '';
      return hidden ? text : text.trim();
    },
    close() {
      rl.close();
    }
  };
}

async function setupCommand() {
  const prompt = createPrompter();
  try {
    console.log('\nZipLink setup\n');

    if (fs.existsSync(ENV_FILE)) {
      const answer = (await prompt.ask('A .env file already exists. Replace it? (y/N) ')).toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Nothing was changed.');
        return;
      }
    }

    let username = '';
    while (!username) {
      const entered = (await prompt.ask('Admin username [admin]: ')) || 'admin';
      if (/^[\w.@-]{1,64}$/.test(entered)) username = entered;
      else console.log('Use up to 64 letters, numbers, dots, dashes, underscores or @.');
    }

    let password = '';
    while (!password) {
      const first = await prompt.ask('Admin password (at least 10 characters): ', { hidden: true });
      if (first.length < 10) {
        console.log('The password must be at least 10 characters long.');
        continue;
      }
      const second = await prompt.ask('Repeat the password: ', { hidden: true });
      if (first !== second) {
        console.log('The passwords did not match. Try again.');
        continue;
      }
      password = first;
    }

    const hash = await bcrypt.hash(password, ADMIN_PASSWORD_ROUNDS);
    const secret = crypto.randomBytes(32).toString('hex');
    const template = await fsp.readFile(ENV_EXAMPLE_FILE, 'utf8');
    const contents = template
      .replace(/^ADMIN_USERNAME=.*$/m, () => `ADMIN_USERNAME=${username}`)
      .replace(/^ADMIN_PASSWORD_HASH=.*$/m, () => `ADMIN_PASSWORD_HASH='${hash}'`)
      .replace(/^SESSION_SECRET=.*$/m, () => `SESSION_SECRET=${secret}`);

    await fsp.writeFile(ENV_FILE, contents, { mode: 0o600 });
    console.log('\nDone. Your settings were saved to .env.');
    console.log('Start ZipLink with: npm start\n');
  } finally {
    prompt.close();
  }
}

async function hashCommand() {
  const index = process.argv.indexOf('--hash');
  let password = process.argv[index + 1];

  if (!password) {
    const prompt = createPrompter();
    try {
      password = await prompt.ask('Password to hash: ', { hidden: true });
    } finally {
      prompt.close();
    }
  }
  if (!password) {
    console.error('No password given.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, ADMIN_PASSWORD_ROUNDS);
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
}

const command = process.argv.includes('--setup')
  ? setupCommand
  : process.argv.includes('--hash')
    ? hashCommand
    : start;

command().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
