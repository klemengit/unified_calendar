# Calendar Clock — an Omarchy bar widget

Omarchy's own top-bar clock, with this project's events built into it. The bar
still shows the time and the panel still looks like Omarchy's; what is added is:

- up to three event dots per day cell, in the theme's text colour
- important days filled with the theme's attention colour (`Color.bar.active`)
- a mark next to the clock label while today still has an important event ahead
- click a day and the panel grows to show that day's events; click an event for
  its details inline
- a collapsed "★ N upcoming" line, opened on demand (`u`, or click it)
- desktop reminders at configurable offsets before an event
- a `Calendar | Tasks` tab (`s` to switch) with quick-add, filters, and
  tick-to-complete for the same CalDAV tasks the server exposes
- a task-due marker in the month grid, distinct from the event dots, and a dot
  next to the clock label when a task is overdue

It reads from, and for tasks also writes to, a **locally running**
unified_calendar server, and caches what it last saw, so the panel still shows
events and tasks when the server is down — with a "synced X ago" note. Nothing
is sent anywhere else.

## Requirements

- Omarchy 4 (Arch + Hyprland + Quickshell). The widget replaces the stock clock,
  so it is specific to this desktop and useless elsewhere.
- The unified_calendar server running locally — normally as a systemd **user**
  service on port 3000. `install.sh` sets that up for you.
- Node, for the server. A `mise` shim is preferred: the unit then keeps working
  across Node upgrades, where a version-pinned path would break.
- `jq` and `curl` (both are already Omarchy dependencies).

## Install

On a fresh Omarchy machine, from a clone of this repository:

    omarchy-widget/install.sh

That is the whole thing. It checks the machine, installs the Node dependencies,
writes and starts a `calendar.service` systemd **user** unit pointed at this
checkout, waits for the widget API to answer, reconciles the clock baseline,
deploys the plugin, points the widget at the server, installs the update hooks,
and offers the `SUPER + SHIFT + C` keybinding. Every step is re-runnable: run it
again after pulling and it repairs rather than duplicates.

    install.sh --port 8585      serve on a different port
    install.sh --yes            no prompts, for a scripted rollout
    install.sh --offline-cache  let the server keep a reduced event cache on disk
    install.sh --no-keybind     leave the Hyprland bindings alone
    install.sh --uninstall      put the machine back (your calendars are kept)

It never needs root, and writes only inside `$HOME` and this checkout. Anything
it replaces — the unit, `shell.json`, `bindings.lua` — is copied to a timestamped
`.bak-<date>` first.

### If your Omarchy is newer than the baseline

`upstream/` records the Omarchy clock this widget was last reconciled with.
On a machine running a different 4.x, the update check would otherwise read the
difference as "Omarchy changed its clock" on the first boot and pause a widget
that is fine. `install.sh` offers to adopt the local clock as the baseline, and
only concludes the widget is healthy after it has actually loaded and answered a
health probe. Adoption is recorded in tracked files, so `git diff
omarchy-widget/upstream/` always shows which Omarchy you are pinned to.

Adopting does **not** merge Omarchy's clock changes into the widget — the panel
is still built from the code it was written against. For a real reconciliation
see `UPDATING.md`; to adopt or check by hand:

    tools/rebaseline.sh --check     does the installed clock match the baseline?
    tools/rebaseline.sh             adopt it, after showing what differs

### Doing it by hand

    tools/deploy.sh          copy plugin/ into place and restart the shell
    tools/install-hooks.sh   register the post-update / post-boot checks

`deploy.sh` keeps the previous copy as `.unified.clock.prev`; `--rollback` puts
it back. Add `unified.clock` to the bar and remove `omarchy.clock` — both
register the same IPC target, so running them together makes health checks
ambiguous. If `bar.centerAnchor` in `~/.config/omarchy/shell.json` names
`omarchy.clock`, `deploy.sh` repoints it at `unified.clock`; otherwise the clock
drifts sideways whenever the hover-reveal icons appear.

## Settings

The widget's settings live in its entry in `~/.config/omarchy/shell.json`, edited
through Omarchy's own settings UI:

| Key | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:3000` | where the calendar server is. Must be http(s); anything else falls back to the default. |
| `calendars` | `[]` (all) | ids of the calendars to show. |
| `reminders` | `["1d", "15m"]` | offsets before an event to notify at. |
| `allDayReminderTime` | `"08:00"` | clock time an all-day event's reminder fires at. |
| `upcomingDays` | `30` (1–60) | how far ahead the "★ N upcoming" list looks. |
| `upcomingMax` | `5` (1–20) | how many entries that list shows. |
| `refreshMinutes` | `15` (5–240) | polling interval. Failures back off to 30 s, 30 s, 60 s, 120 s, 300 s, then this. |
| `navKeys` | see below | what the arrow keys and `hjkl` move by. |

`SUPER+SHIFT+C` opens the panel.

## Keys

| Key | Does |
|---|---|
| `h` `l` | previous / next **day** |
| `j` `k` | next / previous **week** |
| `←` `→` | previous / next **month** |
| `↑` `↓` | previous / next **year** |
| `[` `]` | previous / next month (fixed) |
| `{` `}` | previous / next year (fixed) |
| `t`, `Enter` | today |
| `w` | toggle the week start |
| `u` | toggle the upcoming list |
| `s` | switch the `Calendar` / `Tasks` tab |
| `Esc` | close the selected day, then the panel |

`s` rather than `Tab`: `Tab` already cycles the bar's own widgets, so binding
it here would fight that instead of switching tabs.

The first `h`/`j`/`k`/`l` press puts a day cursor on today — or on the 1st, if
you have browsed away from this month — and opens that day's events below the
grid. After that every key moves the cursor, coarse units included: with a day
selected `←` steps it a month, not the view. With no day selected the arrows
browse the month grid, which is what Omarchy's own clock does.

`navKeys` maps each key family to a unit per axis, so the two families can
cover different scales without a modifier:

```json
"navKeys": {
  "letters": { "horizontal": "day",  "vertical": "week"  },
  "arrows":  { "horizontal": "month", "vertical": "year" }
}
```

Units are `day`, `week`, `month`, `year` and `none` (the axis does nothing).
Those values are the defaults; anything unrecognised falls back to the default
for that slot, so a typo leaves the key working rather than dead. Giving
`letters` the same `month`/`year` pair as `arrows` restores the stock clock's
keys exactly — the day cursor is then reachable only by clicking.

## Tasks

The `Tasks` tab (`s` to get there) reads and writes the same CalDAV tasks the
server exposes at `/api/widget/tasks` — see the root
[`README.md`](../README.md#widget-api) for the request/response shapes and
what the CalDAV server itself will and won't keep.

The tab has a quick-add field (same grammar as the server's, see the root
README), filters for status (Open/Completed/All), task list, due bucket
(Overdue/Today/Week/No date), and category, and a checkbox on each task.
Ticking one is optimistic: the row flips immediately and rolls back if the
server rejects the change.

**Task lists.** When the account has more than one task list, a row of list
chips appears, one per list with its open-task count — empty lists included,
since the chips come from the server's list of lists rather than from the
tasks. Like the category chips, they filter (any selected list matches; none
selected means all lists), and each task shows its list's name in small text
beside the due date. With a single list both stay hidden.

Quick-add picks the list in this order:

1. a `+list` token in the text — `Prune the apple tree +garden due:friday`;
   case- and diacritic-insensitive, a unique prefix is enough, multi-word
   names take hyphens (`+home-repairs`);
2. the one selected list chip, if exactly one is selected;
3. the first list.

A `+list` token that matches nothing, or more than one list, is refused: the
text goes back into the field and the status line names the lists it could
have meant.

The refresh button beside the quick-add field (and the `calendarRefresh` IPC
call) also makes the server re-discover task lists, which it otherwise caches
for an hour — use it after creating a list elsewhere.

Days with an open task due get a marker in the month grid — a different shape
and position from the event dots, so the two never read as the same thing —
and those tasks are listed and tickable in that day's details alongside its
events. The bar clock itself only grows an overdue dot when something actually
is overdue; otherwise the clock looks exactly as it did before Tasks existed.

## IPC

    omarchy-shell omarchy.clock calendarHealth     # JSON: {ok, loadedAt, ...}
    omarchy-shell omarchy.clock calendarRefresh    # force a poll now (tasks and task lists too)
    omarchy-shell omarchy.clock selectDay <YYYY-MM-DD>
    omarchy-shell omarchy.clock toggleUpcoming

The target is `omarchy.clock`, not `unified.clock` — a cloned plugin keeps the
IPC identity of the plugin it was cloned from.

## Surviving Omarchy updates

Three of the plugin's files are copies of Omarchy's clock, so an Omarchy release
that touches that clock leaves this widget behind. `tools/check-omarchy.sh`
watches for exactly that. Installed by `tools/install-hooks.sh` as Omarchy
`post-update` and `post-boot` hooks, it compares the installed clock against
`upstream/SHA256SUMS` and checks that the widget actually loaded:

- unchanged and healthy → silence.
- changed, or the widget failed to load → the widget is switched off, the stock
  clock comes back, the bar anchor is repointed, and **one** notification
  appears. Clicking it opens the agent with `UPDATING.md`.

Nothing is merged or repaired unattended. `tools/check-omarchy.sh --status`
prints where things stand; `--resume` switches the widget back on after you have
updated it.

## Where the widget keeps things

| Path | Holds |
|---|---|
| `~/.cache/unified-calendar-widget/events.json` | the offline event cache |
| `~/.cache/unified-calendar-widget/tasks.json` | the offline task cache |
| `~/.local/state/unified-calendar-widget.json` | reminder state — which reminders have fired, and when the last check was |
| `~/.local/state/unified-calendar-widget/` | the update check's log and paused marker |

Both offline caches hold everything fetched exactly as the server returned it
— `events.json` whole event bodies, `notes` (descriptions), `location` and
`meetingUrl` included; `tasks.json` every task field — and both are written
unconditionally, with no setting to turn either off. They therefore share a
directory created mode `0700`, so no other local user can read them:
Quickshell's `FileView` has no permission property and its atomic write
renames a fresh temp file into place, so a file's own mode cannot be pinned
from QML. Delete a file to clear it; the next poll rewrites it.

A cache left at the pre-0.2 path `~/.cache/unified-calendar-widget.json` (the
events cache, before it moved into this directory) is moved into
`events.json` on first start. `tasks.json` has no such history — the tasks
feature shipped straight into the directory layout.

This is separate from the *server's* cache (`data/widget-cache.json`), which is
off unless `UNIFIED_CALENDAR_WIDGET_CACHE=1` and stores only reduced events —
tasks have no server-side cache at all.

## Tests

    node --test omarchy-widget/test/*.test.js
    QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input omarchy-widget/test-qml/tst_calendar_model.qml
    QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input omarchy-widget/test-qml/tst_data_model.qml

The `node --test` suite reads Omarchy's installed `Model.js` to check the month
grid matches Omarchy's own, so it needs Omarchy present.

## Uninstall

    omarchy-widget/install.sh --uninstall

Removes the hooks, rolls the bar back to Omarchy's own clock (restoring
`bar.centerAnchor` with it), drops the keybinding it added, and stops and removes
the service. Your calendars and settings in `data/` are kept, as is the widget's
own cache in `~/.cache/unified-calendar-widget/` — delete that yourself if you
want it gone.

## Provenance

See `NOTICE` — parts of this are Omarchy's MIT-licensed code.
