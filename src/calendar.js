import axios from 'axios';
import { config } from './config.js';
import { fetchIcsEvents } from './ics.js';

export const COLORS = { microsoft: '#2563eb', google: '#16a34a' };

// ── Token refresh ──────────────────────────────────────────────

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

export async function ensureFresh(provider, token) {
  const stillValid = token.expiresAt && Date.now() < token.expiresAt - 60_000;
  if (stillValid || !token.refreshToken) return token;
  return provider === 'microsoft' ? refreshMicrosoft(token) : refreshGoogle(token);
}

// ── Google Calendar helpers ────────────────────────────────────

function addOneDayToDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildGCalBody({ title, start, end, allDay, description, location }) {
  if (allDay) {
    // end from client is inclusive; Google needs exclusive (add 1 day)
    return {
      summary: title,
      description: description || '',
      location: location || '',
      start: { date: start },
      end: { date: addOneDayToDateStr(end || start) },
    };
  }
  return {
    summary: title,
    description: description || '',
    location: location || '',
    start: { dateTime: start },
    end: { dateTime: end || start },
  };
}

function googleEventToUnified(e, calId, googleId, color) {
  return {
    id: `g-${e.id}`,
    title: e.summary || '(no title)',
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date,
    allDay: Boolean(e.start.date),
    color,
    calId,
    gcalendarId: googleId,
    googleEventId: e.id,
    source: 'Google',
    originalUrl: e.htmlLink || null,
    location: e.location || '',
    description: (e.description || '').trim(),
  };
}

export async function listGoogleCalendars(token) {
  const { data } = await axios.get(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${token.accessToken}` }, params: { maxResults: 250 } }
  );
  return (data.items || []).map((c) => ({
    googleId: c.id,
    id: `gcal_${c.id}`,
    name: c.summary || c.id,
    backgroundColor: c.backgroundColor || COLORS.google,
    accessRole: c.accessRole,
  }));
}

export async function createGoogleEvent(token, calId, googleId, color, eventData) {
  const { data } = await axios.post(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events`,
    buildGCalBody(eventData),
    { headers: { Authorization: `Bearer ${token.accessToken}` } }
  );
  return googleEventToUnified(data, calId, googleId, color);
}

export async function updateGoogleEvent(token, calId, googleId, color, eventId, eventData) {
  const { data } = await axios.put(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events/${encodeURIComponent(eventId)}`,
    buildGCalBody(eventData),
    { headers: { Authorization: `Bearer ${token.accessToken}` } }
  );
  return googleEventToUnified(data, calId, googleId, color);
}

export async function deleteGoogleEvent(token, googleId, eventId) {
  await axios.delete(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token.accessToken}` } }
  );
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

async function fetchGoogleCalendarEvents(token, calId, googleId, timeMin, timeMax, color) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    params: {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    },
  });

  return (data.items || []).map((e) => googleEventToUnified(e, calId, googleId, color));
}

// ── Unified fetch ──────────────────────────────────────────────

export async function getUnifiedEvents(
  session,
  timeMin,
  timeMax,
  icsFeeds = [],
  providers = {},
  googleCalendars = []
) {
  const tokens = session.tokens || {};
  const ms = providers.microsoft || { color: COLORS.microsoft, visible: true };
  const g = providers.google || { color: COLORS.google, visible: true };
  const events = [];
  const errors = [];
  const jobs = [];

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
    const cals =
      googleCalendars.length > 0
        ? googleCalendars
        : [{ id: 'gcal_primary', googleId: 'primary', color: g.color }];

    for (const cal of cals) {
      const color = cal.color || g.color;
      jobs.push(
        (async () => {
          const fresh = await ensureFresh('google', tokens.google);
          return fetchGoogleCalendarEvents(fresh, cal.id, cal.googleId, timeMin, timeMax, color);
        })().then(
          (r) => events.push(...r),
          (err) => errors.push({ provider: cal.id, message: describe(err) })
        )
      );
    }
  }

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
