import express from 'express';
import {
  toWidgetEvent,
  toCachedEvent,
  mergeEventsWithCache,
} from './widget.js';
// tasks.js is pure (no network/fs) so it's imported directly, same as widget.js above — only the
// network-touching caldav.js functions go through `deps` (see registerWidgetRoutes).
import { parseQuickAdd, applyCompletion, resolveListToken } from './tasks.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 100;
const MAX_CACHED_RANGES = 24;
const MAX_IMPORTANT_ID_LEN = 1000;
const MAX_TASK_TEXT_LEN = 500;
const MAX_TASK_ID_LEN = 1000;
// The widget polls every 15 minutes, often from several monitors at once; task lists change far
// less often than that, so discovery is cached for an hour instead of re-running PROPFIND per poll.
const TASK_LIST_CACHE_TTL_MS = 60 * 60 * 1000;

// Validates a star/unstar body — returns an error message, or null when the body is valid.
// Exported because the web app's POST /api/settings/important writes the same field through the
// same store function: sharing the check keeps the two routes from drifting apart.
export function importantBodyError(body) {
  const { id, important } = body && typeof body === 'object' ? body : {};
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_IMPORTANT_ID_LEN) {
    return `id must be a string of 1-${MAX_IMPORTANT_ID_LEN} characters`;
  }
  if (typeof important !== 'boolean') {
    return 'important must be a boolean';
  }
  return null;
}

// Validates a POST /api/widget/tasks body — mirrors importantBodyError's shape and is exported for
// the same reason: a future web-app quick-add route can share it.
export function addTaskBodyError(body) {
  const { text, listId } = body && typeof body === 'object' ? body : {};
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TASK_TEXT_LEN) {
    return `text must be a string of 1-${MAX_TASK_TEXT_LEN} characters`;
  }
  if (listId !== undefined && (typeof listId !== 'string' || listId.length < 1)) {
    return 'listId must be a non-empty string';
  }
  return null;
}

// Validates a POST /api/widget/tasks/complete body.
export function completeTaskBodyError(body) {
  const { id, completed } = body && typeof body === 'object' ? body : {};
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_TASK_ID_LEN) {
    return `id must be a string of 1-${MAX_TASK_ID_LEN} characters`;
  }
  if (typeof completed !== 'boolean') {
    return 'completed must be a boolean';
  }
  return null;
}

// Parses "YYYY-MM-DD" into a local-midnight Date; null on bad format or calendar overflow (e.g. 2026-02-30).
function parseLocalDateStrict(str) {
  const m = DATE_RE.exec(str || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// Calendar-day count between two "YYYY-MM-DD" strings, via UTC Y/M/D arithmetic (unaffected by DST).
function daysBetween(startStr, endStr) {
  const [, sy, smo, sd] = DATE_RE.exec(startStr);
  const [, ey, emo, ed] = DATE_RE.exec(endStr);
  const startUtc = Date.UTC(Number(sy), Number(smo) - 1, Number(sd));
  const endUtc = Date.UTC(Number(ey), Number(emo) - 1, Number(ed));
  return Math.round((endUtc - startUtc) / 86400000);
}

// The cache write boundary: only reduced events are ever handed to the store — the HTTP response keeps full detail.
function toCachedEntry(entry) {
  const providers = {};
  for (const [key, provider] of Object.entries(entry?.providers || {})) {
    providers[key] = {
      syncedAt: provider.syncedAt,
      events: (provider.events || []).map(toCachedEvent),
    };
  }
  return { usedAt: entry?.usedAt, providers };
}

// Builds a lazy, TTL-cached task-list discovery function scoped to one registerWidgetRoutes call
// (a fresh Map per call, not a module-level singleton) so separate server instances/tests never
// share stale results. A failed discovery is never written to the cache, so the very next call
// retries it rather than remembering the failure for the rest of the TTL.
function createTaskListCache(discoverTaskLists) {
  const byAccount = new Map();
  return async function getTaskLists(account, { now, forceRefresh = false } = {}) {
    const nowMs = now.getTime();
    const cached = byAccount.get(account.id);
    if (cached && !forceRefresh && nowMs < cached.expiresAt) {
      return cached.lists;
    }
    const lists = await discoverTaskLists(account.server, account.username, account.password, account.id);
    byAccount.set(account.id, { lists, expiresAt: nowMs + TASK_LIST_CACHE_TTL_MS });
    return lists;
  };
}

// Discovers task lists for every configured CalDAV account and flattens them into {account, list}
// pairs. One account's discovery failing lands in `errors` (keyed by accountId, since there's no
// listId yet to blame) rather than failing the others.
async function collectListEntries(deps, getTaskLists, now, { forceRefresh = false } = {}) {
  const accounts = deps.getCaldavAccounts() || [];
  const entries = [];
  const errors = [];
  for (const account of accounts) {
    let lists;
    try {
      lists = await getTaskLists(account, { now, forceRefresh });
    } catch (err) {
      errors.push({ listId: account.id, message: err?.message || 'Task list discovery failed' });
      continue;
    }
    for (const list of lists) entries.push({ account, list });
  }
  return { entries, errors };
}

// Registers the widget's server API on `app`; must run before session middleware (never touches req.session).
export function registerWidgetRoutes(app, deps) {
  const checkAuthorized = (req, res) => {
    if (deps.isAuthorized && !deps.isAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  // One cache per registration, shared by all three task routes below.
  const getTaskLists = createTaskListCache(deps.discoverTaskLists);

  app.get('/api/widget/events', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!checkAuthorized(req, res)) return;

    const { start, end } = req.query;
    const startDate = parseLocalDateStrict(typeof start === 'string' ? start : '');
    const endDate = parseLocalDateStrict(typeof end === 'string' ? end : '');
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'start and end are required, as YYYY-MM-DD dates' });
    }

    const days = daysBetween(start, end);
    if (days <= 0) return res.status(400).json({ error: 'end must be after start' });
    if (days > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `range must be at most ${MAX_RANGE_DAYS} days` });
    }

    const rangeKey = `${start}|${end}`;

    // One outer try/catch: an uncaught throw after an await here would otherwise crash the process.
    try {
      const now = deps.now();
      const nowIso = now.toISOString();
      const timeMin = startDate.toISOString();
      const timeMax = endDate.toISOString();

      // A cache read failure degrades to "no cache" rather than crashing the process.
      let cache = { ranges: {} };
      try {
        cache = await deps.cacheStore.load();
      } catch (err) {
        console.error('widget cache load failed:', err?.message || err);
      }
      const cachedEntry = cache.ranges?.[rangeKey];

      const tokensAtStart = deps.getTokens() || {};
      const tokensSnapshotJson = JSON.stringify(tokensAtStart);
      const tokens = { ...tokensAtStart };
      const sessionLike = { tokens };

      let fresh;
      try {
        fresh = await deps.getUnifiedEvents(
          sessionLike,
          timeMin,
          timeMax,
          deps.getFeeds(),
          deps.getSettings().providers,
          deps.getGoogleCalendars(),
          deps.getCaldavAccounts()
        );
      } catch (err) {
        if (!cachedEntry) {
          return res.status(502).json({ error: err?.message || 'Failed to fetch events' });
        }
        const message = err?.message || 'Failed to fetch events';
        fresh = {
          events: [],
          errors: Object.keys(cachedEntry.providers || {}).map((provider) => ({ provider, message })),
        };
      }

      if (JSON.stringify(tokens) !== tokensSnapshotJson) {
        deps.saveTokens(tokens);
      }

      const merged = mergeEventsWithCache(fresh, cachedEntry, nowIso);

      // mergeRange re-reads on-disk state itself rather than writing back a possibly-stale `cache` snapshot.
      try {
        await deps.cacheStore.mergeRange(rangeKey, toCachedEntry(merged.nextEntry), MAX_CACHED_RANGES);
      } catch (err) {
        console.error('widget cache save failed:', err?.message || err);
      }

      const calendars = deps.listCalendars(sessionLike) || [];
      const calendarNames = {};
      for (const c of calendars) calendarNames[c.id] = c.name;

      const importantIds = new Set(deps.getSettings().importantEvents || []);
      const widgetEvents = merged.events.map((ev) => toWidgetEvent(ev, { importantIds, calendarNames }));

      res.json({
        generatedAt: nowIso,
        range: { start, end },
        calendars: calendars.map((c) => ({ id: c.id, name: c.name, color: c.color })),
        events: widgetEvents,
        errors: fresh.errors || [],
        stale: merged.stale,
        syncedAt: merged.syncedAt,
      });
    } catch (err) {
      console.error('widget events handler failed:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post(
    '/api/widget/important',
    (req, res, next) => {
      // Runs before express.json() so an unauthenticated caller's body is never read.
      res.set('Cache-Control', 'no-store');
      if (!checkAuthorized(req, res)) return;
      next();
    },
    express.json({ limit: '2kb' }),
    (err, req, res, next) => {
      // A malformed body (bad JSON, or a non-object value) lands here instead of the handler below.
      if (err) return res.status(400).json({ error: 'invalid request body' });
      next();
    },
    (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { id, important } = body;
      const error = importantBodyError(body);
      if (error) return res.status(400).json({ error });

      deps.setEventImportant(id, important);
      res.json({ id, important });
    }
  );

  app.get('/api/widget/tasks', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!checkAuthorized(req, res)) return;

    // One outer try/catch, same reasoning as GET /api/widget/events: an uncaught throw after an
    // await here would otherwise crash the process.
    try {
      const now = deps.now();
      const { entries, errors } = await collectListEntries(deps, getTaskLists, now);

      const lists = entries.map(({ account, list }) => ({
        id: list.id,
        name: list.name,
        accountId: account.id,
        url: list.url,
      }));

      const tasks = [];
      for (const { account, list } of entries) {
        try {
          const listTasks = await deps.fetchCalDavTasks(account, list);
          tasks.push(...listTasks);
        } catch (err) {
          // One list failing must not fail the whole response — the others still get returned.
          errors.push({ listId: list.id, message: err?.message || 'Failed to fetch tasks' });
        }
      }

      res.json({ tasks, lists, syncedAt: now.toISOString(), errors });
    } catch (err) {
      console.error('widget tasks handler failed:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post(
    '/api/widget/tasks',
    (req, res, next) => {
      // Runs before express.json() so an unauthenticated caller's body is never read.
      res.set('Cache-Control', 'no-store');
      if (!checkAuthorized(req, res)) return;
      next();
    },
    express.json({ limit: '2kb' }),
    (err, req, res, next) => {
      if (err) return res.status(400).json({ error: 'invalid request body' });
      next();
    },
    async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const bodyError = addTaskBodyError(body);
      if (bodyError) return res.status(400).json({ error: bodyError });

      // Parsed before any discovery: a malformed text is a 400 that needs no network round trip.
      const now = deps.now();
      let parsed;
      try {
        parsed = parseQuickAdd(body.text, { now });
      } catch (err) {
        // Throws on an empty title (e.g. whitespace-only text) or two +list tokens — a 400, not a 500.
        return res.status(400).json({ error: err.message });
      }

      try {
        let { entries } = await collectListEntries(deps, getTaskLists, now);
        // The list may have been created after the cache was last populated — one forced retry
        // before giving up, rather than making the client wait out a full TTL for a list it just made.
        const rediscover = async () => {
          ({ entries } = await collectListEntries(deps, getTaskLists, now, { forceRefresh: true }));
        };

        // Precedence: a +token in the text > an explicit listId > the first discovered list. The
        // widget sends its single selected list chip as listId, so typing +name still overrides it.
        let target;
        if (parsed.listToken !== null) {
          const nameOf = (e) => e.list.name;
          let resolved = resolveListToken(parsed.listToken, entries, nameOf);
          if (resolved.reason === 'unknown') {
            await rediscover();
            resolved = resolveListToken(parsed.listToken, entries, nameOf);
          }
          // 400, not the listId path's 404: the client sent text it can fix, not a resource id.
          if (!resolved.list) return res.status(400).json({ error: resolved.error });
          target = resolved.list;
        } else if (body.listId) {
          target = entries.find((e) => e.list.id === body.listId);
          if (!target) {
            await rediscover();
            target = entries.find((e) => e.list.id === body.listId);
          }
          // Unknown listId -> 404 (it names a specific resource that doesn't exist), as opposed
          // to 400 which this route uses for malformed request shape.
          if (!target) return res.status(404).json({ error: `Unknown list id: ${body.listId}` });
        } else {
          target = entries[0];
          if (!target) return res.status(400).json({ error: 'No task list is configured yet' });
        }

        const fields = {
          title: parsed.title,
          notes: '',
          due: parsed.due,
          dueHasTime: parsed.dueHasTime,
          start: null,
          priority: parsed.priority,
          categories: parsed.categories,
          status: 'NEEDS-ACTION',
          percent: 0,
          completedAt: null,
          created: now.toISOString(),
        };

        const task = await deps.createCalDavTask(target.account, target.list, fields);
        res.status(201).json({ task });
      } catch (err) {
        console.error('widget task add failed:', err?.message || err);
        res.status(502).json({ error: err?.message || 'Failed to create task' });
      }
    }
  );

  app.post(
    '/api/widget/tasks/complete',
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (!checkAuthorized(req, res)) return;
      next();
    },
    express.json({ limit: '2kb' }),
    (err, req, res, next) => {
      if (err) return res.status(400).json({ error: 'invalid request body' });
      next();
    },
    async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const bodyError = completeTaskBodyError(body);
      if (bodyError) return res.status(400).json({ error: bodyError });

      try {
        const now = deps.now();
        const { entries } = await collectListEntries(deps, getTaskLists, now);

        // The id alone doesn't say which list/account it lives in, so — same cost as a GET —
        // every list is fetched until the task turns up.
        let found = null;
        let foundEntry = null;
        for (const entry of entries) {
          let listTasks;
          try {
            listTasks = await deps.fetchCalDavTasks(entry.account, entry.list);
          } catch {
            continue; // a list we can't read right now just isn't where the task turns up
          }
          const match = listTasks.find((t) => t.id === body.id);
          if (match) {
            found = match;
            foundEntry = entry;
            break;
          }
        }

        if (!found) return res.status(404).json({ error: 'Unknown task id' });

        const fields = applyCompletion(found, body.completed, now);
        const task = await deps.updateCalDavTask(foundEntry.account, foundEntry.list, found, fields);
        res.json({ task });
      } catch (err) {
        const message = err?.message || 'Failed to update task';
        // updateCalDavTask throws this specific message on a 412 (etag mismatch) — surface it as
        // 409 Conflict rather than the generic 502 below.
        if (message.includes('changed on the server')) {
          return res.status(409).json({ error: message });
        }
        console.error('widget task complete failed:', message);
        res.status(502).json({ error: message });
      }
    }
  );
}
