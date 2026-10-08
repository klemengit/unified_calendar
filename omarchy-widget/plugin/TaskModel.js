// QML script style: top-level var/function only; no import/export/class/Intl; local dates.
// Pure functions over Task[] (see the shared contract's Task shape) for TasksPanel-style UI.
// No I/O, no Date.now() -- every function that needs "now" takes nowMs from the caller.

var MS_PER_DAY = 86400000

// ---- date parsing (mirrors CalendarModel.js's parseEventDate; kept local since QML JS
//      resources don't import one another -- each file loaded via `import "X.js" as X` is
//      its own namespace) ----------------------------------------------------------------

// 'YYYY-MM-DD' -> local midnight; a full ISO timestamp -> parsed as an instant; anything
// malformed, empty or not a string -> null (degrade, never throw).
function parseTaskDueDate(value) {
  if (typeof value !== "string" || value === "") return null

  var m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    var year = parseInt(m[1], 10)
    var month = parseInt(m[2], 10)
    var day = parseInt(m[3], 10)
    var date = new Date(year, month - 1, day)
    // Reject dates the constructor silently rolled over (e.g. 2026-02-30).
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null
    }
    return date
  }

  var parsed = new Date(value)
  var ms = parsed.getTime()
  return isFinite(ms) ? parsed : null
}

function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// ---- small shared helpers ---------------------------------------------------------------

// True on either encoding a stale/partial cache might carry: the derived `completed` flag or
// the raw `status` string.
function isCompleted(task) {
  return !!(task && (task.completed === true || task.status === "COMPLETED"))
}

// 1..9 ascending (1 highest); 0/unset/invalid sorts after every real priority.
function priorityRank(task) {
  var p = task ? Number(task.priority) : 0
  if (!isFinite(p) || p <= 0) return 10
  return p
}

// null when the task has no (parseable) due date, else its instant in ms.
function taskDueMs(task) {
  var due = parseTaskDueDate(task && task.due)
  return due ? due.getTime() : null
}

// ---- dueBucket ----------------------------------------------------------------------------

// 'overdue' | 'today' | 'week' | 'later' | 'none'. Compares local calendar days (via
// localMidnight on both sides), not UTC slices -- a task due today must never read as overdue
// just because UTC has already rolled over to tomorrow (or not yet rolled over from yesterday).
// A COMPLETED task is never 'overdue'; a completed task whose due day is in the past falls
// through to 'later' instead (it's neither overdue nor upcoming).
function dueBucket(task, nowMs) {
  if (!task) return "none"
  var due = parseTaskDueDate(task.due)
  if (!due) return "none"

  var today = localMidnight(new Date(nowMs))
  var dueDay = localMidnight(due)
  var diffDays = Math.round((dueDay.getTime() - today.getTime()) / MS_PER_DAY)

  if (diffDays < 0) return isCompleted(task) ? "later" : "overdue"
  if (diffDays === 0) return "today"
  if (diffDays <= 7) return "week"
  return "later"
}

// Ordering used only by sortTasks, cheapest bucket first.
function dueBucketRank(bucket) {
  if (bucket === "overdue") return 0
  if (bucket === "today") return 1
  if (bucket === "week") return 2
  if (bucket === "later") return 3
  return 4 // 'none'
}

// ---- filterTasks --------------------------------------------------------------------------

// filters: { status: 'open'|'done'|'all', buckets: string[], categories: string[], lists: string[],
// search: string }. All five combine with AND. `categories` matches ANY listed category (OR) -- for
// filter chips, "show me errands OR research" is the useful behaviour; requiring every chip to
// match would make picking a second chip narrow results to (usually) nothing. `lists` holds list
// ids and works the same way (a task lives in exactly one list, so AND would always be empty).
function filterTasks(tasks, filters, nowMs) {
  var list = Array.isArray(tasks) ? tasks : []
  var f = filters || {}
  var status = f.status || "open"
  var buckets = Array.isArray(f.buckets) ? f.buckets : []
  var categories = Array.isArray(f.categories) ? f.categories : []
  var lists = Array.isArray(f.lists) ? f.lists : []
  var search = typeof f.search === "string" ? f.search.trim().toLowerCase() : ""

  var wantedBuckets = null
  if (buckets.length > 0) {
    // Object.create(null): a bucket/category literally "__proto__" must be an ordinary key.
    wantedBuckets = Object.create(null)
    for (var i = 0; i < buckets.length; i++) {
      wantedBuckets[String(buckets[i] === undefined || buckets[i] === null ? "" : buckets[i])] = true
    }
  }

  var wantedCategories = null
  if (categories.length > 0) {
    wantedCategories = Object.create(null)
    for (var c = 0; c < categories.length; c++) {
      var catText = String(categories[c] === undefined || categories[c] === null ? "" : categories[c]).toLowerCase()
      wantedCategories[catText] = true
    }
  }

  var wantedLists = null
  if (lists.length > 0) {
    wantedLists = Object.create(null)
    for (var l = 0; l < lists.length; l++) wantedLists[String(lists[l])] = true
  }

  var out = []
  for (var t = 0; t < list.length; t++) {
    var task = list[t]
    if (!task) continue

    var completed = isCompleted(task)
    if (status === "open" && completed) continue
    if (status === "done" && !completed) continue

    if (wantedBuckets && !wantedBuckets[dueBucket(task, nowMs)]) continue

    if (wantedLists && !wantedLists[String(task.listId === undefined || task.listId === null ? "" : task.listId)]) continue

    if (wantedCategories) {
      var cats = Array.isArray(task.categories) ? task.categories : []
      var matched = false
      for (var k = 0; k < cats.length; k++) {
        var catName = String(cats[k] === undefined || cats[k] === null ? "" : cats[k]).toLowerCase()
        if (wantedCategories[catName]) {
          matched = true
          break
        }
      }
      if (!matched) continue
    }

    if (search !== "") {
      var title = String(task.title === undefined || task.title === null ? "" : task.title).toLowerCase()
      var notes = String(task.notes === undefined || task.notes === null ? "" : task.notes).toLowerCase()
      if (title.indexOf(search) === -1 && notes.indexOf(search) === -1) continue
    }

    out.push(task)
  }
  return out
}

// ---- sortTasks ----------------------------------------------------------------------------

function compareTasks(a, b, nowMs) {
  var aCompleted = isCompleted(a) ? 1 : 0
  var bCompleted = isCompleted(b) ? 1 : 0
  if (aCompleted !== bCompleted) return aCompleted - bCompleted

  var aBucketRank = dueBucketRank(dueBucket(a, nowMs))
  var bBucketRank = dueBucketRank(dueBucket(b, nowMs))
  if (aBucketRank !== bBucketRank) return aBucketRank - bBucketRank

  var aDueMs = taskDueMs(a)
  var bDueMs = taskDueMs(b)
  if (aDueMs !== null && bDueMs !== null && aDueMs !== bDueMs) return aDueMs - bDueMs

  var aPriority = priorityRank(a)
  var bPriority = priorityRank(b)
  if (aPriority !== bPriority) return aPriority - bPriority

  var aTitle = String((a && a.title) || "").toLowerCase()
  var bTitle = String((b && b.title) || "").toLowerCase()
  if (aTitle < bTitle) return -1
  if (aTitle > bTitle) return 1
  return 0
}

// New array, stable, never mutates `tasks`: open before completed; within each, overdue first
// then due soonest then no-due-date; then priority (1 highest, unset last); then title.
function sortTasks(tasks, nowMs) {
  var list = Array.isArray(tasks) ? tasks.slice() : []
  list.sort(function (a, b) {
    return compareTasks(a, b, nowMs)
  })
  return list
}

// ---- categoryCounts -------------------------------------------------------------------------

// [{name, count}], sorted by count desc then name asc, for filter chips.
function categoryCounts(tasks) {
  var list = Array.isArray(tasks) ? tasks : []
  // Object.create(null): a category literally "__proto__" must be an ordinary key.
  var counts = Object.create(null)
  for (var i = 0; i < list.length; i++) {
    var task = list[i]
    var cats = task && Array.isArray(task.categories) ? task.categories : []
    for (var c = 0; c < cats.length; c++) {
      var name = String(cats[c] === undefined || cats[c] === null ? "" : cats[c]).trim()
      if (name === "") continue
      counts[name] = (counts[name] || 0) + 1
    }
  }

  var out = []
  for (var key in counts) out.push({ name: key, count: counts[key] })
  out.sort(function (a, b) {
    if (a.count !== b.count) return b.count - a.count
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })
  return out
}

// ---- task lists ---------------------------------------------------------------------------

// [{id, name, count}] for the list chips: one entry per list the server reported, in the server's
// order (the first is where a task lands by default, so it stays first), empty lists included --
// the chips are built from `lists`, not from tasks, or a freshly created list would be invisible.
// `count` is open tasks only: it is what is left to do in that list.
function listCounts(tasks, lists) {
  var taskList = Array.isArray(tasks) ? tasks : []
  var listList = Array.isArray(lists) ? lists : []

  var open = Object.create(null)
  for (var i = 0; i < taskList.length; i++) {
    var task = taskList[i]
    if (!task || isCompleted(task)) continue
    var key = String(task.listId === undefined || task.listId === null ? "" : task.listId)
    open[key] = (open[key] || 0) + 1
  }

  var out = []
  for (var j = 0; j < listList.length; j++) {
    var entry = listList[j]
    if (!entry || typeof entry.id !== "string" || entry.id === "") continue
    var name = typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.id
    out.push({ id: entry.id, name: name, count: open[entry.id] || 0 })
  }
  return out
}

// The selected list ids that still exist, in selection order. A list deleted on the server (or
// one a stale cache remembered) must not leave behind a selection that silently filters to zero.
function knownListIds(selected, lists) {
  var picked = Array.isArray(selected) ? selected : []
  var listList = Array.isArray(lists) ? lists : []
  var known = Object.create(null)
  for (var i = 0; i < listList.length; i++) {
    if (listList[i] && typeof listList[i].id === "string") known[listList[i].id] = true
  }
  var out = []
  for (var j = 0; j < picked.length; j++) {
    if (known[String(picked[j])]) out.push(String(picked[j]))
  }
  return out
}

// The listId quick-add sends: the one selected list chip, or "" (the server's default list) when
// none or several are selected -- with two lists picked there is no honest single answer.
function quickAddListId(selected) {
  return Array.isArray(selected) && selected.length === 1 ? String(selected[0]) : ""
}

// ---- counts for the bar clock / tab header ---------------------------------------------------

// Integer count of tasks currently in the 'overdue' bucket -- drives the bar clock's overdue dot.
function overdueCount(tasks, nowMs) {
  var list = Array.isArray(tasks) ? tasks : []
  var count = 0
  for (var i = 0; i < list.length; i++) {
    if (dueBucket(list[i], nowMs) === "overdue") count++
  }
  return count
}

// {open, done, overdue, dueToday} for the tab header. Like overdue, dueToday only counts open
// tasks -- a COMPLETED task due today needs no more attention, so it shouldn't inflate the count
// that tells the user what's still outstanding.
function summarize(tasks, nowMs) {
  var list = Array.isArray(tasks) ? tasks : []
  var open = 0
  var done = 0
  var overdue = 0
  var dueToday = 0

  for (var i = 0; i < list.length; i++) {
    var task = list[i]
    if (!task) continue

    var completed = isCompleted(task)
    if (completed) done++
    else open++

    var bucket = dueBucket(task, nowMs)
    if (bucket === "overdue") overdue++
    if (!completed && bucket === "today") dueToday++
  }

  return { open: open, done: done, overdue: overdue, dueToday: dueToday }
}
