import QtQuick
import qs.Commons
import qs.Ui
import "TaskModel.js" as TaskModel
import "TasksDataModel.js" as TasksDataModel

// One row in the Tasks tab list: a checkbox, the title, the task's list (only when more than one
// list is loaded), a due-date label, and category chips.
// Mirrors EventRow.qml's row conventions (anchored header, PanelActionButton for the toggle,
// PlainText everywhere) -- no expand-on-click here, tasks have nothing further to reveal.
Item {
  id: root

  property var tasksData: null
  property var task: null
  // Set by TasksTab only when several lists are loaded; "" hides it.
  property string listLabel: ""
  property double nowMs: 0
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  readonly property color dimForeground: Qt.darker(foreground, 1.5)
  readonly property bool completed: !!(task && (task.completed === true || task.status === "COMPLETED"))
  readonly property string bucket: task ? TaskModel.dueBucket(task, root.nowMs) : "none"
  readonly property bool overdue: root.bucket === "overdue"
  readonly property string title: root._collapsedWhitespace(task ? task.title : "")
  readonly property var categories: task && Array.isArray(task.categories) ? task.categories : []
  readonly property string dueLabel: root._dueLabel()

  function _collapsedWhitespace(value) {
    return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim()
  }

  function _dueLabel() {
    if (!root.task || !root.task.due) return ""
    var date = TaskModel.parseTaskDueDate(root.task.due)
    return date ? Qt.formatDate(date, "d MMM") : ""
  }

  implicitHeight: header.height + (root.categories.length > 0 ? chips.implicitHeight + Style.space(4) : 0)
  height: implicitHeight

  Item {
    id: header
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    height: Math.max(checkButton.implicitHeight, titleText.implicitHeight, dueText.implicitHeight, listText.implicitHeight) + Style.space(2)

    PanelActionButton {
      id: checkButton
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      iconText: root.completed ? "󰄲" : "󰄱"
      tooltipText: root.completed ? "Mark not done" : "Mark done"
      foreground: root.completed ? Color.accent : root.dimForeground
      hoverColor: Color.accent
      fontFamily: root.fontFamily
      // An optimistic placeholder has no server id yet, so it cannot be toggled.
      enabled: !!root.task && !TasksDataModel.isOptimisticId(root.task.id)
      onClicked: if (root.tasksData && root.task) root.tasksData.toggleComplete(root.task.id)
    }

    Text {
      id: dueText
      textFormat: Text.PlainText
      visible: root.dueLabel !== ""
      width: visible ? implicitWidth : 0
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: root.dueLabel
      color: root.overdue && !root.completed ? Color.urgent : root.dimForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    // Secondary text, capped at a quarter of the row so a long list name elides before the title does.
    Text {
      id: listText
      textFormat: Text.PlainText
      visible: root.listLabel !== ""
      width: visible ? Math.min(implicitWidth, header.width / 4) : 0
      anchors.right: dueText.visible ? dueText.left : parent.right
      anchors.rightMargin: dueText.visible ? Style.space(8) : 0
      anchors.verticalCenter: parent.verticalCenter
      text: root.listLabel
      color: root.dimForeground
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }

    Text {
      id: titleText
      textFormat: Text.PlainText
      anchors.left: checkButton.right
      anchors.leftMargin: Style.space(8)
      anchors.right: listText.visible ? listText.left : (dueText.visible ? dueText.left : parent.right)
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: root.title
      color: root.completed ? root.dimForeground : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.strikeout: root.completed
      elide: Text.ElideRight
    }
  }

  Flow {
    id: chips
    visible: root.categories.length > 0
    anchors.left: parent.left
    anchors.leftMargin: checkButton.width + Style.space(8)
    anchors.right: parent.right
    anchors.top: header.bottom
    spacing: Style.space(4)

    Repeater {
      model: root.categories

      Rectangle {
        id: chip
        required property var modelData

        width: chipLabel.implicitWidth + Style.space(12)
        height: chipLabel.implicitHeight + Style.space(4)
        radius: Style.cornerRadius
        color: Style.normalFillFor(root.foreground, Color.accent)

        Text {
          id: chipLabel
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: chip.modelData
          color: root.dimForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
