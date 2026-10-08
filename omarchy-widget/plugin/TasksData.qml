import QtQuick
import Quickshell
import Quickshell.Io
import "CalendarModel.js" as CalendarModel
import "DataModel.js" as DataModel
import "TasksDataModel.js" as TasksDataModel

// Non-visual data service for the Tasks tab. Mirrors CalendarData.qml's patterns closely (that
// file is the template for this one): Process + curl fetch, FileView + atomicWrites cache, a
// "primary" instance election so only one monitor's copy polls, and optimistic
// updates-with-rollback for local edits (see toggleComplete/_onToggleFinished, addTask/_onAddFinished,
// mirroring CalendarData's toggleImportant/_onToggleFinished).
//
// Unlike CalendarData there is no date-range cache here -- GET /api/widget/tasks returns every
// task in one shot (the server side note in SPEC.md: "24 objects is nothing"), so this is a
// single flat fetch rather than a range cache.
QtObject {
  id: root

  property var settings: ({})
  // Only the primary copy (one per monitor exists) polls and writes the cache file.
  property bool primary: true
  property int instances: 0

  property var tasks: []
  property var lists: []
  property string syncedAt: ""
  property string statusText: ""
  property bool loading: false
  property int revision: 0

  signal addSucceeded()
  signal addFailed(string text)

  readonly property string _serverUrl: DataModel.normalizeServerUrl(root.settings ? root.settings.serverUrl : undefined)

  onTasksChanged: root.revision = root.revision + 1

  property double _lastFullFetchMs: 0
  property bool _fetching: false
  property bool _lastFetchOk: true
  property bool _serverReachable: true
  property string _lastError: ""
  property var _lastErrors: []
  property int _consecutiveFailures: 0
  // Bumped on every local edit (and its server reply). A fetch that started before the latest bump
  // may predate the edit, so its result is dropped rather than overwriting the optimistic state.
  property int _editGen: 0
  property int _fetchGen: 0

  property var _toggleQueue: [] // [{ id, flag }], queued while a toggle request is in flight
  property var _pendingToggle: null
  property bool _toggleFailed: false

  property var _addQueue: [] // [{ tempId, text, listId }], queued while an add request is in flight
  property var _pendingAdd: null
  property bool _addFailed: false
  // The server's reason for refusing the last add (e.g. which lists a +token could mean), or "".
  property string _addError: ""
  property int _optimisticCounter: 0

  function _nowMs() {
    return new Date().getTime()
  }

  function _nowIso() {
    return new Date(root._nowMs()).toISOString()
  }

  function _refreshMinutes() {
    var n = Number(root.settings && root.settings.refreshMinutes)
    return isFinite(n) && n >= 5 ? n : 15
  }

  // ---- fetch --------------------------------------------------------------------------

  // `refreshLists` also makes the server re-discover task lists rather than answer from its
  // one-hour cache -- the manual refresh passes it, the timed poll does not.
  function refresh(force, refreshLists) {
    var now = root._nowMs()
    if (!force && now - root._lastFullFetchMs < 60000) return
    if (root._fetching) return
    root._lastFullFetchMs = now
    root._fetchGen = root._editGen
    root._fetching = true
    root.loading = true
    var url = TasksDataModel.buildTasksUrl(root._serverUrl, refreshLists === true)
    fetchProc.command = ["curl", "-fsS", "--max-time", "30", url]
    fetchProc.running = true
  }

  function _onFetchFinished(rawText) {
    root._fetching = false
    root.loading = false
    var trimmed = String(rawText || "").trim()
    var parsed = trimmed !== "" ? TasksDataModel.parseTasksListResponse(trimmed) : null

    if (!parsed) {
      root._lastFetchOk = false
      root._serverReachable = false
      root._lastError = trimmed === "" ? "fetch failed" : "invalid response"
      root._updateStatus()
      if (root.primary) {
        var retry = DataModel.nextRetry(root._consecutiveFailures, retryTimer.running, root._refreshMinutes())
        root._consecutiveFailures = retry.failures
        if (retry.schedule) {
          retryTimer.interval = retry.delayMs
          retryTimer.restart()
        }
      }
      return
    }

    root._lastFetchOk = true
    root._serverReachable = true
    root._lastError = ""
    root._consecutiveFailures = 0
    retryTimer.stop()
    if (root._fetchGen !== root._editGen) {
      // An edit landed while this request was in flight; its data may predate it. Fetch again.
      root._updateStatus()
      root.refresh(true)
      return
    }
    root.tasks = parsed.tasks
    root.lists = parsed.lists
    root.syncedAt = parsed.syncedAt
    root._lastErrors = parsed.errors
    root._persistCache()
    root._updateStatus()
  }

  function _updateStatus() {
    var now = root._nowMs()
    var syncedLabel = root.syncedAt !== "" ? CalendarModel.syncedAgoLabel(root.syncedAt, now) : ""
    root.statusText = TasksDataModel.composeTasksStatus({
      lastFetchOk: root._lastFetchOk,
      serverReachable: root._serverReachable,
      errors: root._lastErrors,
      lists: root.lists,
      syncedLabel: syncedLabel,
      toggleFailed: root._toggleFailed,
      addFailed: root._addFailed,
      addError: root._addError
    })
  }

  function _refreshStatus() {
    root._updateStatus()
  }

  // ---- quick add ------------------------------------------------------------------------

  // Optimistically inserts a placeholder task (see TasksDataModel.previewQuickAdd -- cosmetic
  // only, the server's parse is authoritative) and queues the real POST. `listId` may be "" to
  // use the server's default list; a `+list` token in the text overrides it on the server.
  function addTask(text, listId) {
    var trimmed = String(text === undefined || text === null ? "" : text).trim()
    if (trimmed === "") return

    root._editGen += 1
    root._optimisticCounter += 1
    var tempId = "optimistic-" + root._optimisticCounter
    var preview = TasksDataModel.previewQuickAdd(trimmed)
    var optimisticTask = {
      id: tempId,
      uid: "",
      title: preview.title !== "" ? preview.title : trimmed,
      notes: "",
      status: "NEEDS-ACTION",
      completed: false,
      completedAt: null,
      due: null,
      dueHasTime: false,
      start: null,
      priority: preview.priority,
      percent: 0,
      categories: preview.categories,
      // With a +token the list is the server's to resolve, so the placeholder claims none.
      listId: preview.listToken !== "" ? "" : (listId || ""),
      listName: "",
      listUrl: "",
      accountId: "",
      etag: null
    }
    root.tasks = TasksDataModel.insertOptimisticTask(root.tasks, optimisticTask)
    root._addQueue.push({ tempId: tempId, text: trimmed, listId: listId || "" })
    root._pumpAddQueue()
  }

  function _pumpAddQueue() {
    if (root._pendingAdd !== null || root._addQueue.length === 0) return
    var next = root._addQueue.shift()
    root._pendingAdd = next
    // `today` anchors due:today/friday/+3d to this machine's date; the server's clock zone can differ.
    var body = { text: next.text, today: Qt.formatDate(new Date(), "yyyy-MM-dd") }
    if (next.listId !== "") body.listId = next.listId
    var url = TasksDataModel.buildTasksUrl(root._serverUrl)
    var payload = JSON.stringify(body)
    // --fail-with-body rather than -f: a refused add still exits non-zero, but its { error } body
    // reaches _onAddFinished so the status line can say why.
    addProc.command = ["curl", "--fail-with-body", "-sS", "--max-time", "30", "--data-raw", payload, "-H", "Content-Type: application/json", url]
    addProc.running = true
  }

  function _onAddFinished(rawText) {
    var pending = root._pendingAdd
    root._pendingAdd = null
    if (!pending) return
    root._editGen += 1

    var trimmed = String(rawText || "").trim()
    var task = trimmed !== "" ? TasksDataModel.parseTaskResponse(trimmed) : null

    if (task) {
      root.tasks = TasksDataModel.replaceTaskById(root.tasks, pending.tempId, task)
      root._persistCache()
      root._addFailed = false
      root._addError = ""
      addErrorTimer.stop()
      root._refreshStatus()
      root.addSucceeded()
    } else {
      root.tasks = TasksDataModel.removeTaskById(root.tasks, pending.tempId)
      root._addFailed = true
      root._addError = TasksDataModel.parseErrorResponse(trimmed)
      addErrorTimer.restart()
      root._refreshStatus()
      root.addFailed(pending.text)
    }
    root._pumpAddQueue()
  }

  // ---- completion toggle -----------------------------------------------------------------

  function toggleComplete(id) {
    // A placeholder has no server id yet; posting "optimistic-N" would only fail and roll back.
    if (TasksDataModel.isOptimisticId(id)) return
    var target = null
    for (var i = 0; i < root.tasks.length; i++) {
      if (root.tasks[i] && root.tasks[i].id === id) {
        target = root.tasks[i]
        break
      }
    }
    if (!target) return

    var flag = !TasksDataModel.isTaskCompleted(target)
    root._editGen += 1
    root.tasks = TasksDataModel.applyOptimisticComplete(root.tasks, id, flag, root._nowIso())
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
    var url = TasksDataModel.buildTasksCompleteUrl(root._serverUrl)
    var payload = JSON.stringify({ id: next.id, completed: next.flag })
    toggleProc.command = ["curl", "-fsS", "--max-time", "30", "--data-raw", payload, "-H", "Content-Type: application/json", url]
    toggleProc.running = true
  }

  function _onToggleFinished(rawText) {
    var pending = root._pendingToggle
    root._pendingToggle = null
    if (!pending) return
    root._editGen += 1

    var trimmed = String(rawText || "").trim()
    var task = trimmed !== "" ? TasksDataModel.parseTaskResponse(trimmed) : null
    var ok = !!task && task.id === pending.id

    if (ok) {
      root.tasks = TasksDataModel.replaceTaskById(root.tasks, pending.id, task)
      root._persistCache()
      root._toggleFailed = false
      toggleErrorTimer.stop()
    } else {
      root.tasks = TasksDataModel.applyOptimisticComplete(root.tasks, pending.id, !pending.flag, root._nowIso())
      root._toggleFailed = true
      toggleErrorTimer.restart()
      // Reconcile with the server rather than trusting the rollback alone -- the request may
      // have landed after all (e.g. a timeout on the response, not the write).
      root.refresh(true)
    }
    root._refreshStatus()
    root._pumpToggleQueue()
  }

  // ---- offline cache --------------------------------------------------------------------

  // Shares the calendar widget's cache directory (0700, created idempotently by whichever data
  // service starts first) but writes its own file.
  property string _cacheDir: Quickshell.env("HOME") + "/.cache/unified-calendar-widget"
  property string _cachePath: root._cacheDir + "/tasks.json"

  function _prepareCacheDir() {
    cacheDirProc.command = ["bash", "-c", 'mkdir -m 700 -p "$1" && chmod 700 "$1"', "unified-calendar-widget-tasks", root._cacheDir]
    cacheDirProc.running = true
  }

  function _persistCache() {
    if (!root.primary) return
    cacheFile.setText(JSON.stringify({ version: 1, tasks: root.tasks, lists: root.lists, syncedAt: root.syncedAt }))
  }

  function _onCacheLoaded(rawText) {
    var parsed
    try {
      parsed = JSON.parse(rawText)
    } catch (e) {
      return
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) return
    // Non-primary copies never poll, so they rely on every reload to pick up the primary's
    // writes. Newer-or-equal wins; an older cache never clobbers fresher live data.
    if (!TasksDataModel.isCacheFresh(parsed.syncedAt, root.syncedAt)) return

    root.tasks = parsed.tasks
    root.lists = Array.isArray(parsed.lists) ? parsed.lists : []
    root.syncedAt = typeof parsed.syncedAt === "string" ? parsed.syncedAt : ""
    root._refreshStatus()
  }

  // ---- wiring ---------------------------------------------------------------------------

  property Process fetchProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root._onFetchFinished(text)
    }
  }

  property Process addProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root._onAddFinished(text)
    }
  }

  property Process toggleProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root._onToggleFinished(text)
    }
  }

  property Process cacheDirProc: Process {
    onExited: root.cacheFile.reload()
  }

  property FileView cacheFile: FileView {
    path: root._cachePath
    atomicWrites: true
    printErrors: false
    onLoaded: root._onCacheLoaded(text())
  }

  property Timer refreshTimer: Timer {
    interval: root._refreshMinutes() * 60000
    running: true
    repeat: true
    onTriggered: {
      if (root.primary) root.refresh(true)
      else root.cacheFile.reload()
    }
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

  property Timer addErrorTimer: Timer {
    interval: 30000
    onTriggered: {
      root._addFailed = false
      root._addError = ""
      root._refreshStatus()
    }
  }

  Component.onCompleted: {
    root._prepareCacheDir()
    root.refresh(true)
  }
}
