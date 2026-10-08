import QtQuick
import qs.Commons
import "CalendarModel.js" as CalendarModel
import "DayTasksModel.js" as DayTasksModel

Column {
  id: root

  property var calendarData: null
  property var tasksData: null
  property string dayKey: ""
  property double nowMs: 0
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family
  property string expandedKey: ""

  readonly property var labelLocale: Qt.locale("en_US")
  readonly property var date: CalendarModel.parseEventDate(dayKey)
  readonly property var events: eventsFor(dayKey, calendarData ? calendarData.revision : 0)
  readonly property bool loading: !!(calendarData && calendarData.loading) && events.length === 0
  // Tasks due this day, any status -- TaskRow ticks a COMPLETED one back to open in place, same
  // as the Tasks tab.
  readonly property var tasksDue: tasksFor(dayKey, tasksData ? tasksData.revision : 0)

  // revision is passed only so the binding re-evaluates when events change
  function eventsFor(key, revision) {
    if (!calendarData || key === "") return []
    var list = calendarData.eventsForDay(key)
    return Array.isArray(list) ? list : []
  }

  // revision is passed only so the binding re-evaluates when tasks change
  function tasksFor(key, revision) {
    if (!tasksData || key === "") return []
    return DayTasksModel.tasksDueOnDay(tasksData.tasks, key)
  }

  spacing: Style.space(2)
  onDayKeyChanged: expandedKey = ""

  Text {
    textFormat: Text.PlainText
    width: parent.width
    leftPadding: Style.space(8)
    topPadding: Style.space(4)
    bottomPadding: Style.space(4)
    text: root.date
      ? (root.labelLocale.dayName(root.date.getDay(), Locale.LongFormat) + " " + root.date.getDate()
        + " " + root.labelLocale.monthName(root.date.getMonth(), Locale.LongFormat)).toUpperCase()
      : ""
    color: Qt.darker(root.foreground, 1.4)
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.letterSpacing: 1
    elide: Text.ElideRight
  }

  Repeater {
    model: root.events

    EventRow {
      id: row
      required property var modelData

      width: root.width
      calendarData: root.calendarData
      ev: modelData
      dayKey: root.dayKey
      expanded: root.expandedKey !== "" && root.expandedKey === row.eventKey
      foreground: root.foreground
      fontFamily: root.fontFamily
      onToggleRequested: root.expandedKey = row.expanded ? "" : row.eventKey
    }
  }

  Text {
    textFormat: Text.PlainText
    visible: root.events.length === 0
    leftPadding: Style.space(8)
    text: root.loading ? "Loading…" : "No events"
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  // ---- tasks due this day --------------------------------------------------------------
  //
  // Entirely absent (no divider, no header, no "no tasks" line) when nothing is due -- a
  // Column excludes a `visible: false` child from its implicit size, the same exclusion
  // Panel.qml's calendarColumn/tasksTab toggle already relies on, so this collapses to zero
  // height rather than leaving a gap.
  Column {
    id: tasksSection
    visible: root.tasksDue.length > 0
    width: parent.width
    spacing: Style.space(2)

    Item {
      width: parent.width
      height: Style.space(6) + Style.spacing.hairline

      Rectangle {
        anchors.bottom: parent.bottom
        width: parent.width
        height: Style.spacing.hairline
        color: root.foreground
        opacity: 0.1
      }
    }

    Text {
      textFormat: Text.PlainText
      leftPadding: Style.space(8)
      topPadding: Style.space(4)
      text: "TASKS DUE"
      color: Qt.darker(root.foreground, 1.5)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.letterSpacing: 1
    }

    Repeater {
      model: root.tasksDue

      TaskRow {
        required property var modelData

        width: tasksSection.width
        tasksData: root.tasksData
        task: modelData
        nowMs: root.nowMs
        foreground: root.foreground
        fontFamily: root.fontFamily
      }
    }
  }
}
