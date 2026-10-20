import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "CalendarModel.js" as CalendarModel
import "DataModel.js" as DataModel

Item {
  id: root

  property var calendarData: null
  property var ev: null
  property string dayKey: ""
  property bool showDate: false
  property bool expanded: false
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family

  signal toggleRequested()

  readonly property var labelLocale: Qt.locale("en_US")
  readonly property color dimForeground: Qt.darker(foreground, 1.5)
  readonly property string eventKey: ev ? String(ev.id) + "|" + String(ev.start) : ""
  readonly property bool important: !!(ev && ev.important)
  readonly property var startDate: ev ? CalendarModel.parseEventDate(ev.start) : null
  readonly property string timeLabel: ev
    ? CalendarModel.formatTimeRange(ev, dayKey !== "" ? dayKey : (startDate ? CalendarModel.dayKey(startDate) : ""))
    : ""
  readonly property string dateLabel: startDate
    ? labelLocale.dayName(startDate.getDay(), Locale.ShortFormat) + " " + startDate.getDate()
      + " " + labelLocale.monthName(startDate.getMonth(), Locale.ShortFormat)
    : ""
  readonly property string title: textField("title").replace(/\s+/g, " ")
  readonly property string calendarName: textField("calendar")
  readonly property string location: textField("location")
  readonly property string notes: textField("notes")
  readonly property var actions: {
    var list = []
    var meeting = textField("meetingUrl")
    var original = textField("url")
    if (DataModel.isSafeHttpsUrl(meeting)) list.push({ icon: "󰕧", label: "Join meeting", url: meeting })
    if (original !== meeting && DataModel.isSafeHttpsUrl(original)) list.push({ icon: "󰏌", label: "Open original", url: original })
    return list
  }

  function textField(name) {
    var value = ev ? ev[name] : ""
    return value === undefined || value === null ? "" : String(value).replace(/^\s+|\s+$/g, "")
  }

  implicitHeight: header.height + (expanded ? details.implicitHeight + Style.space(8) : 0)
  height: implicitHeight

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: rowMouse.containsMouse
      ? Style.hoverFillFor(root.foreground, Commons.Color.accent)
      : (root.expanded ? Style.normalFillFor(root.foreground, Commons.Color.accent) : "transparent")
  }

  MouseArea {
    id: rowMouse
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    height: header.height
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.toggleRequested()
  }

  Item {
    id: header
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.leftMargin: Style.space(8)
    height: Math.max(titleLabel.implicitHeight, star.implicitHeight) + Style.space(2)

    TextMetrics {
      id: dateMetrics
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      text: "Wed 30 Sep"
    }

    TextMetrics {
      id: timeMetrics
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      text: "00:00–00:00"
    }

    Text {
      id: dateText
      textFormat: Text.PlainText
      visible: root.showDate
      width: visible ? Math.ceil(dateMetrics.advanceWidth) + Style.space(8) : 0
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      text: root.dateLabel
      color: root.dimForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    Text {
      id: timeText
      textFormat: Text.PlainText
      width: Math.ceil(timeMetrics.advanceWidth) + Style.space(10)
      anchors.left: dateText.right
      anchors.verticalCenter: parent.verticalCenter
      text: root.timeLabel
      color: root.dimForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    PanelActionButton {
      id: star
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      iconText: root.important ? "󰓎" : "󰓒"
      tooltipText: root.important ? "Unmark important" : "Mark important"
      foreground: root.important ? Commons.Color.bar.active : root.dimForeground
      hoverColor: root.important ? Commons.Color.bar.active : root.foreground
      fontFamily: root.fontFamily
      onClicked: if (root.calendarData && root.ev) root.calendarData.toggleImportant(root.ev.id)
    }

    Text {
      id: titleLabel
      textFormat: Text.PlainText
      anchors.left: timeText.right
      anchors.right: star.left
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      text: root.title
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }
  }

  Column {
    id: details
    visible: root.expanded
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: header.bottom
    anchors.leftMargin: header.anchors.leftMargin + titleLabel.x
    anchors.rightMargin: Style.space(10)
    spacing: Style.space(4)

    Text {
      textFormat: Text.PlainText
      visible: text !== ""
      width: parent.width
      text: root.calendarName
      color: root.dimForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }

    Text {
      textFormat: Text.PlainText
      visible: root.location !== ""
      width: parent.width
      text: "󰍎  " + root.location
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.Wrap
      maximumLineCount: 3
      elide: Text.ElideRight
    }

    Text {
      textFormat: Text.PlainText
      visible: root.notes !== ""
      width: parent.width
      text: root.notes
      color: Qt.darker(root.foreground, 1.2)
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.Wrap
      maximumLineCount: 10
      elide: Text.ElideRight
    }

    Flow {
      visible: root.actions.length > 0
      width: parent.width
      spacing: Style.space(6)

      Repeater {
        model: root.actions

        Rectangle {
          id: action
          required property var modelData

          width: actionLabel.implicitWidth + Style.space(16)
          height: actionLabel.implicitHeight + Style.space(6)
          radius: Style.cornerRadius
          color: actionMouse.containsMouse
            ? Style.hoverFillFor(root.foreground, Commons.Color.accent)
            : Style.normalFillFor(root.foreground, Commons.Color.accent)

          Text {
            id: actionLabel
            textFormat: Text.PlainText
            anchors.centerIn: parent
            text: action.modelData.icon + "  " + action.modelData.label
            color: actionMouse.containsMouse
              ? Style.hoverStateColor(root.foreground, Commons.Color.accent)
              : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          MouseArea {
            id: actionMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: if (root.calendarData) root.calendarData.openUrl(action.modelData.url)
          }
        }
      }
    }
  }
}
