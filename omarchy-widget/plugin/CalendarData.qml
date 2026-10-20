import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import "CalendarModel.js" as CalendarModel
import "DataModel.js" as DataModel

// Non-visual data service for the calendar clock.
QtObject {
  id: root

  property var settings: ({})
  property int weekStart: 1
  // Only the primary copy (one per monitor exists) sends reminders, runs the timed refresh and writes files
  property bool primary: true
  property int instances: 0

  readonly property var _settings: DataModel.parseSettings(root.settings)

  property var _rawEvents: [] // merged/deduped across loaded ranges, not yet filtered by calendars
  readonly property var events: CalendarModel.filterByCalendars(root._rawEvents, root._settings.calendars, root.calendars)
  property var calendars: []
  readonly property var dayIndex: CalendarModel.indexByDay(root.events)
  readonly property bool clockMark: CalendarModel.clockMarkVisible(root.events, clock.date.getTime())
  property string statusText: ""
  property bool loading: false
  property int revision: 0

  signal toggleSucceeded()

  onEventsChanged: root.revision = root.revision + 1

  property var _ranges: ({}) // rangeKey -> { fetchedAt, usedAt, data: parsed response }
  property var _requestedAt: ({}) // rangeKey -> ms of the last refresh()/ensureRange() request
  property string _homeRangeKey: ""
  property var _pendingFetches: [] // [{ start, end, key }], one in flight at a time
  property string _fetchingKey: ""
  property double _lastFullFetchMs: 0
  property bool _lastFetchOk: true
  property bool _serverReachable: true
  property string _lastError: ""
  property var _lastResponse: null
  property int _consecutiveFailures: 0
  property var _toggleQueue: [] // [{ id, flag }], queued while a toggle request is in flight
  property var _pendingToggle: null // { id, flag } for the request currently in flight
  property bool _toggleFailed: false

  property var _fired: ({}) // dedupe key -> baseMs, persisted
  property double _lastCheckMs: 0
  property bool _stateReady: false
  property double _loadedAtMs: 0

  onPrimaryChanged: {
    if (!root.primary) return
    // Another copy may have sent reminders since this one last read the state file
    root._stateReady = false
    stateFile.reload()
  }

  function _nowMs() {
    return new Date().getTime()
  }

  // ---- range fetching ---------------------------------------------------------

  function refresh(force) {
    var now = root._nowMs()
    if (!force && now - root._lastFullFetchMs < 60000) return
    root._lastFullFetchMs = now

    var home = CalendarModel.homeRange(now, root.weekStart, root._settings.upcomingDays)
    var homeStart = CalendarModel.dayKey(home.start)
    var homeEnd = CalendarModel.dayKey(home.end)
    root._homeRangeKey = DataModel.rangeKey(homeStart, homeEnd)
    root._requestedAt[root._homeRangeKey] = now
    root._enqueueFetch(homeStart, homeEnd)

    var cutoff = now - 10 * 60000
    var kept = {}
    kept[root._homeRangeKey] = now
    var mostRecentKey = ""
    var mostRecentAt = -Infinity
    var keys = Object.keys(root._requestedAt)
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]
      if (key === root._homeRangeKey || root._requestedAt[key] < cutoff) continue
      kept[key] = root._requestedAt[key]
      if (root._requestedAt[key] > mostRecentAt) {
        mostRecentAt = root._requestedAt[key]
        mostRecentKey = key
      }
    }
    if (mostRecentKey !== "") {
      var parts = mostRecentKey.split("|")
      if (parts.length === 2) root._enqueueFetch(parts[0], parts[1])
    }
    root._requestedAt = kept
  }

  function ensureRange(start, end) {
    var s = CalendarModel.dayKey(start)
    var e = CalendarModel.dayKey(end)
    var key = DataModel.rangeKey(s, e)
    var now = root._nowMs()
    root._requestedAt[key] = now

    // Not persisted here -- the next fetch or cache load will write it, and usedAt only matters in-memory for pruneRanges
    if (root._ranges[key]) root._ranges[key] = DataModel.touchUsedAt(root._ranges[key], now)

    if (DataModel.isRangeStale(root._ranges[key], now, root._settings.refreshMinutes)) {
      root._enqueueFetch(s, e)
    }
  }

  function _enqueueFetch(start, end) {
    var key = DataModel.rangeKey(start, end)
    if (key === root._fetchingKey) return
    root._pendingFetches = DataModel.enqueueRange(root._pendingFetches, { start: start, end: end, key: key }, root._homeRangeKey)
    root.loading = true
    root._pumpFetchQueue()
  }

  function _pumpFetchQueue() {
    if (root._fetchingKey !== "" || root._pendingFetches.length === 0) return
    var next = root._pendingFetches.shift()
    root._fetchingKey = next.key
    var url = DataModel.buildEventsUrl(root._settings.serverUrl, next.start, next.end)
    fetchProc.command = ["curl", "-fsS", "--max-time", "30", url]
    fetchProc.running = true
  }

  function _onFetchFinished(rawText) {
    var key = root._fetchingKey
    root._fetchingKey = ""
    var trimmed = String(rawText || "").trim()
    var parsed = trimmed !== "" ? DataModel.parseResponse(trimmed) : null

    if (!parsed) {
      root._lastFetchOk = false
      root._serverReachable = false
      root._lastError = trimmed === "" ? "fetch failed" : "invalid response"
      root._updateStatus(null)
      if (root.primary) {
        var retry = DataModel.nextRetry(root._consecutiveFailures, retryTimer.running, root._settings.refreshMinutes)
        root._consecutiveFailures = retry.failures
        if (retry.schedule) {
          retryTimer.interval = retry.delayMs
          retryTimer.restart()
        }
      }
    } else {
      root._lastFetchOk = true
      root._serverReachable = true
      root._lastError = ""
      root._consecutiveFailures = 0
      retryTimer.stop()
      var now = root._nowMs()
      root._ranges[key] = { fetchedAt: now, usedAt: now, data: parsed }
      root._ranges = DataModel.pruneRanges(root._ranges, 12, [root._homeRangeKey])
      root.calendars = parsed.calendars
      root._persistCache()
      root._rebuildEvents()
      root._updateStatus(parsed)
    }

    root._pumpFetchQueue()
    root.loading = root._fetchingKey !== "" || root._pendingFetches.length > 0
  }

  function _rebuildEvents() {
    root._rawEvents = DataModel.mergeLoadedRanges(root._ranges)
  }

  function _oldestSyncedAt() {
    var oldest = null
    var keys = Object.keys(root._ranges)
    for (var i = 0; i < keys.length; i++) {
      var r = root._ranges[keys[i]]
      var syncedAt = r && r.data && r.data.syncedAt
      // ISO 8601 UTC strings compare lexicographically in chronological order.
      if (syncedAt && (oldest === null || syncedAt < oldest)) oldest = syncedAt
    }
    return oldest
  }

  function _updateStatus(parsedOrNull) {
    if (parsedOrNull) root._lastResponse = parsedOrNull
    var now = root._nowMs()
    var syncedAtIso = parsedOrNull ? parsedOrNull.syncedAt : root._oldestSyncedAt()
    var syncedLabel = syncedAtIso ? CalendarModel.syncedAgoLabel(syncedAtIso, now) : ""
    root.statusText = DataModel.composeStatus({
      lastFetchOk: root._lastFetchOk,
      serverReachable: root._serverReachable,
      stale: parsedOrNull ? parsedOrNull.stale : [],
      errors: parsedOrNull ? parsedOrNull.errors : [],
      calendars: root.calendars,
      syncedLabel: syncedLabel,
      toggleFailed: root._toggleFailed
    })
  }

  function _refreshStatus() {
    root._updateStatus(root._lastFetchOk ? root._lastResponse : null)
  }

  // ---- read helpers -------------------------------------------------------------

  function dayInfo(key, todayKey) {
    return CalendarModel.dayInfo(root.dayIndex, key, todayKey)
  }

  function eventsForDay(key) {
    return root.dayIndex[key] || []
  }

  function upcoming() {
    return CalendarModel.upcomingImportant(root.events, root._nowMs(), root._settings.upcomingDays, root._settings.upcomingMax)
  }

  // ---- important toggle -----------------------------------------------------------

  function toggleImportant(id) {
    var target = null
    for (var i = 0; i < root.events.length; i++) {
      if (root.events[i] && root.events[i].id === id) {
        target = root.events[i]
        break
      }
    }
    if (!target) return

    var flag = !target.important
    root._rawEvents = CalendarModel.setImportant(root._rawEvents, id, flag)
    root._enqueueToggle(id, flag)
  }

  function _enqueueToggle(id, flag) {
    for (var i = 0; i < root._toggleQueue.length; i++) {
      if (root._toggleQueue[i].id === id) {
        root._toggleQueue[i].flag = flag
        return
      }
    }
    root._toggleQueue.push({ id: id, flag: flag })
    root._pumpToggleQueue()
  }

  function _pumpToggleQueue() {
    if (root._pendingToggle !== null || root._toggleQueue.length === 0) return
    var next = root._toggleQueue.shift()
    root._pendingToggle = next
    var url = DataModel.buildImportantUrl(root._settings.serverUrl)
    var payload = JSON.stringify({ id: next.id, important: next.flag })
    toggleProc.command = ["curl", "-fsS", "--max-time", "30", "--data-raw", payload, "-H", "Content-Type: application/json", url]
    toggleProc.running = true
  }

  function _onToggleFinished(rawText) {
    var pending = root._pendingToggle
    root._pendingToggle = null
    if (!pending) return

    var trimmed = String(rawText || "").trim()
    var ok = false
    if (trimmed !== "") {
      try {
        var parsed = JSON.parse(trimmed)
        ok = !!parsed && parsed.id === pending.id && parsed.important === pending.flag
      } catch (e) {
        ok = false
      }
    }

    if (ok) {
      toggleErrorTimer.stop()
    } else {
      root._rawEvents = CalendarModel.setImportant(root._rawEvents, pending.id, !pending.flag)
      toggleErrorTimer.restart()
    }
    root._toggleFailed = !ok
    root._refreshStatus()
    // Success is broadcast to every monitor's copy (see BarWidget.qml); a failure only needs to reconcile this copy
    if (ok) root.toggleSucceeded()
    else root.refresh(true)
    root._pumpToggleQueue()
  }

  // ---- links ------------------------------------------------------------------------

  function openUrl(url) {
    if (!DataModel.isSafeHttpsUrl(url)) return
    Quickshell.execDetached(["xdg-open", url])
  }

  // ---- diagnostics --------------------------------------------------------------------

  function health() {
    return JSON.stringify({
      ok: true,
      version: 1,
      loadedAt: root._loadedAtMs,
      events: root.events.length,
      ranges: Object.keys(root._ranges).length,
      statusText: root.statusText,
      clockMark: root.clockMark,
      lastError: root._lastError,
      primary: root.primary,
      instances: root.instances,
      colors: {
        attention: String(Commons.Color.bar.active),
        background: String(Commons.Color.background),
        foreground: String(Commons.Color.foreground)
      }
    })
  }

  // ---- reminders --------------------------------------------------------------------

  function sendReminder(ev, offsetMs, prefix) {
    var text = CalendarModel.reminderText(ev, offsetMs, root._settings.allDayReminderTime, root._nowMs())
    var notification = DataModel.reminderNotification(text, ev, prefix)
    if (!notification) return null
    Quickshell.execDetached(notification.argv)
    return { label: notification.label, hasMeeting: notification.hasMeeting }
  }

  function _checkReminders() {
    if (!root.primary || !root._stateReady) return
    var now = root._nowMs()
    var since = DataModel.reminderSince(root._lastCheckMs, now)
    var offsetsMs = CalendarModel.parseOffsets(root._settings.reminders)
    var due = CalendarModel.dueReminders(root.events, offsetsMs, root._settings.allDayReminderTime, since, now, root._fired)

    for (var i = 0; i < due.length; i++) {
      var item = due[i]
      root.sendReminder(item.ev, item.offsetMs, "")

      var covered = Array.isArray(item.coveredKeys) && item.coveredKeys.length > 0 ? item.coveredKeys : [item.key]
      for (var c = 0; c < covered.length; c++) root._fired[covered[c]] = item.baseMs
    }

    root._fired = DataModel.pruneFired(root._fired, now)
    root._lastCheckMs = now
    root._persistState()
  }

  // ---- offline cache ------------------------------------------------------------------

  // The cache holds whole event bodies -- titles, descriptions, locations and meeting URLs -- so it
  // lives in a 0700 directory of its own. FileView has no permission property and its atomic write
  // renames a fresh temp file into place, so the file's own mode cannot be held down from here; the
  // directory is what keeps other local users out.
  property string _cacheDir: Quickshell.env("HOME") + "/.cache/unified-calendar-widget"
  property string _cachePath: root._cacheDir + "/events.json"

  // Creates that directory and moves any pre-0.2 cache into it. Fire-and-forget: the first write
  // only happens after a fetch returns, by which time this has long finished, and a write that did
  // lose the race is retried by the next poll.
  function _prepareCacheDir() {
    var old = Quickshell.env("HOME") + "/.cache/unified-calendar-widget.json"
    cacheDirProc.command = [
      "bash",
      "-c",
      'mkdir -m 700 -p "$1" && chmod 700 "$1" && if [ -f "$2" ]; then if [ -f "$3" ]; then rm -f -- "$2"; else mv -f -- "$2" "$3"; fi; fi',
      "unified-calendar-widget",
      root._cacheDir,
      old,
      root._cachePath
    ]
    cacheDirProc.running = true
  }

  function _persistCache() {
    if (!root.primary) return
    cacheFile.setText(JSON.stringify({ version: 1, ranges: root._ranges }))
  }

  function _latestCalendarsFromRanges() {
    var best = null
    var bestFetchedAt = -Infinity
    var keys = Object.keys(root._ranges)
    for (var i = 0; i < keys.length; i++) {
      var r = root._ranges[keys[i]]
      if (!r || !r.data || !Array.isArray(r.data.calendars)) continue
      var fetchedAt = Number(r.fetchedAt)
      if (!isFinite(fetchedAt)) fetchedAt = 0
      if (fetchedAt >= bestFetchedAt) {
        bestFetchedAt = fetchedAt
        best = r.data.calendars
      }
    }
    return best !== null ? best : root.calendars
  }

  function _onCacheLoaded(rawText) {
    var parsed
    try {
      parsed = JSON.parse(rawText)
    } catch (e) {
      return
    }
    if (!parsed || parsed.version !== 1 || !parsed.ranges || typeof parsed.ranges !== "object") return

    // Merged, not replaced: a fetch already in flight must not be clobbered by a stale cached copy
    var merged = {}
    var existingKeys = Object.keys(root._ranges)
    for (var i = 0; i < existingKeys.length; i++) merged[existingKeys[i]] = root._ranges[existingKeys[i]]

    var cachedKeys = Object.keys(parsed.ranges)
    for (var j = 0; j < cachedKeys.length; j++) {
      var key = cachedKeys[j]
      var cached = parsed.ranges[key]
      var existing = merged[key]
      if (!existing || Number(cached && cached.fetchedAt) > Number(existing.fetchedAt)) merged[key] = cached
    }

    root._ranges = DataModel.pruneRanges(merged, 12, [root._homeRangeKey])
    root.calendars = root._latestCalendarsFromRanges()
    root._rebuildEvents()
    root._refreshStatus()
  }

  // ---- reminder state -----------------------------------------------------------------

  property string _statePath: Quickshell.env("HOME") + "/.local/state/unified-calendar-widget.json"

  function _persistState() {
    stateFile.setText(JSON.stringify({ version: 1, lastCheckMs: root._lastCheckMs, fired: root._fired }))
  }

  function _onStateLoaded(rawText) {
    var parsed
    try {
      parsed = JSON.parse(rawText)
    } catch (e) {
      return
    }
    if (!parsed || parsed.version !== 1) return
    var lastCheckMs = Number(parsed.lastCheckMs)
    root._lastCheckMs = isFinite(lastCheckMs) ? lastCheckMs : 0
    root._fired = parsed.fired && typeof parsed.fired === "object" ? parsed.fired : {}
  }

  // ---- wiring ---------------------------------------------------------------------------

  property SystemClock clock: SystemClock {
    precision: SystemClock.Minutes
    onDateChanged: root._refreshStatus()
  }

  property Process fetchProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root._onFetchFinished(text)
    }
  }

  property Process toggleProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root._onToggleFinished(text)
    }
  }

  property Process cacheDirProc: Process {
    // A migrated cache was already on disk when cacheFile first tried to read it, so re-read now.
    onExited: root.cacheFile.reload()
  }

  property FileView cacheFile: FileView {
    path: root._cachePath
    atomicWrites: true
    printErrors: false
    onLoaded: root._onCacheLoaded(text())
  }

  property FileView stateFile: FileView {
    path: root._statePath
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root._onStateLoaded(text())
      root._stateReady = true
    }
    onLoadFailed: root._stateReady = true
  }

  property Timer refreshTimer: Timer {
    interval: root._settings.refreshMinutes * 60000
    running: true
    repeat: true
    onTriggered: {
      if (root.primary) root.refresh(true)
      else root.cacheFile.reload()
    }
  }

  property Timer reminderTimer: Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root._checkReminders()
  }

  property Timer retryTimer: Timer {
    repeat: false
    onTriggered: {
      if (root.primary) root.refresh(true)
    }
  }

  property Timer toggleErrorTimer: Timer {
    interval: 30000
    onTriggered: {
      root._toggleFailed = false
      root._refreshStatus()
    }
  }

  Component.onCompleted: {
    root._loadedAtMs = root._nowMs()
    root._prepareCacheDir()
    root.refresh(true)
  }
}
