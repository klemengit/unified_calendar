import QtQuick
import qs.Commons
import qs.Commons as Commons
import "CalendarModel.js" as CalendarModel

Item {
  id: root

  property var day: ({})
  property var info: null
  property bool selected: false
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family
  property int cellWidth: Style.space(52)
  property int cellHeight: Style.space(34)

  signal activated(string key)

  readonly property bool important: !!(info && info.important)
  readonly property bool spent: !!(info && info.spent)
  readonly property int dots: info ? Math.max(0, Math.min(3, Number(info.dots) || 0)) : 0
  readonly property real fillOpacity: spent ? 0.45 : 1
  readonly property real fade: spent ? (day.inMonth && !important ? 0.45 : 0.7) : 1
  // A past day's fill is painted faded, so the number's contrast is judged against that blend
  readonly property color shownFill: Qt.rgba(
    Commons.Color.bar.active.r * fillOpacity + Commons.Color.background.r * (1 - fillOpacity),
    Commons.Color.bar.active.g * fillOpacity + Commons.Color.background.g * (1 - fillOpacity),
    Commons.Color.bar.active.b * fillOpacity + Commons.Color.background.b * (1 - fillOpacity),
    1)
  readonly property color onFill: CalendarModel.readableOn(String(shownFill), String(Commons.Color.background), String(foreground)) === "background"
    ? Commons.Color.background
    : foreground
  readonly property color ink: important
    ? onFill
    : (day.inMonth
      ? (day.weekend ? Qt.darker(foreground, 1.45) : foreground)
      : Qt.darker(foreground, 2.2))

  width: cellWidth
  height: cellHeight

  Rectangle {
    anchors.fill: parent
    visible: root.important
    radius: Style.cornerRadius
    color: Commons.Color.bar.active
    opacity: root.fillOpacity
  }

  Rectangle {
    anchors.fill: parent
    visible: root.selected || cellMouse.containsMouse
    radius: Style.cornerRadius
    color: root.selected
      ? Style.selectedFillFor(root.important ? root.onFill : root.foreground, Commons.Color.accent)
      : Style.hoverFillFor(root.important ? root.onFill : root.foreground, Commons.Color.accent)
  }

  Rectangle {
    anchors.fill: parent
    anchors.margins: root.important ? Style.space(2) : 0
    visible: !!root.day.today
    radius: root.important ? Math.max(0, Style.cornerRadius - Style.space(2)) : Style.cornerRadius
    color: "transparent"
    border.width: Style.spacing.hairline
    border.color: root.important ? root.onFill : Style.normalBorderFor(root.foreground, Commons.Color.accent)
  }

  Text {
    textFormat: Text.PlainText
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.verticalCenter: parent.verticalCenter
    anchors.verticalCenterOffset: root.dots > 0 ? -Style.space(3) : 0
    text: root.day.day === undefined ? "" : root.day.day
    color: root.ink
    opacity: root.fade
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: !!root.day.today
  }

  Row {
    visible: root.dots > 0
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: Style.space(5)
    spacing: Style.space(3)
    opacity: root.fade

    Repeater {
      model: root.dots

      Rectangle {
        width: Style.space(4)
        height: width
        radius: width / 2
        color: root.ink
      }
    }
  }

  MouseArea {
    id: cellMouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.activated(String(root.day.key || ""))
  }
}
