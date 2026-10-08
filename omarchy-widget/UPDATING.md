# Updating the calendar widget after an Omarchy clock change

`unified.clock` is a copy of Omarchy's own bar clock (`omarchy.clock`) with the
unified_calendar events built into it: event dots on the day cells, important
days filled with the attention colour, a day detail view, an upcoming list and a
mark next to the time in the bar. It lives in `omarchy-widget/plugin/` and is
deployed into `~/.config/omarchy/plugins/unified.clock/`.

Because three of its files are copies of Omarchy's clock, an Omarchy update that
touches that clock leaves us behind. `tools/check-omarchy.sh` notices this, pauses
the widget (Omarchy's stock clock comes back in the bar) and points here.

**`/usr/share/omarchy/` is read-only and must never be edited.** Everything below
reads from it and writes only inside this repository or into `~/.config/omarchy/`.

## What is a copy and what is ours

Copies of Omarchy's clock, kept as close to the original as possible:

- `plugin/BarWidget.qml`
- `plugin/Panel.qml`
- `plugin/Model.js` (unchanged so far)

Files that are entirely ours:

- `plugin/CalendarData.qml` — fetches and caches events from the server
- `plugin/DataModel.js`, `plugin/CalendarModel.js` — the data and date logic
- `plugin/DayCell.qml`, `plugin/DayDetails.qml`, `plugin/EventRow.qml`,
  `plugin/UpcomingList.qml` — the extra views

Our edits inside the copied files:

- `BarWidget.qml`: the `CalendarData` instance, `calendarData` passed to the panel
  in the panel injection, the important-day mark next to the clock label, the
  primary-instance election, the `TasksData` instance and its `refreshTasks`
  broadcast target, and the extra `IpcHandler` methods (`calendarHealth`,
  `calendarRefresh`, `selectDay`, `toggleUpcoming`).
- `Panel.qml`: the `calendarData` property and the day/upcoming state, the day-cell
  delegate replaced by `DayCell`, and the `DayDetails` and `UpcomingList` sections
  under the month navigation.
- `manifest.json`: our own id, name and `omarchy.clonedFrom: omarchy.clock`.

## 1. See what changed

Omarchy's change, per file (`BarWidget.qml`, `Panel.qml`, `Model.js`, `manifest.json`):

    diff -u omarchy-widget/upstream/<file> /usr/share/omarchy/shell/plugins/panels/clock/<file>

Our own patch on top of the old Omarchy version, same files:

    diff -u omarchy-widget/upstream/<file> omarchy-widget/plugin/<file>

The first diff is what has to be applied; the second is what has to survive it.

## 2. Apply Omarchy's change into plugin/

Work file by file. Take Omarchy's new code and put our additions back on top of
it, keeping the copied parts byte-identical to the new Omarchy version wherever
we have not deliberately changed them. If Omarchy rewrote something our code
hooks into, follow the new structure rather than forcing the old one back.

## 3. Refresh upstream/

Once `plugin/` is updated, record the Omarchy version it now follows:

    cp /usr/share/omarchy/shell/plugins/panels/clock/{BarWidget.qml,Panel.qml,Model.js,manifest.json} \
       omarchy-widget/upstream/
    cd omarchy-widget/upstream
    sha256sum BarWidget.qml Panel.qml Model.js manifest.json > SHA256SUMS
    pacman -Q omarchy > VERSION

`SHA256SUMS` must stay in `sha256sum` format (`<sha256>  <name>`, two spaces) and
`VERSION` holds the single `pacman -Q omarchy` line, for example `omarchy 4.0.3-1`.
`check-omarchy.sh` compares the clock directory against `SHA256SUMS`, so a widget
that is up to date and a `SHA256SUMS` that is not will keep it paused.

## 4. Run the checks

    node --test omarchy-widget/test/*.test.js
    QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input omarchy-widget/test-qml/tst_calendar_model.qml
    QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input omarchy-widget/test-qml/tst_data_model.qml
    /usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell -I /usr/lib/qt6/qml omarchy-widget/plugin/*.qml
    omarchy-plugin-validate omarchy-widget/plugin

`qmllint` exit code 255 is a syntax error and must be fixed; its warnings are fine.

## 5. Deploy and switch the widget back on

    omarchy-widget/tools/deploy.sh
    omarchy-widget/tools/check-omarchy.sh --resume

`deploy.sh` copies `plugin/` into place, restarts the shell and checks that the
widget answers and does not throw. `--resume` switches `unified.clock` back on,
pins the bar centre on it again, drops the paused marker and reports the health.
`check-omarchy.sh --status` prints where things stand at any time.

If the new version misbehaves:

    omarchy-widget/tools/deploy.sh --rollback
