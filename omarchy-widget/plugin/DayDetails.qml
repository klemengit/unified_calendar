import QtQuick
import qs.Commons
import qs.Commons as Commons
import "CalendarModel.js" as CalendarModel

Column {
  id: root

  property var calendarData: null
  property string dayKey: ""
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family
  property string expandedKey: ""

  readonly property var labelLocale: Qt.locale("en_US")
  readonly property var date: CalendarModel.parseEventDate(dayKey)
  readonly property var events: eventsFor(dayKey, calendarData ? calendarData.revision : 0)
  readonly property bool loading: !!(calendarData && calendarData.loading) && events.length === 0

  // revision is passed only so the binding re-evaluates when events change
  function eventsFor(key, revision) {
    if (!calendarData || key === "") return []
    var list = calendarData.eventsForDay(key)
    return Array.isArray(list) ? list : []
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
}
