import axios from 'axios';
import { config } from './config.js';
import { fetchIcsEvents } from './ics.js';
import { fetchCalDavEvents } from './caldav.js';
import { buildRrule, parseRrule, shiftSeries, toZonedIso } from './recurrence.js';

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

// Concurrent calendar jobs share one token, so a single expired access token can
// trigger many simultaneous refresh_token POSTs (the prefetch + visible-view fetch
// each fan out one per calendar). Dedupe by refresh token so only one refresh is
// in flight per credential — avoids hammering the token endpoint and the races that
// intermittently make all calendars fail at once.
const inFlightRefreshes = new Map(); // refreshToken -> Promise<token>

export async function ensureFresh(provider, token) {
  const stillValid = token.expiresAt && Date.now() < token.expiresAt - 60_000;
  if (stillValid || !token.refreshToken) return token;

  const existing = inFlightRefreshes.get(token.refreshToken);
  if (existing) return existing;

  const refresh = provider === 'microsoft' ? refreshMicrosoft : refreshGoogle;
  const promise = refresh(token).finally(() => inFlightRefreshes.delete(token.refreshToken));
  inFlightRefreshes.set(token.refreshToken, promise);
  return promise;
}

// ── Google Calendar helpers ────────────────────────────────────

function addOneDayToDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildGCalBody({ title, start, end, allDay, description, location, attendees, timeZone, recurrence }) {
  const body = {
    summary: title,
    description: description || '',
    location: location || '',
  };
  if (allDay) {
    // end from client is inclusive; Google needs exclusive (add 1 day)
    body.start = { date: start };
    body.end = { date: addOneDayToDateStr(end || start) };
  } else if (timeZone) {
    // A repeating event needs its zone: Google refuses one without, and a UTC
    // time would shift by an hour across daylight-saving changes.
    body.start = { dateTime: toZonedIso(start, timeZone), timeZone };
    body.end = { dateTime: toZonedIso(end || start, timeZone), timeZone };
  } else {
    body.start = { dateTime: start };
    body.end = { dateTime: end || start };
  }
  // Absent leaves the repeat alone; an empty array removes it.
  if (Array.isArray(recurrence)) body.recurrence = recurrence;
  // Absent means "leave the guest list alone"; an empty array clears it.
  if (Array.isArray(attendees)) body.attendees = attendees.map((email) => ({ email }));
  return body;
}

// Google mails an invitation only when asked to. Skip the mail when no guest is
// involved, so a solo event does not notify anyone about itself.
function updatesParam(eventData) {
  return { sendUpdates: eventData.attendees?.length ? 'all' : 'none' };
}

function attendeesToUnified(list) {
  return (list || [])
    .filter((a) => !a.resource)
    .map((a) => ({
      email: a.email || '',
      name: a.displayName || '',
      status: a.responseStatus || 'needsAction',
      organizer: Boolean(a.organizer),
      self: Boolean(a.self),
    }));
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
    attendees: attendeesToUnified(e.attendees),
    // An occurrence of a repeating event: the series it belongs to and the
    // start it had before any edit, which "All events" edits measure from.
    recurring: Boolean(e.recurringEventId),
    seriesId: e.recurringEventId || null,
    occurrenceStart: e.originalStartTime?.dateTime || e.originalStartTime?.date || null,
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
    { headers: { Authorization: `Bearer ${token.accessToken}` }, params: updatesParam(eventData) }
  );
  return googleEventToUnified(data, calId, googleId, color);
}

// PATCH rather than PUT: an edit made from a cached copy that predates guest
// support omits `attendees` entirely, and a merge leaves the guests in place
// instead of wiping them.
export async function updateGoogleEvent(token, calId, googleId, color, eventId, eventData) {
  const { data } = await axios.patch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events/${encodeURIComponent(eventId)}`,
    buildGCalBody(eventData),
    { headers: { Authorization: `Bearer ${token.accessToken}` }, params: updatesParam(eventData) }
  );
  return googleEventToUnified(data, calId, googleId, color);
}

function seriesUrl(googleId, seriesId) {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events/${encodeURIComponent(seriesId)}`;
}

// The repeat of a series, in the event form's terms ({ repeat, repeatUntil }).
// Google lists occurrences only, so the form asks for this when it opens one.
export async function getGoogleSeriesRepeat(token, googleId, seriesId, timeZone) {
  const { data } = await axios.get(seriesUrl(googleId, seriesId), {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  const rule = (data.recurrence || []).find((r) => /^RRULE:/i.test(r));
  return parseRrule(rule, data.start?.timeZone || timeZone);
}

// "All events": edit the series an occurrence belongs to. The series start
// moves by as many days as the occurrence did (see shiftSeries), and the
// repeat changes only when eventData.recurrence says so.
export async function updateGoogleSeries(token, calId, googleId, color, seriesId, occurrenceStart, eventData) {
  const headers = { Authorization: `Bearer ${token.accessToken}` };
  const { data: series } = await axios.get(seriesUrl(googleId, seriesId), { headers });
  const timeZone = eventData.timeZone || series.start?.timeZone || 'UTC';
  const shifted = shiftSeries({
    seriesStart: series.start.dateTime || series.start.date,
    occurrenceStart,
    start: eventData.start,
    end: eventData.end,
    allDay: eventData.allDay,
    timeZone,
  });

  const body = buildGCalBody({ ...eventData, timeZone: undefined });
  if (eventData.allDay) {
    body.start = { date: shifted.start, dateTime: null, timeZone: null };
    body.end = { date: shifted.endExclusive, dateTime: null, timeZone: null };
  } else {
    body.start = { dateTime: shifted.start, timeZone, date: null };
    body.end = { dateTime: shifted.end, timeZone, date: null };
  }
  // When the form left the repeat alone, a simple rule is still rebuilt from
  // the new start: a weekday named in it (BYDAY=WE) follows the series when it
  // moves, and UNTIL switches between a date and a time with all-day.
  if (!Array.isArray(eventData.recurrence)) {
    const rule = (series.recurrence || []).find((r) => /^RRULE:/i.test(r));
    const { repeat, repeatUntil } = parseRrule(rule, timeZone);
    if (repeat !== 'custom') {
      body.recurrence = [buildRrule({ repeat, repeatUntil, allDay: eventData.allDay, timeZone })].filter(Boolean);
    }
  }
  // Keep the series' EXDATE / RDATE lines alongside a new rule.
  if (body.recurrence?.length) {
    body.recurrence.push(...(series.recurrence || []).filter((r) => !/^RRULE:/i.test(r)));
  }

  const { data } = await axios.patch(seriesUrl(googleId, seriesId), body, { headers, params: updatesParam(eventData) });
  return googleEventToUnified(data, calId, googleId, color);
}

export async function deleteGoogleEvent(token, googleId, eventId) {
  await axios.delete(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleId)}/events/${encodeURIComponent(eventId)}`,
    // Guests get a cancellation; Google ignores the flag when there are none.
    { headers: { Authorization: `Bearer ${token.accessToken}` }, params: { sendUpdates: 'all' } }
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
  googleCalendars = [],
  caldavAccounts = []
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

  for (const account of caldavAccounts) {
    const selectedCals = (account.calendars || []).filter((c) => c.selected && c.visible !== false);
    for (const cal of selectedCals) {
      jobs.push(
        fetchCalDavEvents(account, cal, timeMin, timeMax).then(
          (r) => events.push(...r),
          (err) => errors.push({ provider: `caldav:${account.displayName}`, message: describe(err) })
        )
      );
    }
  }

  await Promise.all(jobs);
  return { events, errors };
}

function describe(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  let detail;
  if (typeof data?.error === 'string') {
    // OAuth token-endpoint error: { error: "invalid_grant", error_description: "..." }.
    // (REST API errors instead nest a { error: { message } } object, handled below.)
    detail = data.error_description ? `${data.error}: ${data.error_description}` : data.error;
  } else {
    detail = data?.error?.message || err.message;
  }
  return status ? `${status}: ${detail}` : detail;
}
