import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "CalendarModel.js" as CalendarModel
import "DataModel.js" as DataModel
import "TaskModel.js" as TaskModel

// Date/time label for the bar, and the host for the calendar popup.
//
// Left click reveals the calendar — asking "what is the date?" is what a
// click on a clock means — right click walks the common label formats, and
// middle click opens the timezone picker.
BarWidget {
  id: root
  moduleName: "omarchy.clock"

  property date displayDate: clock.date

  readonly property string configuredFormat: vertical
    ? setting("verticalFormat", "HH\n—\nmm")
    : setting("format", "dddd HH:mm")
  readonly property string configuredAltFormat: vertical
    ? setting("verticalFormatAlt", "dd\nMMM\n'W'ww\n''yy")
    : setting("formatAlt", "d MMMM 'W'ww yyyy")

  readonly property var formatRing: Model.clockFormatRing(configuredFormat, configuredAltFormat, Model.clockFormats(vertical))

  // What the bar shows is what shell.json stores, so a cycled format is the
  // format from then on rather than something that reverts on restart.
  readonly property string activeFormat: configuredFormat
  readonly property string displayText: formatted(displayDate)
  readonly property var verticalLines: displayText.split("\n")

  function refresh() {
    displayDate = new Date()
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function cycleFormat() {
    var current = String(configuredFormat)
    var next = Model.nextClockFormat(formatRing, current)
    if (next === "" || next === current) return

    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry[vertical ? "verticalFormat" : "format"] = next

    // Applied locally first so the label changes on the click itself; the
    // shell.json write comes back through the bar as the same value.
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function formatted(date) {
    return Qt.formatDateTime(date, activeFormat.replace(/ww/g, Model.isoWeekLiteral(date.getFullYear(), date.getMonth(), date.getDate())))
  }

  // ---- Calendar popup. Shape contract for shell.summon/hide/toggle
  //      routing: Bar.findPanelWidget requires open/close/opened on the
  //      bar-widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function toggleWeekStart() {
    if (panelLoader.item) panelLoader.item.toggleWeekStart()
  }

  function selectDay(key) {
    if (panelLoader.item) panelLoader.item.selectDay(key)
  }

  function toggleUpcoming() {
    if (panelLoader.item) panelLoader.item.toggleUpcoming()
  }

  // The clock fills more slot than it paints a mark for, at both
  // orientations: horizontally it is a text label in a padded slot, so the
  // dot takes the label width; vertically it is a stack of icon-sized lines,
  // so the dot takes one line — the same mark every icon widget gets, rather
  // than a rule running the height of the whole stack.
  readonly property real openPanelIndicatorWidth: button.labelWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  // Forwarded so this widget can stand in for the panel as the bar's popout
  // identity: Bar.requestPopout prefers closeForPopoutSwitch over close, and
  // KeyboardPanel reads popoutSwitchClosing back off its owner.
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("calendarData" in target) target.calendarData = calendarData
    if ("tasksData" in target) target.tasksData = tasksData
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: root.displayDate = date
  }

  CalendarData {
    id: calendarData
    settings: root.settings
    weekStart: Model.normalizedWeekStart(root.setting("weekStartDay", null), Qt.locale().firstDayOfWeek)
    onToggleSucceeded: root.broadcast("refreshCalendar")
  }

  // Mirrors calendarData above: same Process+curl fetch / FileView cache / primary-election
  // shape (see TasksData.qml's own header comment), just for the Tasks tab's data instead.
  TasksData {
    id: tasksData
    settings: root.settings
  }

  readonly property int overdueTaskCount: TaskModel.overdueCount(tasksData.tasks, displayDate.getTime())

  function refreshCalendar() {
    calendarData.refresh(true)
  }

  // Separate from refreshCalendar, which also runs after every star toggle: re-discovering task
  // lists there would cost a PROPFIND per click for nothing.
  function refreshTasks() {
    tasksData.refresh(true, true)
  }

  function electPrimary() {
    var peers = root.bar && typeof root.bar.moduleWidgets === "function" ? root.bar.moduleWidgets(root.moduleName) : []
    calendarData.instances = peers.length
    calendarData.primary = DataModel.isPrimaryInstance(peers, root)
    tasksData.instances = peers.length
    tasksData.primary = DataModel.isPrimaryInstance(peers, root)
  }

  function electPrimaryEverywhere() {
    root.electPrimary()
    root.broadcast("electPrimary")
  }

  Connections {
    target: root
    function onBarChanged() { Qt.callLater(root.electPrimaryEverywhere) }
    function onModuleNameChanged() { Qt.callLater(root.electPrimaryEverywhere) }
  }

  // Catches a peer that went away with its monitor
  Timer {
    interval: 60000
    running: true
    repeat: true
    onTriggered: root.electPrimary()
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  function sendTestReminder() {
    var upcoming = calendarData.upcoming()
    var ev = upcoming && upcoming.items && upcoming.items.length > 0 ? upcoming.items[0] : null
    var start = ev ? CalendarModel.parseEventDate(ev.start) : null
    if (!start) return "no upcoming important event"

    var offsets = CalendarModel.parseOffsets(DataModel.parseSettings(root.settings).reminders)
    var sent = calendarData.sendReminder(ev, offsets[offsets.length - 1], "Test: ")
    if (!sent) return "no reminder text for the next important event"

    var startKey = CalendarModel.dayKey(start)
    return "sent: " + sent.label + " · " + CalendarModel.formatTimeRange(ev, startKey) + " · " + startKey
      + (sent.hasMeeting ? " · click opens meeting link" : "")
  }

  IpcHandler {
    target: "omarchy.clock"

    function refresh(): void { root.broadcast("refresh") }
    function cycleFormat(): void { root.cycleFormat() }
    function toggleWeekStart(): void { root.toggleWeekStart() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function calendarHealth(): string { return calendarData.health() }
    function calendarRefresh(): void {
      root.broadcast("refreshCalendar")
      root.broadcast("refreshTasks")
    }
    function selectDay(key: string): void { root.selectDay(key) }
    function toggleUpcoming(): void { root.toggleUpcoming() }
    function calendarTestReminder(): string { return root.sendTestReminder() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : root.displayText
    labelVisible: !root.vertical
    hasVisualContent: root.vertical ? root.verticalLines.length > 0 : text !== ""
    fixedHeight: root.vertical ? root.verticalLines.length * Style.bar.iconSlot : -1
    horizontalMargin: 8.75
    verticalPadding: 8.75

    onPressed: function(b) {
      if (b === Qt.RightButton) root.cycleFormat()
      else if (b === Qt.MiddleButton) { if (root.bar) root.bar.run("omarchy-menu-timezone") }
      else root.togglePanel()
    }

    Column {
      visible: root.vertical
      anchors.fill: parent

      Repeater {
        model: root.verticalLines

        OpticalGlyph {
          required property string modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData
          fontFamily: button.fontFamily
          fontSize: modelData.length > 3
            ? button.fontSize * 0.9
            : button.fontSize
          color: button.foreground
        }
      }
    }

    FontMetrics {
      id: markMetrics
      font.family: button.fontFamily
      font.pixelSize: button.fontSize
    }

    // Sits in the label's side margin (or above the first line) so the text never shifts
    Rectangle {
      readonly property int size: Style.space(5)

      visible: calendarData.clockMark
      width: size
      height: size
      radius: size / 2
      color: Color.bar.active
      x: root.vertical
        ? Math.round((button.width - size) / 2)
        : Math.round((button.width + button.labelWidth) / 2) + Style.space(2)
      y: root.vertical
        ? Math.max(0, Math.round((Style.bar.iconSlot - markMetrics.height) / 4 - size / 2))
        : Math.round((button.height - size) / 2)
    }

    // Overdue-task marker. Same treatment as the clock's own event mark above (small dot sized
    // off Style.space, same FontMetrics-based math) but mirrored to the opposite side/row so the
    // two can never sit on top of each other -- position, not just colour, tells them apart.
    // Invisible whenever nothing is overdue (root.overdueTaskCount === 0).
    Rectangle {
      readonly property int size: Style.space(5)

      visible: root.overdueTaskCount > 0
      width: size
      height: size
      radius: size / 2
      color: Color.urgent
      x: root.vertical
        ? Math.round((button.width - size) / 2)
        : Math.round((button.width - button.labelWidth) / 2) - Style.space(2) - size
      y: root.vertical
        ? button.height - Math.max(0, Math.round((Style.bar.iconSlot - markMetrics.height) / 4 - size / 2)) - size
        : Math.round((button.height - size) / 2)
    }
  }
}
