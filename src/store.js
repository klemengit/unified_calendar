import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Simple file-backed store for ICS subscription links so they survive restarts.
// Only the feed list is persisted — never OAuth tokens or event data.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'feeds.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let feeds = [];
let nextId = 1;

// User calendar preferences. These map directly onto FullCalendar options.
const DEFAULT_SETTINGS = {
  firstDay: 1, // 0 = Sunday, 1 = Monday
  defaultView: 'timeGridWeek', // dayGridMonth | timeGridWeek | timeGridDay
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
};
let settings = clone(DEFAULT_SETTINGS);
let nextCaldavId = 1;

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(feeds, null, 2));
}

function persistSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
    nextCaldavId =
      settings.caldavAccounts.reduce((max, a) => Math.max(max, parseInt(String(a.id).slice(5), 10) || 0), 0) + 1;
  } catch {
    settings = clone(DEFAULT_SETTINGS);
  }
  return settings;
}

export function getSettings() {
  return settings;
}

/** Merge in only known, validated fields, then persist. */
export function updateSettings(patch = {}) {
  const next = { ...settings };
  if ([0, 1].includes(patch.firstDay)) next.firstDay = patch.firstDay;
  if (['dayGridMonth', 'timeGridWeek', 'timeGridDay'].includes(patch.defaultView))
    next.defaultView = patch.defaultView;
  if (['24h', '12h'].includes(patch.timeFormat)) next.timeFormat = patch.timeFormat;
  if (typeof patch.showWeekends === 'boolean') next.showWeekends = patch.showWeekends;
  if ([0, 5, 15, 30, 60].includes(patch.syncInterval)) next.syncInterval = patch.syncInterval;
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

/** Update an OAuth provider's color and/or visibility. */
export function updateProvider(provider, patch = {}) {
  if (!settings.providers[provider]) return null;
  const p = settings.providers[provider];
  if (HEX.test(patch.color)) p.color = patch.color;
  if (typeof patch.visible === 'boolean') p.visible = patch.visible;
  persistSettings();
  return p;
}
