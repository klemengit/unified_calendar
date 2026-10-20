import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui

Column {
  id: root

  property var calendarData: null
  property bool expanded: false
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family
  property string expandedKey: ""

  signal toggleRequested()

  readonly property var upcoming: upcomingFor(calendarData ? calendarData.revision : 0, calendarData ? calendarData.clock.date : null)
  readonly property int total: upcoming && upcoming.total > 0 ? upcoming.total : 0
  readonly property var items: upcoming && Array.isArray(upcoming.items) ? upcoming.items : []

  // revision and the minute tick are passed only so the binding re-evaluates when events change or an item ends
  function upcomingFor(revision, minuteTick) {
    return calendarData ? calendarData.upcoming() : null
  }

  visible: total > 0
  spacing: Style.space(2)
  onExpandedChanged: if (!expanded) expandedKey = ""

  Item {
    width: parent.width
    height: summary.implicitHeight + Style.space(8)

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: summaryMouse.containsMouse ? Style.hoverFillFor(root.foreground, Commons.Color.accent) : "transparent"
    }

    Text {
      id: summary
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: "󰓎 " + root.total + " upcoming"
      color: summaryMouse.containsMouse
        ? Style.hoverStateColor(root.foreground, Commons.Color.accent)
        : Qt.darker(root.foreground, 1.5)
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      textFormat: Text.PlainText
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: root.expanded ? "󰅃" : "󰅀"
      color: summary.color
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    MouseArea {
      id: summaryMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.toggleRequested()
    }

    PanelToolTip {
      visible: summaryMouse.containsMouse
      text: root.expanded ? "Hide upcoming important events (U)" : "Show upcoming important events (U)"
      fontFamily: root.fontFamily
    }
  }

  Repeater {
    model: root.expanded ? root.items : []

    EventRow {
      id: row
      required property var modelData

      width: root.width
      calendarData: root.calendarData
      ev: modelData
      showDate: true
      expanded: root.expandedKey !== "" && root.expandedKey === row.eventKey
      foreground: root.foreground
      fontFamily: root.fontFamily
      onToggleRequested: root.expandedKey = row.expanded ? "" : row.eventKey
    }
  }

  Text {
    textFormat: Text.PlainText
    visible: root.expanded && root.total > root.items.length
    leftPadding: Style.space(8)
    text: "+" + (root.total - root.items.length) + " more"
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
