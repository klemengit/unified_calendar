import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import {
  config,
  isGoogleConfigured,
  isMicrosoftConfigured,
} from './src/config.js';
import passport from './src/passport.js';
import { getUnifiedEvents } from './src/calendar.js';
import {
  loadFeeds,
  getFeeds,
  publicFeeds,
  addFeed,
  removeFeed,
  updateFeed,
  feedCount,
  loadSettings,
  getSettings,
  updateSettings,
  updateProvider,
} from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Load persisted ICS subscriptions and settings from disk on startup.
loadFeeds();
loadSettings();

// A small palette assigned to ICS feeds in order (after the reserved
// blue=Outlook / green=Google).
const ICS_PALETTE = ['#9333ea', '#ea580c', '#0891b2', '#db2777', '#ca8a04'];

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  })
);
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, 'public')));

// Remember where to send the user after the OAuth round-trip.
const rememberReturn = (req, res, next) => {
  req.session.returnTo = req.query.return === 'settings' ? '/settings.html' : '/';
  next();
};
const finishAuth = (req, res) => {
  const dest = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(dest);
};
const failTo = (req) => `${req.session.returnTo || '/'}?error=`;

// ── Microsoft OAuth ──
app.get(
  '/auth/microsoft',
  rememberReturn,
  passport.authenticate('microsoft', { session: false, prompt: 'select_account' })
);
app.get(
  '/auth/microsoft/callback',
  (req, res, next) =>
    passport.authenticate('microsoft', {
      session: false,
      failureRedirect: `${failTo(req)}microsoft`,
    })(req, res, next),
  finishAuth
);

// ── Google OAuth ──
app.get(
  '/auth/google',
  rememberReturn,
  passport.authenticate('google', {
    session: false,
    accessType: 'offline', // request a refresh token
    prompt: 'consent select_account',
  })
);
app.get(
  '/auth/google/callback',
  (req, res, next) =>
    passport.authenticate('google', {
      session: false,
      failureRedirect: `${failTo(req)}google`,
    })(req, res, next),
  finishAuth
);

// ── Session / status ──
app.get('/api/me', (req, res) => {
  const tokens = req.session.tokens || {};
  res.json({
    configured: {
      microsoft: isMicrosoftConfigured(),
      google: isGoogleConfigured(),
    },
    connected: {
      microsoft: tokens.microsoft
        ? { name: tokens.microsoft.name, email: tokens.microsoft.email }
        : null,
      google: tokens.google
        ? { name: tokens.google.name, email: tokens.google.email }
        : null,
    },
  });
});

// ── Settings (persisted to disk) ──
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  res.json(updateSettings(req.body || {}));
});

// Per-provider color + visibility (Outlook / Google).
app.put('/api/providers/:provider', (req, res) => {
  const result = updateProvider(req.params.provider, req.body || {});
  if (!result) return res.status(404).json({ error: 'Unknown provider' });
  res.json(result);
});

// ── Calendars list ──
// Unified list of "calendars" (connected OAuth providers + ICS feeds) used by
// the sidebar to show/hide and recolor each source.
app.get('/api/calendars', (req, res) => {
  const tokens = req.session.tokens || {};
  const { providers } = getSettings();
  const calendars = [];
  if (tokens.microsoft) {
    calendars.push({
      id: 'microsoft',
      kind: 'provider',
      name: tokens.microsoft.email || tokens.microsoft.name || 'Outlook',
      color: providers.microsoft.color,
      visible: providers.microsoft.visible !== false,
    });
  }
  if (tokens.google) {
    calendars.push({
      id: 'google',
      kind: 'provider',
      name: tokens.google.email || tokens.google.name || 'Google',
      color: providers.google.color,
      visible: providers.google.visible !== false,
    });
  }
  for (const f of getFeeds()) {
    const u = f.url || '';
    const webCalBase = u.includes('calendar.google.com') ? 'google'
      : (u.includes('outlook.office365.com') || u.includes('outlook.office.com') || u.includes('outlook.live.com')) ? 'outlook'
      : null;
    calendars.push({ id: f.id, kind: 'ics', name: f.name, color: f.color, visible: f.visible !== false, webCalBase });
  }
  res.json({ calendars });
});

// ── ICS subscriptions (no login, persisted to disk) ──
app.get('/api/ics', (req, res) => {
  res.json({ feeds: publicFeeds() });
});

app.post('/api/ics', (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url) && !/^webcal:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Provide a valid http(s):// or webcal:// .ics URL' });
  }
  // webcal:// is just http(s):// for fetching purposes.
  const normalizedUrl = url.replace(/^webcal:\/\//i, 'https://');
  const color = ICS_PALETTE[feedCount() % ICS_PALETTE.length];
  const feed = addFeed({ url: normalizedUrl, name: (name || '').trim() || 'ICS feed', color });
  res.json({ feed: { id: feed.id, name: feed.name, color: feed.color } });
});

app.patch('/api/ics/:id', (req, res) => {
  const updated = updateFeed(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Unknown feed' });
  res.json({ feed: updated });
});

app.delete('/api/ics/:id', (req, res) => {
  removeFeed(req.params.id);
  res.json({ ok: true });
});

// ── Unified events ──
// FullCalendar calls this with ?start=...&end=... (ISO) for the visible range.
app.get('/api/events', async (req, res) => {
  const now = new Date();
  const timeMin = req.query.start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const timeMax = req.query.end || new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();

  const hasTokens = req.session.tokens && Object.keys(req.session.tokens).length > 0;
  const hasIcs = feedCount() > 0;
  if (!hasTokens && !hasIcs) {
    return res.json({ events: [], errors: [] });
  }
  try {
    const result = await getUnifiedEvents(
      req.session,
      timeMin,
      timeMax,
      getFeeds(),
      getSettings().providers
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ events: [], errors: [{ provider: 'server', message: err.message }] });
  }
});

// Disconnect one provider or all.
app.post('/logout', express.json(), (req, res) => {
  const provider = req.query.provider;
  if (provider && req.session.tokens) {
    delete req.session.tokens[provider];
    return res.json({ ok: true });
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.listen(config.port, () => {
  console.log(`\n  Unified Calendar running at ${config.baseUrl}\n`);
  if (!isMicrosoftConfigured())
    console.log('  ⚠  Microsoft not configured — set MICROSOFT_CLIENT_ID / _SECRET in .env');
  if (!isGoogleConfigured())
    console.log('  ⚠  Google not configured — set GOOGLE_CLIENT_ID / _SECRET in .env');
});
