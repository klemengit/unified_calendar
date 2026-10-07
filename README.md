# Unified Calendar

A full-stack web app that shows your **Microsoft Outlook** and **Google
Calendar** events together in one view — colour-coded by source, with
month / week / day toggles. No database: events are fetched live from each API
and cached client-side.

Two ways to add a calendar — use either or both:

1. **ICS subscription (no login)** — paste a published `.ics` URL. Zero setup,
   read-only, works immediately. Best for "just show me the events".
2. **OAuth login** — full Microsoft/Google sign-in via Passport.js. Needs the
   one-time app registration below, but always reflects your live calendar.

- **Backend:** Node.js + Express + Passport.js (OAuth2) + `node-ical`
- **Frontend:** vanilla JS + [FullCalendar](https://fullcalendar.io/) (via CDN)
- **APIs:** Microsoft Graph (`/me/calendarView`), Google Calendar v3, ICS feeds

A **⚙ Settings** page (top-right) manages everything in one place:
accounts (connect/disconnect Outlook & Google), ICS subscriptions (add/remove),
and calendar preferences — week start day, default view, 12/24-hour time, and
weekend visibility. Feeds, preferences and the OAuth tokens persist to `data/`
across restarts; events are fetched live on every request and their bodies are
not written to disk by the server. Two things do reach disk: the ids of the
events you star (kept in `data/settings.json`), and — when the widget's offline
cache is switched on — a reduced copy of each event. The desktop widget keeps a
fuller cache of its own; both are described under [Widget API](#widget-api)
below.

The **Calendars** sidebar lets you, per calendar:

- **Recolor** it (click the color swatch) — applies instantly.
- **Show/hide** it (checkbox) — filtered instantly in the browser.

Events are fetched once per visible date range and cached client-side, so
toggling visibility or changing colors is instant (no API round-trip).

Other niceties:

- **Sync:** the **⟳ Sync** button clears the cache and pulls fresh events.
- **Search:** press **`/`** to open a search box — filter events by title,
  description, location, or calendar; or jump to a date with natural language
  ("next monday", "june 2026", "2026-06-15").
- **Keyboard navigation:** **←** / **→** arrow keys move to the previous/next
  time period (week, month, or day depending on the current view).
- **Event details:** click any event for a popup with its calendar, time,
  location, description, and a link to open the original.
- **Day peek:** in month view, click an empty part of a day to open that day
  in a detailed timeline.
- **Create / edit events:** click an empty slot or drag to select a range;
  requires Google Calendar connected with write access.

| Source         | Colour   |
|----------------|----------|
| Outlook (work) | 🔵 blue  |
| Google         | 🟢 green |

---

## Mobile & PWA

The app is fully usable on a smartphone:

- The week view fills the screen; the **Calendars** sidebar slides in from the
  left via the **☰** hamburger button and can be dismissed by tapping the
  backdrop.
- The topbar collapses to just the essentials on small screens.

The app is also installable as a **Progressive Web App (PWA)**:

- On Android (Chrome): tap the browser menu → *Install app* (or *Add to Home Screen*).
- On iOS (Safari): tap Share → *Add to Home Screen*.

Once installed, the app shell (HTML, CSS, JS, and FullCalendar) is cached by
the service worker and loads instantly — even without an internet connection.
Events from the last sync are available offline via the client-side cache.

To force-refresh cached assets after an app update, bump `CACHE_NAME` in
`public/sw.js` from `cal-v1` to `cal-v2` (or any new value).

### Reminders

**⚙ Settings → Reminders** turns on push notifications for the device you are
on: a reminder a set time before each event, and one at a set hour for all-day
events, with a switch per calendar. The server sends them, so they arrive while
the app is closed, on phones (installed app) and desktop browsers alike — a
desktop browser has to be running to receive them. Turn them on once per device.

The server keeps its push key pair, the subscribed devices and hashes of the
reminders already sent in `data/push.json` (mode `0600`). Each reminder carries
the event's title, time and location; it is encrypted for the device, so the
browser's push service (Google's, for Chrome) relays it without being able to
read it.

---

## Optional password authentication

By default the app has no login — suitable for local use. To protect it when
running on a server, set `AUTH_PASSWORD` in your `.env`:

```ini
AUTH_PASSWORD=your-secret-password
```

When set:

- Every request is gated behind a login page.
- A successful login sets a signed, `HttpOnly` cookie that lasts **1 year**,
  so the device stays unlocked without re-entering the password.
- On HTTPS (`BASE_URL=https://...`) the cookie is also marked `Secure`.
- A **↩ sign-out** button appears in the top-right corner.
- Changing `AUTH_PASSWORD` immediately invalidates all existing sessions.

Leave `AUTH_PASSWORD` unset (or remove it) to disable authentication entirely.

---

## Reaching it from another machine

The app binds to **`127.0.0.1`** — this machine only. That is deliberate: with no
`AUTH_PASSWORD` set there is no login at all, and `data/settings.json` holds OAuth
refresh tokens and, for CalDAV, a password in plaintext. Listening on every
interface would hand a personal calendar to anyone who can reach the port.

`HOST=0.0.0.0` opens it up. Only do that together with `AUTH_PASSWORD`, and
preferably not on its own — the app speaks plain HTTP, so a password travels in
clear text across the network. Either of these is better:

- **A VPN — the simplest.** Leave `HOST` at `127.0.0.1` on the server and reach it
  over Tailscale/WireGuard, or through an SSH tunnel:
  `ssh -L 3000:127.0.0.1:3000 you@server`. Nothing is exposed publicly at all.
- **A TLS reverse proxy.** Caddy or nginx terminates HTTPS and forwards to
  `127.0.0.1:3000`; set `AUTH_PASSWORD` and `BASE_URL=https://...` so the session
  cookie is marked `Secure`.

Note that the Omarchy bar widget cannot authenticate: it fetches with plain `curl`
and sends no cookie, so it gets 401 on every poll against an install that sets
`AUTH_PASSWORD`. Run the widget against a loopback instance, not a protected one.

Starting with a non-loopback `HOST` and no `AUTH_PASSWORD` prints a warning on
boot; it does not stop the server.

---

## Widget API

Two JSON endpoints serve the desktop widget (`omarchy-widget/`). Both send
`Cache-Control: no-store`, never touch the session cookie, and — when
`AUTH_PASSWORD` is set — require the same `cal_auth` cookie as the web app
(otherwise `401`).

**`GET /api/widget/events?start=YYYY-MM-DD&end=YYYY-MM-DD`**

- `start` and `end` are plain calendar dates in the server's local timezone.
- `end` is **exclusive**: a single day is `start=2026-09-15&end=2026-09-16`.
- The range must be at least 1 and at most **100 days** (`400` otherwise).
- Returns `{ generatedAt, range, calendars, events, errors, stale, syncedAt }`.
  Each event is `{ id, title, start, end, allDay, calId, calendar, color,
  location, notes, meetingUrl, url, important }`.
- `stale` lists `{ provider, syncedAt }` for each provider that failed this
  round and was served from the cache instead; `syncedAt` is the oldest of
  those timestamps (or `generatedAt` when nothing is stale). With the cache off
  (the default) `stale` is always empty.
- `502` when the fetch fails and there is nothing cached to fall back on.

**`POST /api/widget/important`** — body `{ "id": "<event id>", "important":
true|false }` (JSON, max 2 KB). Stars/unstars one event, stored in
`data/settings.json`. Responds with the same `{ id, important }` pair.

### `UNIFIED_CALENDAR_WIDGET_CACHE` — offline event cache (off by default)

Set `UNIFIED_CALENDAR_WIDGET_CACHE=1` (or `true`) to let the widget keep
serving events while a provider is unreachable. It is the only event data the
**server** writes to disk, so it is opt-in:

- On: each queried range is written to `data/widget-cache.json` (mode `0600`),
  and a provider that fails is served from it and reported in `stale`.
- Only the fields a cached render needs are stored: `id`, `title`, `start`,
  `end`, `allDay`, `calId`, `color`, `source`. Descriptions, locations, meeting
  links, original URLs and CalDAV identifiers are **never** written.
- The file is bounded: at most 24 ranges and 1 MB, least-recently-used ranges
  dropped first.
- Off (unset, `0`, `false`): nothing is written, and the widget works exactly as
  before online — only the offline `stale` / `syncedAt` fallback is lost.

Both the cache and the rest of the persisted state live in `data/`, or in
`UNIFIED_CALENDAR_DATA_DIR` when that is set. Delete `data/widget-cache.json` at
any time; it is rebuilt on demand. A file left behind by an older build holds
full event bodies — restart the server first (`systemctl --user restart
calendar`) so the reducing code is live, then delete it, or a server still
running the old code rewrites it on the next widget poll.

This flag does **not** reach the desktop widget's own cache. Whatever the flag
is set to, the widget writes every range it fetched to
`~/.cache/unified-calendar-widget.json` exactly as the API returned it — full
event bodies, `notes` (descriptions), `location` and `meetingUrl` included — so
its panel can still render while the server is down. That copy is
unconditional: there is no setting that turns it off. Delete the file to clear
it (the widget rewrites it on the next poll).

---

## Running as a daily-driver service

The app is meant to run permanently in the background on port **3000** and be
managed with `systemctl`.

### Install the service (one-time)

`calendar.service` is a template: it cannot know where you cloned this or where
your `node` lives, so edit `WorkingDirectory` and `ExecStart` before copying it.

```bash
cp calendar.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/calendar.service   # set WorkingDirectory + ExecStart
systemctl --user daemon-reload
systemctl --user enable --now calendar
```

The service auto-starts on login and restarts if it crashes.

> **On Omarchy?** `omarchy-widget/install.sh` does all of the above — writing the
> unit with the right paths, picking the port, starting the service — and then
> installs the bar widget. See [`omarchy-widget/README.md`](omarchy-widget/README.md).

### Day-to-day commands

| What            | Command                                   |
|-----------------|-------------------------------------------|
| Open in browser | <http://localhost:3000>                   |
| Start           | `systemctl --user start calendar`         |
| Stop            | `systemctl --user stop calendar`          |
| Restart         | `systemctl --user restart calendar`       |
| Status          | `systemctl --user status calendar`        |
| Live logs       | `journalctl --user -u calendar -f`        |

### Desktop launcher (optional)

Installs a "Calendar" entry in your app launcher (GNOME, KDE, etc.):

```bash
cp calendar.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

Clicking it opens `http://localhost:3000` in your default browser (the service
must already be running).

---

## Option A — ICS subscription (no registration)

Want events showing in under a minute, without registering any app? Use this.

1. Start the service (see above), then open <http://localhost:3000>.
2. Expand **"➕ Subscribe to a calendar by ICS link"**, paste a published
   `.ics` URL, give it a label, click **Add**. Both `https://` and `webcal://`
   links work.
3. Get the `.ics` URL from your calendar:
   - **Outlook (web):** Settings → Calendar → **Shared calendars** →
     *Publish a calendar* → publish → copy the **ICS** link.
   - **Google Calendar:** Settings → click the calendar → **Integrate calendar**
     → copy **Secret address in iCal format**.

ICS feeds are read-only and fetched live. The OAuth options below give
richer/live access but need one-time setup.

---

## 1. Register the Microsoft Azure app (Outlook)

1. Go to the **Azure Portal** → <https://portal.azure.com> → search
   **"App registrations"** → **New registration**.
2. **Name:** anything, e.g. `Unified Calendar`.
3. **Supported account types:** choose
   *"Accounts in any organizational directory and personal Microsoft accounts"*
   (this matches `MICROSOFT_TENANT=common`). Pick *single tenant* only if it's
   solely for your org — then set `MICROSOFT_TENANT` to your tenant ID.
4. **Redirect URI:** platform **Web**, value:
   `http://localhost:3000/auth/microsoft/callback`
5. Click **Register**.
6. Copy the **Application (client) ID** → this is `MICROSOFT_CLIENT_ID`.
7. Left menu → **Certificates & secrets** → **New client secret** → copy the
   secret **Value** (not the Secret ID) → this is `MICROSOFT_CLIENT_SECRET`.
   ⚠ The value is shown only once.
8. Left menu → **API permissions** → **Add a permission** → **Microsoft Graph**
   → **Delegated permissions** → add **`Calendars.Read`** and **`User.Read`**
   → **Add permissions**.

## 2. Register the Google Cloud app (Google Calendar)

1. Go to the **Google Cloud Console** → <https://console.cloud.google.com> →
   create or select a project.
2. **APIs & Services** → **Library** → search **"Google Calendar API"** →
   **Enable**.
3. **APIs & Services** → **OAuth consent screen**:
   - User type **External** → Create.
   - Fill app name + your email; **Save and continue**.
   - **Scopes:** add `.../auth/calendar` (needed for read + write access).
   - **Test users:** add your own Google address (required while the app is in
     "Testing" mode).
4. **APIs & Services** → **Credentials** → **Create credentials** →
   **OAuth client ID**:
   - **Application type:** Web application.
   - **Authorised redirect URIs:** add
     `http://localhost:3000/auth/google/callback`
   - **Create**.
5. Copy the **Client ID** → `GOOGLE_CLIENT_ID` and the
   **Client secret** → `GOOGLE_CLIENT_SECRET`.

## 3. Where to paste the credentials

Copy the example env file and edit it:

```bash
cp .env.example .env
```

Open `.env` and fill in:

```ini
PORT=3000
BASE_URL=http://localhost:3000
SESSION_SECRET=<any long random string>

MICROSOFT_CLIENT_ID=...        # from Azure step 6
MICROSOFT_CLIENT_SECRET=...    # from Azure step 7
MICROSOFT_TENANT=common        # or your tenant ID for org-only

GOOGLE_CLIENT_ID=...           # from Google step 5
GOOGLE_CLIENT_SECRET=...       # from Google step 5

# Optional — protect the app with a password when hosting on a server:
# AUTH_PASSWORD=your-secret-password

# Optional — let the widget cache events on disk for offline use (off by default):
# UNIFIED_CALENDAR_WIDGET_CACHE=1
```

> The code reads these in `src/config.js`. You never edit source for
> credentials — everything lives in `.env`.

## 4. Run it locally

```bash
npm install
npm start          # or: npm run dev   (auto-restart on file changes)
```

Open <http://localhost:3000>. Click **Connect** next to Outlook and/or Google,
approve the consent screen, and your merged events appear.

---

### Notes & troubleshooting

- **`redirect_uri_mismatch`** → the URI in Azure/Google must *exactly* match
  `http://localhost:3000/auth/<provider>/callback` (scheme, port, path).
- **Google "access blocked / app not verified"** → add your account under
  *OAuth consent screen → Test users*.
- **Events disappear after ~1 hour** → access tokens expire; the app
  auto-refreshes using the refresh token. If a provider was connected before
  refresh tokens were granted, Disconnect and Connect again.
- **Only one calendar shows** → a per-provider error banner appears at the top
  describing which API failed and why; the other calendar still renders.
- **Changing `PORT`/`BASE_URL`?** Update the redirect URIs in Azure and Google
  to match, and update the `ExecStart` environment in `calendar.service`.
- **Hosting on a server?** Set `BASE_URL=https://your-domain.com` so OAuth
  callbacks and the `Secure` cookie flag work correctly. Add
  `AUTH_PASSWORD=...` to protect the app.
