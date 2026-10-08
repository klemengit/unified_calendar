// QML script style: top-level var/function only; no import/export/class/Intl; local dates.
// Pure day-grouping helpers over Task[] (see the shared contract's Task shape) for wiring tasks
// into the month grid (DayCell's due marker) and the day-details list (DayDetails). Kept as its
// own file rather than added to TaskModel.js/TasksDataModel.js, which are out of this unit's
// scope to edit -- and, like TaskModel.js already does for CalendarModel.js's date parsing, this
// duplicates the small local-day helpers it needs rather than importing another QML JS resource
// (each file loaded via `import "X.js" as X` is its own namespace).

// ---- date parsing (duplicated from TaskModel.parseTaskDueDate -- see the header comment above
//      for why this can't just import that file) ------------------------------------------------

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
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null
    }
    return date
  }

  var parsed = new Date(value)
  var ms = parsed.getTime()
  return isFinite(ms) ? parsed : null
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n)
}

// Local 'YYYY-MM-DD' for a Date -- mirrors CalendarModel.dayKey.
function dayKeyFor(date) {
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
}

// True on either encoding a stale/partial cache might carry -- mirrors TaskModel.isCompleted.
function isCompleted(task) {
  return !!(task && (task.completed === true || task.status === "COMPLETED"))
}

// null when the task has no (parseable) due date, else the local calendar-day key it falls due on.
function taskDueDayKey(task) {
  var due = parseTaskDueDate(task && task.due)
  return due ? dayKeyFor(due) : null
}

// ---- grouping -------------------------------------------------------------------------------

// Task[] due on the local calendar day `key`, any status -- used by DayDetails, which shows a
// completed task due that day too so its tick can be undone in place, same as the Tasks tab does.
function tasksDueOnDay(tasks, key) {
  var list = Array.isArray(tasks) ? tasks : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var task = list[i]
    if (task && taskDueDayKey(task) === key) out.push(task)
  }
  return out
}

// dayKey -> true, for every local calendar day that has at least one OPEN (not completed) task
// due -- drives the month-grid marker. A day whose only due task is already COMPLETED never sets
// a key here, so DayCell must not mark it.
function openDueDayIndex(tasks) {
  var list = Array.isArray(tasks) ? tasks : []
  var index = {}
  for (var i = 0; i < list.length; i++) {
    var task = list[i]
    if (!task || isCompleted(task)) continue
    var key = taskDueDayKey(task)
    if (key) index[key] = true
  }
  return index
}
