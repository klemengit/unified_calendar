// Pure fetch/cache/status helpers for TasksData.qml. Same style rules as DataModel.js (this
// unit's own file -- TasksData.qml can't reuse DataModel.js's private helpers since each QML JS
// resource is its own namespace, see the header comment in TaskModel.js). No I/O, no Date.now():
// every function that needs "now" takes it from the caller.

// ---- small shared helpers ---------------------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value !== ""
}

function stripTrailingSlashes(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\/+$/, "")
}

// ---- URLs -------------------------------------------------------------------------------

// `refreshLists` asks the server to re-run task-list discovery instead of answering from its
// one-hour cache -- what the manual refresh uses, so a list just created on the server shows up.
function buildTasksUrl(serverUrl, refreshLists) {
  return stripTrailingSlashes(serverUrl) + "/api/widget/tasks" + (refreshLists === true ? "?refresh=lists" : "")
}

function buildTasksCompleteUrl(serverUrl) {
  return stripTrailingSlashes(serverUrl) + "/api/widget/tasks/complete"
}

// ---- Task sanitizing ----------------------------------------------------------------------

function sanitizeCategories(value) {
  var list = Array.isArray(value) ? value : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var name = String(list[i] === undefined || list[i] === null ? "" : list[i]).trim()
    if (name !== "") out.push(name)
  }
  return out
}

function sanitizeString(value, fallback) {
  return typeof value === "string" ? value : fallback
}

function sanitizeNumber(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

// Defensive coercion into the shared Task shape (see the shared contract's Task object) so a
// partial/malformed server response can't crash a QML binding that reads e.g. `task.categories.length`.
// Returns null when the object is missing what a Task needs to be addressable (`id`).
function sanitizeTask(candidate) {
  if (!isPlainObject(candidate) || !isNonEmptyString(candidate.id)) return null

  var status = sanitizeString(candidate.status, "NEEDS-ACTION")
  return {
    id: candidate.id,
    uid: sanitizeString(candidate.uid, ""),
    title: isNonEmptyString(candidate.title) ? candidate.title : "(no title)",
    notes: sanitizeString(candidate.notes, ""),
    status: status,
    completed: candidate.completed === true || status === "COMPLETED",
    completedAt: isNonEmptyString(candidate.completedAt) ? candidate.completedAt : null,
    due: isNonEmptyString(candidate.due) ? candidate.due : null,
    dueHasTime: candidate.dueHasTime === true,
    start: isNonEmptyString(candidate.start) ? candidate.start : null,
    priority: sanitizeNumber(candidate.priority, 0),
    percent: sanitizeNumber(candidate.percent, 0),
    categories: sanitizeCategories(candidate.categories),
    listId: sanitizeString(candidate.listId, ""),
    listName: sanitizeString(candidate.listName, ""),
    listUrl: sanitizeString(candidate.listUrl, ""),
    accountId: sanitizeString(candidate.accountId, ""),
    etag: isNonEmptyString(candidate.etag) ? candidate.etag : null
  }
}

function sanitizeList(candidate) {
  if (!isPlainObject(candidate) || !isNonEmptyString(candidate.id)) return null
  return {
    id: candidate.id,
    name: sanitizeString(candidate.name, candidate.id),
    accountId: sanitizeString(candidate.accountId, ""),
    url: sanitizeString(candidate.url, "")
  }
}

// ---- response parsing ---------------------------------------------------------------------

// GET /api/widget/tasks -> { tasks, lists, syncedAt, errors }. Rejects a malformed response
// outright (mirrors DataModel.parseResponse); drops individual malformed tasks/lists instead of
// failing the whole thing, same reasoning as the server not letting one bad list fail the response.
function parseTasksListResponse(text) {
  if (typeof text !== "string" || text === "") return null

  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (!isNonEmptyString(parsed.syncedAt)) return null
  if (!Array.isArray(parsed.tasks)) return null
  if (!Array.isArray(parsed.lists)) return null
  if (!Array.isArray(parsed.errors)) return null

  var tasks = []
  for (var i = 0; i < parsed.tasks.length; i++) {
    var task = sanitizeTask(parsed.tasks[i])
    if (task) tasks.push(task)
  }

  var lists = []
  for (var j = 0; j < parsed.lists.length; j++) {
    var list = sanitizeList(parsed.lists[j])
    if (list) lists.push(list)
  }

  var errors = []
  for (var k = 0; k < parsed.errors.length; k++) {
    var err = parsed.errors[k]
    if (err && typeof err === "object") {
      errors.push({
        listId: sanitizeString(err.listId, ""),
        message: sanitizeString(err.message, "")
      })
    }
  }

  return { tasks: tasks, lists: lists, syncedAt: parsed.syncedAt, errors: errors }
}

// POST /api/widget/tasks and POST /api/widget/tasks/complete both respond with { task }.
function parseTaskResponse(text) {
  if (typeof text !== "string" || text === "") return null
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!isPlainObject(parsed)) return null
  return sanitizeTask(parsed.task)
}

// ---- local task-list edits (pure, mirrors CalendarModel.setImportant) --------------------

function isTaskCompleted(task) {
  return !!(task && (task.completed === true || task.status === "COMPLETED"))
}

// New array; the matching task gets completed/status/percent/completedAt flipped locally, ahead
// of the server's response, so the checkbox reacts on the click itself. `nowIso` backs
// `completedAt` when completed=true -- passed in, never computed here (no Date.now() in this file).
function applyOptimisticComplete(tasks, id, completed, nowIso) {
  var list = Array.isArray(tasks) ? tasks : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var task = list[i]
    if (task && task.id === id) {
      var copy = {}
      for (var key in task) copy[key] = task[key]
      copy.completed = !!completed
      copy.status = completed ? "COMPLETED" : "NEEDS-ACTION"
      copy.percent = completed ? 100 : 0
      copy.completedAt = completed ? (typeof nowIso === "string" ? nowIso : null) : null
      out.push(copy)
    } else {
      out.push(task)
    }
  }
  return out
}

// New array with `task` unshifted to the front -- used for the optimistic quick-add row.
function insertOptimisticTask(tasks, task) {
  var list = Array.isArray(tasks) ? tasks : []
  return [task].concat(list)
}

// New array without the task matching `id`.
function removeTaskById(tasks, id) {
  var list = Array.isArray(tasks) ? tasks : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || list[i].id !== id) out.push(list[i])
  }
  return out
}

// New array with the task matching `id` replaced by `newTask`. If nothing matched (the optimistic
// row it should replace was pruned by a refresh that landed in between), `newTask` is prepended
// instead of silently dropped.
function replaceTaskById(tasks, id, newTask) {
  var list = Array.isArray(tasks) ? tasks : []
  var out = []
  var found = false
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) {
      out.push(newTask)
      found = true
    } else {
      out.push(list[i])
    }
  }
  if (!found) out.unshift(newTask)
  return out
}

// ---- quick-add preview (cosmetic only) -----------------------------------------------------

// Best-effort, client-side mirror of ONLY the `@category` and `!priority` stripping from
// src/tasks.js's parseQuickAdd (see the shared contract's quick-add grammar) -- just enough to
// make the optimistic row look roughly like what the server will create. Due-date tokens
// (`due:friday`, weekday rollover, the Slovenian `D.M.` forms, timezone handling, ...) are
// deliberately NOT reimplemented here: that grammar is subtle and owned by the server, so the
// optimistic row simply shows no due date until the real parse comes back. This function is
// never authoritative -- the POST response's task always overwrites the optimistic guess.
function previewQuickAdd(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  var words = raw.split(/\s+/).filter(function (w) { return w !== "" })

  var titleWords = []
  var categories = []
  var priority = 0

  for (var i = 0; i < words.length; i++) {
    var word = words[i]
    var catMatch = word.match(/^@([A-Za-z0-9_-]+)$/)
    var prioMatch = word.match(/^!([1-9])$/)
    if (catMatch) {
      categories.push(catMatch[1])
    } else if (prioMatch) {
      priority = parseInt(prioMatch[1], 10)
    } else {
      titleWords.push(word)
    }
  }

  return { title: titleWords.join(" "), categories: categories, priority: priority }
}

// ---- status text ----------------------------------------------------------------------------

function taskListDisplayName(listId, lists) {
  var list = Array.isArray(lists) ? lists : []
  var id = listId === undefined || listId === null ? "" : String(listId)
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === id) return list[i].name !== undefined && list[i].name !== null ? String(list[i].name) : id
  }
  return id
}

// Builds the short status line shown under the task list; mirrors DataModel.composeStatus's
// shape (a failed local edit is prefixed, then sync/availability state).
function composeTasksStatus(input) {
  var data = isPlainObject(input) ? input : {}
  var lastFetchOk = !!data.lastFetchOk
  var serverReachable = data.serverReachable !== false
  var errors = Array.isArray(data.errors) ? data.errors : []
  var lists = Array.isArray(data.lists) ? data.lists : []
  var syncedLabel = typeof data.syncedLabel === "string" ? data.syncedLabel : ""

  var parts = []
  if (data.addFailed === true) parts.push("task not added")
  if (data.toggleFailed === true) parts.push("task not saved")

  if (lastFetchOk && errors.length === 0) return parts.join(" · ")

  if (!serverReachable) {
    parts.push("tasks unavailable")
    if (syncedLabel !== "") parts.push(syncedLabel)
    return parts.join(" · ")
  }

  var names = []
  for (var i = 0; i < errors.length; i++) {
    var name = taskListDisplayName(errors[i] && errors[i].listId, lists)
    if (name !== "") names.push(name + " unavailable")
  }

  if (syncedLabel !== "") parts.push(syncedLabel)
  if (names.length > 0) parts.push(names.join(", "))
  return parts.join(" · ")
}
