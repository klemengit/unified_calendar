import axios from 'axios';
import { config } from './config.js';
import { fetchIcsEvents } from './ics.js';

// Colors used to distinguish event sources in the UI.
export const COLORS = { microsoft: '#2563eb', google: '#16a34a' }; // blue / green

// ── Token refresh ──────────────────────────────────────────────
// Access tokens expire after ~1 hour. If we have a refresh token we silently
// trade it for a fresh access token so the user doesn't have to log in again.

async function refreshMicrosoft(token) {
  const url = `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    scope: config.microsoft.scopes.join(' '),
  });
  const { data } = await axios.post(url, body);
  token.accessToken = data.access_token;
  if (data.refresh_token) token.refreshToken = data.refresh_token;
  token.expiresAt = Date.now() + data.expires_in * 1000;
  return token;
}

async function refreshGoogle(token) {
  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
  });
  const { data } = await axios.post('https://oauth2.googleapis.com/token', body);
  token.accessToken = data.access_token;
  token.expiresAt = Date.now() + data.expires_in * 1000;
  return token;
}

async function ensureFresh(provider, token) {
  const stillValid = token.expiresAt && Date.now() < token.expiresAt - 60_000;
  if (stillValid || !token.refreshToken) return token;
  return provider === 'microsoft' ? refreshMicrosoft(token) : refreshGoogle(token);
}

// ── Event fetching ─────────────────────────────────────────────

async function fetchMicrosoftEvents(token, timeMin, timeMax, color) {
  const url = 'https://graph.microsoft.com/v1.0/me/calendarView';
  const { data } = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
    params: {
      startDateTime: timeMin,
      endDateTime: timeMax,
      $top: 250,
      $orderby: 'start/dateTime',
      $select: 'subject,start,end,isAllDay,location,webLink,bodyPreview',
    },
  });

  return (data.value || []).map((e) => ({
    id: `ms-${e.id}`,
    title: e.subject || '(no title)',
    // Graph returns UTC (we asked for it); append Z so JS parses it as UTC.
    start: e.isAllDay ? e.start.dateTime.slice(0, 10) : `${e.start.dateTime}Z`,
    end: e.isAllDay ? e.end.dateTime.slice(0, 10) : `${e.end.dateTime}Z`,
    allDay: e.isAllDay,
    color,
    calId: 'microsoft',
    source: 'Outlook',
    originalUrl: e.webLink || null,
    location: e.location?.displayName || '',
    description: (e.bodyPreview || '').trim(),
  }));
}

async function fetchGoogleEvents(token, timeMin, timeMax, color) {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    params: {
      timeMin,
      timeMax,
      singleEvents: true, // expand recurring events into instances
      orderBy: 'startTime',
      maxResults: 250,
    },
  });

  return (data.items || []).map((e) => ({
    id: `g-${e.id}`,
    title: e.summary || '(no title)',
    start: e.start.dateTime || e.start.date, // dateTime for timed, date for all-day
    end: e.end.dateTime || e.end.date,
    allDay: Boolean(e.start.date),
    color,
    calId: 'google',
    source: 'Google',
    originalUrl: e.htmlLink || null,
    location: e.location || '',
    description: (e.description || '').trim(),
  }));
}

/**
 * Fetch and merge events from every connected provider in the session.
 * Returns { events, errors } so one failing provider doesn't hide the other.
 */
export async function getUnifiedEvents(session, timeMin, timeMax, icsFeeds = [], providers = {}) {
  const tokens = session.tokens || {};
  const ms = providers.microsoft || { color: COLORS.microsoft, visible: true };
  const g = providers.google || { color: COLORS.google, visible: true };
  const events = [];
  const errors = [];

  const jobs = [];
  // We fetch every connected calendar regardless of visibility: the client
  // caches the full set per date range and filters show/hide locally, so
  // toggling is instant. `visible` is only persisted for restoring UI state.
  if (tokens.microsoft) {
    jobs.push(
      (async () => {
        const fresh = await ensureFresh('microsoft', tokens.microsoft);
        return fetchMicrosoftEvents(fresh, timeMin, timeMax, ms.color);
      })().then(
        (r) => events.push(...r),
        (err) => errors.push({ provider: 'microsoft', message: describe(err) })
      )
    );
  }
  if (tokens.google) {
    jobs.push(
      (async () => {
        const fresh = await ensureFresh('google', tokens.google);
        return fetchGoogleEvents(fresh, timeMin, timeMax, g.color);
      })().then(
        (r) => events.push(...r),
        (err) => errors.push({ provider: 'google', message: describe(err) })
      )
    );
  }

  // ICS subscriptions (no login required).
  for (const feed of icsFeeds) {
    jobs.push(
      fetchIcsEvents(feed, timeMin, timeMax).then(
        (r) => events.push(...r),
        (err) => errors.push({ provider: `ics:${feed.name}`, message: describe(err) })
      )
    );
  }

  await Promise.all(jobs);
  return { events, errors };
}

function describe(err) {
  const status = err.response?.status;
  const detail = err.response?.data?.error?.message || err.message;
  return status ? `${status}: ${detail}` : detail;
}
