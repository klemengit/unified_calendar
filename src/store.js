import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAD_MINUTES, isTimeZone } from './reminders.js';

// Simple file-backed store for ICS subscription links so they survive restarts.
// This module persists feeds, settings (including the starred-event id list) and OAuth tokens —
// never event bodies. Event ids reach disk here via setEventImportant(); event bodies reach
// DATA_DIR only via the opt-in widget cache, see widget-cache-store.js.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Exported so every part of the app keeps its state together; overridable so tests can point this
// at a throwaway mkdtemp() dir instead of the real data/ directory.
export const DATA_DIR = process.env.UNIFIED_CALENDAR_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'feeds.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let feeds = [];
let nextId = 1;

// The seven canonical calendar view ids (built-in FullCalendar views plus the
// two custom multiMonth durations configured in app.js).
const VIEW_IDS = [
  'timeGridDay',
  'timeGridWeek',
  'dayGridMonth',
  'multiMonth2',
  'multiMonth4',
  'multiMonthYear',
  'listMonth',
];

// User calendar preferences. These map directly onto FullCalendar options.
const DEFAULT_SETTINGS = {
  firstDay: 1, // 0 = Sunday, 1 = Monday
  defaultView: 'timeGridWeek', // one of VIEW_IDS
  timeFormat: '24h', // '24h' | '12h'
  showWeekends: true,
  syncInterval: 15, // minutes between background syncs; 0 = never
  // Per-OAuth-source color + visibility (ICS feeds carry their own, in feeds.json).
  providers: {
    microsoft: { color: '#2563eb', visible: true },
    google: { color: '#16a34a', visible: true },
  },
  // Google sub-calendars selected by the user. Empty = use primary only.
  googleCalendars: [],
  // CalDAV accounts with credentials and selected calendars.
  caldavAccounts: [],
  // Persisted OAuth tokens so Google/Microsoft survive server restarts.
  savedTokens: {},
  theme: 'system', // 'system' | 'light' | 'dark'
  // View-switcher buttons shown, in order. Must never end up empty.
  enabledViews: ['timeGridDay', 'timeGridWeek', 'dayGridMonth', 'multiMonth2', 'multiMonth4', 'multiMonthYear', 'listMonth'],
  spentDays: 'dim', // 'off' | 'dim' | 'strike' | 'hatch'
  highlightToday: true,
  compactDensity: 'emphasised', // 'emphasised' | 'dots' | 'titles'
  importantEvents: [], // string[] of FullCalendar event ids
  weekends: 'tint', // 'off' | 'tint' | 'muted' | 'divider'
  // Push reminders, sent to every device that turned notifications on.
  reminders: {
    minutesBefore: 10, // one of LEAD_MINUTES
    allDayHour: 8, // hour of the day all-day events are announced; null = never
    mutedCalendars: [], // calendar ids that send no reminders
    timeZone: null, // IANA zone the reminders are timed in, reported by the browser
  },
};
let settings = clone(DEFAULT_SETTINGS);
let nextCaldavId = 1;

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_IMPORTANT_EVENTS = 5000;

// The one eviction policy for settings.importantEvents, shared by loadSettings, updateSettings and
// setEventImportant: drop non-strings, de-dupe keeping each id's most recent position, and evict
// the OLDEST ids past the cap. The three paths write the same field, so they have to agree —
// keeping the oldest here would throw away exactly the star a single-id write had just added.
function normalizeImportantEvents(list) {
  const ids = (Array.isArray(list) ? list : []).filter((id) => typeof id === 'string');
  const deduped = [...new Set(ids.reverse())].reverse();
  return deduped.slice(-MAX_IMPORTANT_EVENTS);
}

// Crash-safe private write: a temp file created 0600 from the outset (so it is never briefly
// world-readable), then renamed over the target. The rename carries the 0600 with it, which is
// how an existing looser file gets tightened.
export function writePrivate(target, name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `.${name}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    // umask can only clear bits, never add them, but an inherited tmp file would keep its own
    // mode — so state it outright rather than relying on the create flag alone.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up if the temp file was never created.
    }
    throw err;
  }
}

// feeds.json holds ICS subscription URLs. An Outlook/Google calendar feed URL is a capability:
// anyone holding it can read that calendar without credentials, so it is as private as a password.
function persist() {
  writePrivate(FILE, 'feeds.json', JSON.stringify(feeds, null, 2));
}

// settings.json holds the OAuth access and refresh tokens and the CalDAV password in plaintext.
function persistSettings() {
  writePrivate(SETTINGS_FILE, 'settings.json', JSON.stringify(settings, null, 2));
}

export function loadFeeds() {
  try {
    feeds = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(feeds)) feeds = [];
  } catch {
    feeds = []; // no file yet (first run) or unreadable — start empty
  }
  // Default visibility for feeds saved before this field existed.
  feeds.forEach((f) => {
    if (typeof f.visible !== 'boolean') f.visible = true;
  });
  // Resume the id counter past the highest existing id (ids look like "f12").
  nextId =
    feeds.reduce((max, f) => Math.max(max, parseInt(String(f.id).slice(1), 10) || 0), 0) + 1;
  return feeds;
}

/** Full feed objects (includes the url) — for server-side fetching. */
export function getFeeds() {
  return feeds;
}

/** Safe view for the client — omits the url. */
export function publicFeeds() {
  return feeds.map(({ url, ...rest }) => rest);
}

export function addFeed({ url, name, color }) {
  const feed = { id: `f${nextId++}`, url, name, color, visible: true };
  feeds.push(feed);
  persist();
  return feed;
}

export function removeFeed(id) {
  const before = feeds.length;
  feeds = feeds.filter((f) => f.id !== id);
  if (feeds.length !== before) persist();
}

/** Update a feed's name, color, and/or visibility. Returns the public (url-less) feed. */
export function updateFeed(id, patch = {}) {
  const feed = feeds.find((f) => f.id === id);
  if (!feed) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) feed.name = patch.name.trim();
  if (HEX.test(patch.color)) feed.color = patch.color;
  if (typeof patch.visible === 'boolean') feed.visible = patch.visible;
  persist();
  const { url, ...rest } = feed;
  return rest;
}

export function feedCount() {
  return feeds.length;
}

// ── Settings ──

export function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = { ...clone(DEFAULT_SETTINGS), ...saved };
    // Deep-merge providers so older files missing fields still get defaults.
    settings.providers = {
      microsoft: { ...DEFAULT_SETTINGS.providers.microsoft, ...saved.providers?.microsoft },
      google: { ...DEFAULT_SETTINGS.providers.google, ...saved.providers?.google },
    };
    settings.googleCalendars = Array.isArray(saved.googleCalendars) ? saved.googleCalendars : [];
    settings.caldavAccounts = Array.isArray(saved.caldavAccounts) ? saved.caldavAccounts : [];
    settings.savedTokens = saved.savedTokens && typeof saved.savedTokens === 'object' ? saved.savedTokens : {};
    // Deep-merge view-configuration fields so settings.json written before this
    // feature existed still gets valid defaults instead of undefined.
    settings.theme = ['system', 'light', 'dark'].includes(saved.theme) ? saved.theme : DEFAULT_SETTINGS.theme;
    const savedViews = Array.isArray(saved.enabledViews)
      ? saved.enabledViews.filter((v) => VIEW_IDS.includes(v))
      : [];
    settings.enabledViews = savedViews.length ? savedViews : clone(DEFAULT_SETTINGS.enabledViews);
    settings.spentDays = ['off', 'dim', 'strike', 'hatch'].includes(saved.spentDays)
      ? saved.spentDays
      : DEFAULT_SETTINGS.spentDays;
    settings.highlightToday =
      typeof saved.highlightToday === 'boolean' ? saved.highlightToday : DEFAULT_SETTINGS.highlightToday;
    settings.compactDensity = ['emphasised', 'dots', 'titles'].includes(saved.compactDensity)
      ? saved.compactDensity
      : DEFAULT_SETTINGS.compactDensity;
    settings.importantEvents = normalizeImportantEvents(saved.importantEvents);
    settings.weekends = ['off', 'tint', 'muted', 'divider'].includes(saved.weekends)
      ? saved.weekends
      : DEFAULT_SETTINGS.weekends;
    settings.reminders = normalizeReminders(saved.reminders, DEFAULT_SETTINGS.reminders);
    nextCaldavId =
      settings.caldavAccounts.reduce((max, a) => Math.max(max, parseInt(String(a.id).slice(5), 10) || 0), 0) + 1;
  } catch {
    settings = clone(DEFAULT_SETTINGS);
  }
  return settings;
}

// Takes each valid field of `input`, and the rest from `base`.
function normalizeReminders(input, base) {
  const r = input && typeof input === 'object' ? input : {};
  const hourOk = r.allDayHour === null || (Number.isInteger(r.allDayHour) && r.allDayHour >= 0 && r.allDayHour <= 23);
  return {
    minutesBefore: LEAD_MINUTES.includes(r.minutesBefore) ? r.minutesBefore : base.minutesBefore,
    allDayHour: hourOk ? r.allDayHour : base.allDayHour,
    mutedCalendars: Array.isArray(r.mutedCalendars)
      ? [...new Set(r.mutedCalendars.filter((id) => typeof id === 'string' && id.length <= 200))].slice(0, 500)
      : clone(base.mutedCalendars),
    timeZone: isTimeZone(r.timeZone) ? r.timeZone : base.timeZone,
  };
}

export function getSettings() {
  return settings;
}

/** Merge in only known, validated fields, then persist. */
export function updateSettings(patch = {}) {
  const next = { ...settings };
  if ([0, 1].includes(patch.firstDay)) next.firstDay = patch.firstDay;
  if (VIEW_IDS.includes(patch.defaultView)) next.defaultView = patch.defaultView;
  if (['24h', '12h'].includes(patch.timeFormat)) next.timeFormat = patch.timeFormat;
  if (typeof patch.showWeekends === 'boolean') next.showWeekends = patch.showWeekends;
  if ([0, 5, 15, 30, 60].includes(patch.syncInterval)) next.syncInterval = patch.syncInterval;
  if (['system', 'light', 'dark'].includes(patch.theme)) next.theme = patch.theme;
  if (Array.isArray(patch.enabledViews)) {
    const views = patch.enabledViews.filter((v) => VIEW_IDS.includes(v));
    // Never allow zero enabled views — that would leave no view-switcher buttons.
    next.enabledViews = views.length ? views : clone(DEFAULT_SETTINGS.enabledViews);
  }
  if (['off', 'dim', 'strike', 'hatch'].includes(patch.spentDays)) next.spentDays = patch.spentDays;
  if (typeof patch.highlightToday === 'boolean') next.highlightToday = patch.highlightToday;
  if (['emphasised', 'dots', 'titles'].includes(patch.compactDensity))
    next.compactDensity = patch.compactDensity;
  if (Array.isArray(patch.importantEvents)) {
    next.importantEvents = normalizeImportantEvents(patch.importantEvents);
  }
  if (['off', 'tint', 'muted', 'divider'].includes(patch.weekends)) next.weekends = patch.weekends;
  if (patch.reminders && typeof patch.reminders === 'object') {
    next.reminders = normalizeReminders(patch.reminders, settings.reminders);
  }
  settings = next;
  persistSettings();
  return settings;
}

// ── Google sub-calendars ──

export function getGoogleCalendars() {
  return settings.googleCalendars || [];
}

/** Replace the entire saved Google calendar list and persist. */
export function setGoogleCalendars(list) {
  settings.googleCalendars = list;
  persistSettings();
  return settings.googleCalendars;
}

/** Update a single Google calendar's name, color, or visibility by its calId. */
export function updateGoogleCalendar(id, patch = {}) {
  const cal = (settings.googleCalendars || []).find((c) => c.id === id);
  if (!cal) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) cal.name = patch.name.trim();
  if (HEX.test(patch.color)) cal.color = patch.color;
  if (typeof patch.visible === 'boolean') cal.visible = patch.visible;
  persistSettings();
  return cal;
}

// ── CalDAV accounts ──

export function getCaldavAccounts() {
  return settings.caldavAccounts || [];
}

export function getCaldavAccount(id) {
  return (settings.caldavAccounts || []).find((a) => a.id === id) || null;
}

export function addCaldavAccount(account) {
  if (!settings.caldavAccounts) settings.caldavAccounts = [];
  const id = `cdav_${nextCaldavId++}`;
  const newAccount = { ...account, id };
  settings.caldavAccounts.push(newAccount);
  persistSettings();
  return newAccount;
}

export function removeCaldavAccount(id) {
  settings.caldavAccounts = (settings.caldavAccounts || []).filter((a) => a.id !== id);
  persistSettings();
}

/** Replace the calendar list for an account (after selection). */
export function setCaldavCalendars(accountId, calendars) {
  const account = (settings.caldavAccounts || []).find((a) => a.id === accountId);
  if (!account) return null;
  account.calendars = calendars;
  persistSettings();
  return account;
}

/** Update a single CalDAV calendar's name, color, or visibility by calId. */
export function updateCaldavCalendar(calId, patch = {}) {
  for (const account of settings.caldavAccounts || []) {
    const cal = (account.calendars || []).find((c) => c.id === calId);
    if (!cal) continue;
    if (typeof patch.name === 'string' && patch.name.trim()) cal.name = patch.name.trim();
    if (HEX.test(patch.color)) cal.color = patch.color;
    if (typeof patch.visible === 'boolean') cal.visible = patch.visible;
    persistSettings();
    return cal;
  }
  return null;
}

// ── OAuth token persistence ──

/** Return the last-saved OAuth tokens (survives server restarts). */
export function getTokens() {
  return settings.savedTokens || {};
}

/** Persist the current OAuth tokens so they survive restarts. */
export function saveTokens(tokens) {
  settings.savedTokens = tokens && typeof tokens === 'object' ? { ...tokens } : {};
  persistSettings();
}

/** Find which account owns a given calId, plus the calendar object. */
export function findCaldavCalendar(calId) {
  for (const account of settings.caldavAccounts || []) {
    const cal = (account.calendars || []).find((c) => c.id === calId);
    if (cal) return { account, calendar: cal };
  }
  return null;
}

// Adds or removes a single id from settings.importantEvents, deduped and capped at MAX_IMPORTANT_EVENTS, then persists.
export function setEventImportant(id, important) {
  const current = Array.isArray(settings.importantEvents) ? settings.importantEvents : [];
  // Re-append (not just append) so re-marking an id moves it to the most-recently-starred end.
  const list = important
    ? [...current.filter((existing) => existing !== id), id]
    : current.filter((existing) => existing !== id);
  settings = { ...settings, importantEvents: normalizeImportantEvents(list) };
  persistSettings();
  return settings.importantEvents;
}

/** Update an OAuth provider's color and/or visibility. */
export function updateProvider(provider, patch = {}) {
  if (!settings.providers[provider]) return null;
  const p = settings.providers[provider];
  if (HEX.test(patch.color)) p.color = patch.color;
  if (typeof patch.visible === 'boolean') p.visible = patch.visible;
  persistSettings();
  return p;
}
