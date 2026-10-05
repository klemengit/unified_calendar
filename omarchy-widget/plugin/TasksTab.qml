import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "TaskModel.js" as TaskModel

// Content of the Tasks tab: quick-add field, filter rows (status, list, due, category), task list. Panel.qml owns the
// Calendar | Tasks tab bar and switches this whole component in and out of view; this file is
// only what shows underneath once Tasks is selected.
Column {
  id: root

  property var tasksData: null
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  // Exposed so Panel.qml can block its PanelKeyCatcher while the quick-add field has focus --
  // the same wiring root.editingLife already uses for the birth-year/life-expectancy fields.
  readonly property bool editing: quickAddField.activeFocus

  property string filterStatus: "open"
  property var filterBuckets: []
  property var filterCategories: []
  property var filterLists: [] // list ids

  readonly property var bucketOptions: [
    { value: "overdue", label: "Overdue" },
    { value: "today", label: "Today" },
    { value: "week", label: "Week" },
    { value: "none", label: "No date" }
  ]

  readonly property var allTasks: root.tasksData && Array.isArray(root.tasksData.tasks) ? root.tasksData.tasks : []
  // Built from the server's `lists`, not from tasks, so an empty (e.g. just created) list still
  // gets a chip. With a single list there is nothing to choose, so the row and the per-task list
  // label both stay hidden.
  readonly property var listOptions: TaskModel.listCounts(root.allTasks, root.tasksData ? root.tasksData.lists : [])
  readonly property bool multipleLists: root.listOptions.length > 1
  // A selection the server no longer backs (list deleted, stale cache) is ignored, not obeyed.
  readonly property var activeListIds: TaskModel.knownListIds(root.filterLists, root.listOptions)
  // Built from every loaded task, not the filtered set, so a chip never disappears out from
  // under the user just because another filter narrowed the list to zero of that category.
  readonly property var categoryOptions: TaskModel.categoryCounts(root.allTasks)
  readonly property var filtered: TaskModel.filterTasks(root.allTasks, {
    status: root.filterStatus,
    buckets: root.filterBuckets,
    categories: root.filterCategories,
    lists: root.activeListIds,
    search: ""
  }, clock.date.getTime())
  readonly property var sorted: TaskModel.sortTasks(root.filtered, clock.date.getTime())

  function toggleBucket(value) {
    var idx = root.filterBuckets.indexOf(value)
    var next = root.filterBuckets.slice()
    if (idx === -1) next.push(value)
    else next.splice(idx, 1)
    root.filterBuckets = next
  }

  function toggleCategory(name) {
    var idx = root.filterCategories.indexOf(name)
    var next = root.filterCategories.slice()
    if (idx === -1) next.push(name)
    else next.splice(idx, 1)
    root.filterCategories = next
  }

  function toggleList(id) {
    var idx = root.filterLists.indexOf(id)
    var next = root.filterLists.slice()
    if (idx === -1) next.push(id)
    else next.splice(idx, 1)
    root.filterLists = next
  }

  function submitQuickAdd() {
    var text = quickAddField.text
    if (String(text).trim() === "") return
    // Cleared immediately (optimistic); TasksData.addFailed puts it back if the POST fails.
    quickAddField.text = ""
    // A single selected list chip is where the task goes; a +list token in the text still wins
    // (resolved on the server).
    if (root.tasksData) root.tasksData.addTask(text, TaskModel.quickAddListId(root.activeListIds))
  }

  spacing: Style.space(8)

  // Drives dueBucket/sort/row recomputation as minutes pass (a task due "today" must become
  // "overdue" the moment the calendar day rolls over, not just on the next poll).
  SystemClock {
    id: clock
    precision: SystemClock.Minutes
  }

  Connections {
    target: root.tasksData
    function onAddFailed(text) { quickAddField.text = text }
  }

  Item {
    width: parent.width
    height: Math.max(quickAddField.implicitHeight, refreshButton.implicitHeight)

    TextField {
      id: quickAddField
      anchors.left: parent.left
      anchors.right: refreshButton.left
      anchors.rightMargin: Style.space(4)
      anchors.verticalCenter: parent.verticalCenter
      placeholderText: "Add a task… e.g. call the bank @admin +errands due:friday !1"
      foreground: root.foreground
      font.family: root.fontFamily
      onAccepted: root.submitQuickAdd()
      Keys.onEscapePressed: quickAddField.focus = false
    }

    // Manual refresh: also re-discovers task lists on the server, so a list created elsewhere
    // shows up now rather than after the server's one-hour list cache expires.
    PanelActionButton {
      id: refreshButton
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      iconText: "󰑐"
      tooltipText: "Refresh tasks and lists"
      foreground: Qt.darker(root.foreground, 1.5)
      hoverColor: Color.accent
      fontFamily: root.fontFamily
      onClicked: if (root.tasksData) root.tasksData.refresh(true, true)
    }
  }

  // ---- filters --------------------------------------------------------------------------

  Column {
    width: parent.width
    spacing: Style.space(6)

    ButtonGroup {
      options: [
        { value: "open", label: "Open" },
        { value: "done", label: "Completed" },
        { value: "all", label: "All" }
      ]
      value: root.filterStatus
      focusable: false
      background: "transparent"
      foreground: root.foreground
      accent: Color.accent
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      onChanged: function(v) { root.filterStatus = v }
    }

    Flow {
      visible: root.multipleLists
      width: parent.width
      spacing: Style.space(4)

      Repeater {
        model: root.listOptions

        Button {
          required property var modelData

          text: modelData.name + " (" + modelData.count + ")"
          bordered: true
          selected: root.activeListIds.indexOf(modelData.id) !== -1
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.bodySmall
          onClicked: root.toggleList(modelData.id)
        }
      }
    }

    Flow {
      width: parent.width
      spacing: Style.space(4)

      Repeater {
        model: root.bucketOptions

        Button {
          required property var modelData

          text: modelData.label
          bordered: true
          selected: root.filterBuckets.indexOf(modelData.value) !== -1
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.bodySmall
          onClicked: root.toggleBucket(modelData.value)
        }
      }
    }

    Flow {
      visible: root.categoryOptions.length > 0
      width: parent.width
      spacing: Style.space(4)

      Repeater {
        model: root.categoryOptions

        Button {
          required property var modelData

          text: modelData.name + " (" + modelData.count + ")"
          bordered: true
          selected: root.filterCategories.indexOf(modelData.name) !== -1
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.bodySmall
          onClicked: root.toggleCategory(modelData.name)
        }
      }
    }
  }

  // ---- list -----------------------------------------------------------------------------

  Column {
    width: parent.width
    spacing: Style.space(2)

    Repeater {
      model: root.sorted

      TaskRow {
        required property var modelData

        width: parent.width
        tasksData: root.tasksData
        task: modelData
        listLabel: root.multipleLists && modelData && typeof modelData.listName === "string" ? modelData.listName : ""
        nowMs: clock.date.getTime()
        foreground: root.foreground
        fontFamily: root.fontFamily
      }
    }
  }

  Text {
    textFormat: Text.PlainText
    visible: root.sorted.length === 0
    leftPadding: Style.space(8)
    // Two distinct messages: nothing loaded at all, versus filters narrowing a non-empty list to
    // nothing -- the fix for one ("add a task") is not the fix for the other ("clear a filter").
    text: root.allTasks.length === 0
      ? (root.tasksData && root.tasksData.loading ? "Loading…" : "No tasks")
      : "No tasks match these filters"
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Text {
    textFormat: Text.PlainText
    visible: text !== ""
    width: parent.width
    horizontalAlignment: Text.AlignHCenter
    // Wraps rather than truncating at one line: a refused quick-add names the lists it could
    // have meant, and that list is the useful part.
    wrapMode: Text.Wrap
    maximumLineCount: 3
    elide: Text.ElideRight
    text: root.tasksData ? root.tasksData.statusText : ""
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
