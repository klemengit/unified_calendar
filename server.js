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
import {
  getUnifiedEvents,
  ensureFresh,
  listGoogleCalendars,
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
  COLORS,
} from './src/calendar.js';
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
  getGoogleCalendars,
  setGoogleCalendars,
  updateGoogleCalendar,
  getCaldavAccounts,
  getCaldavAccount,
  addCaldavAccount,
  removeCaldavAccount,
  setCaldavCalendars,
  updateCaldavCalendar,
  findCaldavCalendar,
  getTokens,
  saveTokens,
} from './src/store.js';
import {
  discoverCalendars,
  createCalDavEvent,
  updateCalDavEvent,
  deleteCalDavEvent,
} from './src/caldav.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

loadFeeds();
loadSettings();

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

// Restore OAuth tokens from disk when the session is fresh (e.g. after a restart).
app.use((req, res, next) => {
  if (!req.session.tokens || !Object.keys(req.session.tokens).length) {
    const saved = getTokens();
    if (Object.keys(saved).length) req.session.tokens = { ...saved };
  }
  next();
});

const rememberReturn = (req, res, next) => {
  req.session.returnTo = req.query.return === 'settings' ? '/settings.html' : '/';
  next();
};
const finishAuth = (req, res) => {
  const dest = req.session.returnTo || '/';
  delete req.session.returnTo;
  if (req.session.tokens) saveTokens(req.session.tokens);
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
    accessType: 'offline',
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

// ── Settings ──
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  res.json(updateSettings(req.body || {}));
});

app.put('/api/providers/:provider', (req, res) => {
  const result = updateProvider(req.params.provider, req.body || {});
  if (!result) return res.status(404).json({ error: 'Unknown provider' });
  res.json(result);
});

// Refresh a provider token and persist it so the new access token survives restarts.
async function freshToken(provider, req) {
  const token = req.session.tokens[provider];
  const refreshed = await ensureFresh(provider, token);
  if (refreshed !== token || refreshed.accessToken !== token.accessToken) {
    req.session.tokens[provider] = refreshed;
    saveTokens(req.session.tokens);
  }
  return refreshed;
}

// ── Google sub-calendar list (for settings page) ──
app.get('/api/google/calendars', async (req, res) => {
  if (!req.session.tokens?.google) return res.status(401).json({ error: 'Not connected to Google' });
  try {
    const fresh = await freshToken('google', req);
    const allCals = await listGoogleCalendars(fresh);
    const saved = getGoogleCalendars();
    const savedIds = new Set(saved.map((c) => c.googleId));
    const calendars = allCals.map((c) => ({ ...c, selected: savedIds.has(c.googleId) }));
    res.json({ calendars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save which Google calendars to sync (replaces entire list)
app.put('/api/google/calendars', (req, res) => {
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const list = (req.body.calendars || []).map((c) => ({
    id: `gcal_${c.googleId}`,
    googleId: c.googleId,
    name: c.name || c.googleId,
    color: HEX.test(c.color) ? c.color : (c.backgroundColor || COLORS.google),
    visible: true,
  }));
  res.json(setGoogleCalendars(list));
});

// Update a single Google calendar's color / visibility (from sidebar)
app.patch('/api/google/calendars/:id', (req, res) => {
  const result = updateGoogleCalendar(decodeURIComponent(req.params.id), req.body || {});
  if (!result) return res.status(404).json({ error: 'Unknown calendar' });
  res.json(result);
});

// ── Google event CRUD ──

function googleIdFromCalId(calId) {
  return calId.startsWith('gcal_') ? calId.slice(5) : calId;
}

function getGoogleCalColor(calId) {
  const cal = getGoogleCalendars().find((c) => c.id === calId);
  return cal?.color || COLORS.google;
}

function googleWriteError(err) {
  if (err.response?.status === 403)
    return { status: 403, message: 'Google Calendar write access denied. Reconnect Google in Settings.' };
  return { status: 500, message: err.message };
}

app.post('/api/google/events', async (req, res) => {
  if (!req.session.tokens?.google) return res.status(401).json({ error: 'Google not connected' });
  const { calId, title, start, end, allDay, location, description } = req.body || {};
  if (!calId || !title || !start) return res.status(400).json({ error: 'calId, title and start are required' });
  try {
    const fresh = await freshToken('google', req);
    const googleId = googleIdFromCalId(calId);
    const color = getGoogleCalColor(calId);
    const event = await createGoogleEvent(fresh, calId, googleId, color, { title, start, end, allDay, location, description });
    res.status(201).json({ event });
  } catch (err) {
    const { status, message } = googleWriteError(err);
    res.status(status).json({ error: message });
  }
});

app.put('/api/google/events/:eventId', async (req, res) => {
  if (!req.session.tokens?.google) return res.status(401).json({ error: 'Google not connected' });
  const { calId, title, start, end, allDay, location, description } = req.body || {};
  if (!calId || !title || !start) return res.status(400).json({ error: 'calId, title and start are required' });
  try {
    const fresh = await freshToken('google', req);
    const googleId = googleIdFromCalId(calId);
    const color = getGoogleCalColor(calId);
    const event = await updateGoogleEvent(fresh, calId, googleId, color, req.params.eventId, { title, start, end, allDay, location, description });
    res.json({ event });
  } catch (err) {
    const { status, message } = googleWriteError(err);
    res.status(status).json({ error: message });
  }
});

app.delete('/api/google/events/:eventId', async (req, res) => {
  if (!req.session.tokens?.google) return res.status(401).json({ error: 'Google not connected' });
  const { calId } = req.query;
  if (!calId) return res.status(400).json({ error: 'calId query param required' });
  try {
    const fresh = await freshToken('google', req);
    const googleId = googleIdFromCalId(calId);
    await deleteGoogleEvent(fresh, googleId, req.params.eventId);
    res.json({ ok: true });
  } catch (err) {
    const { status, message } = googleWriteError(err);
    res.status(status).json({ error: message });
  }
});

// ── Calendars list (sidebar) ──
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
    const gcals = getGoogleCalendars();
    if (gcals.length) {
      for (const gc of gcals) {
        calendars.push({
          id: gc.id,
          kind: 'google-sub',
          name: gc.name,
          color: gc.color,
          visible: gc.visible !== false,
          googleId: gc.googleId,
          writeable: true,
        });
      }
    } else {
      calendars.push({
        id: 'gcal_primary',
        kind: 'google-sub',
        name: tokens.google.email || tokens.google.name || 'Google',
        color: providers.google.color,
        visible: providers.google.visible !== false,
        googleId: 'primary',
        writeable: true,
      });
    }
  }

  for (const f of getFeeds()) {
    const u = f.url || '';
    const webCalBase = u.includes('calendar.google.com') ? 'google'
      : (u.includes('outlook.office365.com') || u.includes('outlook.office.com') || u.includes('outlook.live.com')) ? 'outlook'
      : null;
    calendars.push({ id: f.id, kind: 'ics', name: f.name, color: f.color, visible: f.visible !== false, webCalBase });
  }

  for (const account of getCaldavAccounts()) {
    for (const cal of (account.calendars || []).filter((c) => c.selected)) {
      calendars.push({
        id: cal.id,
        kind: 'caldav-sub',
        name: cal.name,
        color: cal.color || '#0891b2',
        visible: cal.visible !== false,
        writeable: true,
      });
    }
  }

  res.json({ calendars });
});

// ── ICS subscriptions ──
app.get('/api/ics', (req, res) => {
  res.json({ feeds: publicFeeds() });
});

app.post('/api/ics', (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url) && !/^webcal:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Provide a valid http(s):// or webcal:// .ics URL' });
  }
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

// ── CalDAV accounts ──

function publicCaldavAccount(account) {
  const { password, ...rest } = account;
  return rest;
}

app.get('/api/caldav/accounts', (req, res) => {
  res.json({ accounts: getCaldavAccounts().map(publicCaldavAccount) });
});

app.post('/api/caldav/accounts', async (req, res) => {
  const { server, username, password, displayName } = req.body || {};
  if (!server || !username || !password)
    return res.status(400).json({ error: 'server, username, and password are required' });
  try {
    const tempId = `cdav_tmp`;
    const discovered = await discoverCalendars(server.trim(), username.trim(), password, tempId);
    const account = addCaldavAccount({
      server: server.trim(),
      username: username.trim(),
      password,
      displayName: (displayName || '').trim() || username.trim(),
      calendars: [],
    });
    // Assign real IDs now that we have the accountId
    const calendars = discovered.map((cal) => ({
      ...cal,
      id: cal.id.replace('cdav_tmp', account.id),
      selected: false,
      visible: true,
    }));
    setCaldavCalendars(account.id, calendars);
    res.status(201).json({ account: publicCaldavAccount(getCaldavAccount(account.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/caldav/accounts/:id', (req, res) => {
  removeCaldavAccount(req.params.id);
  res.json({ ok: true });
});

// Re-discover calendars for an account (refresh)
app.get('/api/caldav/accounts/:id/calendars', async (req, res) => {
  const account = getCaldavAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Unknown account' });
  try {
    const discovered = await discoverCalendars(account.server, account.username, account.password, account.id);
    const existing = account.calendars || [];
    const merged = discovered.map((cal) => {
      const prev = existing.find((c) => c.id === cal.id);
      return { ...cal, selected: prev?.selected || false, visible: prev?.visible !== false, color: prev?.color || cal.color };
    });
    setCaldavCalendars(account.id, merged);
    res.json({ calendars: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save calendar selection for an account
app.put('/api/caldav/accounts/:id/calendars', (req, res) => {
  const account = getCaldavAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Unknown account' });
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const calendars = (req.body.calendars || []).map((c) => ({
    id: c.id,
    url: c.url,
    name: c.name || c.url,
    color: HEX.test(c.color) ? c.color : '#0891b2',
    selected: Boolean(c.selected),
    visible: c.visible !== false,
  }));
  setCaldavCalendars(account.id, calendars);
  res.json({ ok: true });
});

// Update CalDAV calendar color/visibility (from sidebar)
app.patch('/api/caldav/calendars/:id', (req, res) => {
  const result = updateCaldavCalendar(decodeURIComponent(req.params.id), req.body || {});
  if (!result) return res.status(404).json({ error: 'Unknown calendar' });
  res.json(result);
});

// ── CalDAV event CRUD ──

function caldavWriteError(err) {
  return { status: 500, message: err.message };
}

app.post('/api/caldav/events', async (req, res) => {
  const { calId, title, start, end, allDay, location, description } = req.body || {};
  if (!calId || !title || !start) return res.status(400).json({ error: 'calId, title and start are required' });
  const found = findCaldavCalendar(calId);
  if (!found) return res.status(404).json({ error: 'Unknown CalDAV calendar' });
  try {
    const event = await createCalDavEvent(found.account, found.calendar, { title, start, end, allDay, location, description });
    res.status(201).json({ event });
  } catch (err) {
    const { status, message } = caldavWriteError(err);
    res.status(status).json({ error: message });
  }
});

app.put('/api/caldav/events/:uid', async (req, res) => {
  const { calId, title, start, end, allDay, location, description } = req.body || {};
  if (!calId || !title || !start) return res.status(400).json({ error: 'calId, title and start are required' });
  const found = findCaldavCalendar(calId);
  if (!found) return res.status(404).json({ error: 'Unknown CalDAV calendar' });
  try {
    const event = await updateCalDavEvent(found.account, found.calendar, req.params.uid, { title, start, end, allDay, location, description });
    res.json({ event });
  } catch (err) {
    const { status, message } = caldavWriteError(err);
    res.status(status).json({ error: message });
  }
});

app.delete('/api/caldav/events/:uid', async (req, res) => {
  const { calId } = req.query;
  if (!calId) return res.status(400).json({ error: 'calId query param required' });
  const found = findCaldavCalendar(calId);
  if (!found) return res.status(404).json({ error: 'Unknown CalDAV calendar' });
  try {
    await deleteCalDavEvent(found.account, req.params.uid, found.calendar.url);
    res.json({ ok: true });
  } catch (err) {
    const { status, message } = caldavWriteError(err);
    res.status(status).json({ error: message });
  }
});

// ── Unified events ──
app.get('/api/events', async (req, res) => {
  const now = new Date();
  const timeMin = req.query.start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const timeMax = req.query.end || new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();

  const hasTokens = req.session.tokens && Object.keys(req.session.tokens).length > 0;
  const hasIcs = feedCount() > 0;
  const hasCaldav = getCaldavAccounts().some((a) => (a.calendars || []).some((c) => c.selected));
  if (!hasTokens && !hasIcs && !hasCaldav) {
    return res.json({ events: [], errors: [] });
  }
  try {
    const result = await getUnifiedEvents(
      req.session,
      timeMin,
      timeMax,
      getFeeds(),
      getSettings().providers,
      getGoogleCalendars(),
      getCaldavAccounts()
    );
    // Tokens may have been silently refreshed inside getUnifiedEvents — persist them.
    if (req.session.tokens) saveTokens(req.session.tokens);
    res.json(result);
  } catch (err) {
    res.status(500).json({ events: [], errors: [{ provider: 'server', message: err.message }] });
  }
});

// ── Logout ──
app.post('/logout', express.json(), (req, res) => {
  const provider = req.query.provider;
  if (provider && req.session.tokens) {
    delete req.session.tokens[provider];
    saveTokens(req.session.tokens);
    return res.json({ ok: true });
  }
  req.session.destroy(() => {
    saveTokens({});
    res.json({ ok: true });
  });
});

app.listen(config.port, () => {
  console.log(`\n  Unified Calendar running at ${config.baseUrl}\n`);
  if (!isMicrosoftConfigured())
    console.log('  ⚠  Microsoft not configured — set MICROSOFT_CLIENT_ID / _SECRET in .env');
  if (!isGoogleConfigured())
    console.log('  ⚠  Google not configured — set GOOGLE_CLIENT_ID / _SECRET in .env');
});
