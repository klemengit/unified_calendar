import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "CalendarModel.js" as CalendarModel
import "DayTasksModel.js" as DayTasksModel

// The clock's calendar popup: a month grid with ISO week numbers, built to
// sit beside the weather panel — same hero-over-detail composition, same
// spacing scale, same small-caps labels.
//
// The grid is a picker as well as a read-out: chevrons, the scroll wheel
// and the arrow keys step the month on screen, while hjkl walk a day cursor
// across the grid and open each day's events under it. Which unit each key
// family moves by is configurable — see `navKeys` in the widget's settings.
//
// BarWidget.qml owns the bar label and hands this panel the button to
// anchor against.
Panel {
  id: root
  moduleName: "omarchy.clock"
  ipcTarget: "omarchy.clock"
  manageIpc: false

  property var anchorItem: null
  property var calendarData: null
  property var tasksData: null
  property string selectedDayKey: ""
  property bool upcomingExpanded: false

  // Calendar | Tasks tab bar. Calendar is the default so a fresh panel looks exactly like it
  // did before Tasks existed. "s" switches between the two -- every other free-standing letter
  // key here is already spoken for by the calendar ([ ] { } t w u) or by the day cursor (hjkl).
  property string activeTab: "calendar"

  readonly property bool calendarTabActive: root.activeTab === "calendar"

  function switchActiveTab() {
    root.activeTab = root.activeTab === "calendar" ? "tasks" : "calendar"
  }

  // Which calendar unit each arrow/hjkl axis moves by. Read from the widget's
  // shell.json entry so it can be changed without touching the plugin.
  readonly property var navKeys: CalendarModel.parseNavKeys(setting("navKeys", null))

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel. Everything the bar identifies a panel by has to be that
  // widget: the popout coordinator (and with it the open-panel dot under the
  // pill) compares against `slot.activeItem`, and switchPanelFrom looks the
  // slot up the same way.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // ---- Today. SystemClock keeps this honest across midnight so the
  //      highlight rolls over without the panel being reopened.
  property date today: new Date()
  readonly property string todayKey: Model.keyForDate(today)

  // The month on screen. Stepping the month moves this and nothing else;
  // moving the day cursor past a month edge drags it along, so the selected
  // day is always on the visible grid.
  property int viewYear: today.getFullYear()
  property int viewMonth: today.getMonth()

  readonly property date viewDate: new Date(viewYear, viewMonth, 1)
  readonly property bool viewingCurrentMonth: viewYear === today.getFullYear() && viewMonth === today.getMonth()

  // Pinned to today, not to the month being browsed — stepping through the
  // calendar does not change how much of the year is gone.
  readonly property real yearDone: Model.yearProgress(today.getFullYear(), today.getMonth(), today.getDate())
  readonly property int yearDonePercent: Model.yearProgressPercent(today.getFullYear(), today.getMonth(), today.getDate())

  // Memento mori, for anyone who goes looking: double-tapping the year bar
  // asks for a birth year and a life expectancy, and a second bar tracks one
  // against the other. A birth year rather than an age, so it keeps counting
  // on its own. Without one the bar stays hidden.
  readonly property int birthYear: Model.parseBirthYear(setting("birthYear", 0), today.getFullYear())
  readonly property int age: Model.ageFromBirthYear(birthYear, today.getFullYear())
  readonly property int lifeExpectancy: Model.parseLifeExpectancy(setting("lifeExpectancy", 0))
  readonly property real lifeDone: Model.lifeProgress(age, lifeExpectancy)
  readonly property int lifeDonePercent: Model.lifeProgressPercent(age, lifeExpectancy)
  property bool editingLife: false

  // Unset falls through to the locale's own first day, so a fresh install
  // starts out matching the rest of the desktop rather than a hardcoded
  // convention. Clicking the grid's "W" heading writes the choice back to
  // shell.json.
  readonly property int weekStart: Model.normalizedWeekStart(setting("weekStartDay", null), Qt.locale().firstDayOfWeek)
  // The interface is English throughout, so day names are not taken from the
  // system locale. Where the week starts still is: that is a regional
  // convention rather than a translation, and it stays overridable above.
  readonly property var labelLocale: Qt.locale("en_US")
  readonly property string nextWeekStartLabel: labelLocale.dayName(Model.toggledWeekStart(weekStart), Locale.LongFormat)
  readonly property var weekdays: Model.weekdayOrder(weekStart)
  readonly property var weeks: Model.monthGrid(viewYear, viewMonth, weekStart, todayKey)


  // Guarded so the widget renders before the bar is injected (the bar-widget
  // contract instantiates it bare).
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property int cellWidth: Style.space(52)
  readonly property int cellHeight: Style.space(34)
  readonly property int cellSpacing: Style.space(2)
  readonly property int weekColumnWidth: Style.space(32)
  readonly property int gutterWidth: Style.space(14)

  function open() {
    refresh()
    root.controller.show()
    // Set after showing, not before: showing hands the popout coordinator
    // over, which closes whichever panel was open, and that close clears the
    // shared flag. Deferring means the panel taking over always wins, while
    // a handoff to a panel that does not manage the flag still leaves it
    // cleared rather than stuck on.
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
    root.selectedDayKey = ""
    root.upcomingExpanded = false
    if (root.calendarData) root.calendarData.refresh(false)
    Qt.callLater(root.ensureVisibleRange)
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    // Dismissing the panel mid-edit would otherwise leave the inputs up,
    // waiting behind a closed popup for the next time it opens.
    if (root.editingLife) root.cancelEditingLife()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Summoning by hotkey moves no pointer, so a hover the bar was still
  // holding must not keep the center indicators revealed behind the panel.
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function refresh() {
    root.today = new Date()
    root.goToToday()
  }

  // Takes the day cursor with it when there is one: going home and leaving
  // the selection behind on a month that is no longer on screen would strand
  // the details panel under a grid that does not contain its day.
  function goToToday() {
    root.viewYear = today.getFullYear()
    root.viewMonth = today.getMonth()
    if (root.selectedDayKey !== "") root.selectedDayKey = root.todayKey
    Qt.callLater(root.ensureVisibleRange)
  }

  function moveMonth(delta) {
    var next = Model.stepMonth(viewYear, viewMonth, delta)
    root.viewYear = next.year
    root.viewMonth = next.month
    Qt.callLater(root.ensureVisibleRange)
  }

  function ensureVisibleRange() {
    if (!root.calendarData) return
    var range = CalendarModel.gridRange(root.viewYear, root.viewMonth, root.weekStart)
    root.calendarData.ensureRange(range.start, range.end)
  }

  // revision is passed only so the cell bindings re-evaluate when events change
  function dayInfo(key, revision) {
    return root.calendarData ? root.calendarData.dayInfo(key, root.todayKey) : null
  }

  // Built once per tasks change rather than once per day cell.
  readonly property var openDueIndex: root.tasksData ? DayTasksModel.openDueDayIndex(root.tasksData.tasks) : ({})

  // revision is passed only so the cell bindings re-evaluate when tasks change
  function dayHasOpenTask(key, revision) {
    return !!root.openDueIndex[key]
  }

  function selectDay(key) {
    var text = String(key || "")
    var date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? CalendarModel.parseEventDate(text) : null
    if (!date) return
    root.open()
    root.viewYear = date.getFullYear()
    root.viewMonth = date.getMonth()
    root.selectedDayKey = text
  }

  function toggleUpcoming() {
    if (root.opened) {
      root.upcomingExpanded = !root.upcomingExpanded
      return
    }
    root.open()
    root.upcomingExpanded = true
  }

  function moveYear(delta) {
    moveMonth(delta * 12)
  }

  // Moves the day cursor and pulls the view along with it, so stepping off
  // the end of a month scrolls the grid rather than losing the selection.
  function setCursor(key) {
    var date = CalendarModel.parseEventDate(key)
    if (!date) return
    root.selectedDayKey = key
    root.viewYear = date.getFullYear()
    root.viewMonth = date.getMonth()
    Qt.callLater(root.ensureVisibleRange)
  }

  // One arrow or hjkl press, resolved against what the key family is
  // configured to move by and whether a day is currently selected.
  function navigate(unit, delta) {
    var action = CalendarModel.navAction(unit, delta, root.selectedDayKey !== "")
    if (action.kind === "none") return
    if (action.kind === "view") {
      root.moveMonth(action.months)
      return
    }
    if (action.kind === "seed") {
      // The first fine-grained press summons the cursor rather than moving
      // it: landing on today (or on the browsed month) beats landing one day
      // off it with nothing to have aimed from.
      root.setCursor(CalendarModel.cursorSeed(root.todayKey, root.viewYear, root.viewMonth))
      return
    }
    var next = CalendarModel.stepDayKey(root.selectedDayKey, unit, delta)
    if (next !== "") root.setCursor(next)
  }

  // Applied locally first so the panel redraws on the click itself; the
  // shell.json write comes back through the bar as the same value. With no
  // writable entry (the widget is not in the layout) it stays a session-only
  // preference rather than doing nothing. The host widget builds its own
  // entry when the label format is cycled, so it has to be kept in step or
  // it would write this key straight back out from a stale copy.
  function persistSettings(values) {
    var entry = { id: root.moduleName }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    for (var key in values) entry[key] = values[key]

    root.settings = entry
    if (root.hostWidget && "settings" in root.hostWidget) root.hostWidget.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function setWeekStart(day) {
    var next = Model.normalizedWeekStart(day, root.weekStart)
    if (next === root.weekStart) return
    persistSettings({ weekStartDay: Model.weekStartSettingName(next) })
    Qt.callLater(root.ensureVisibleRange)
  }

  function startEditingLife() {
    root.editingLife = true
    Qt.callLater(function() {
      bornField.text = root.birthYear > 0 ? String(root.birthYear) : ""
      expectancyField.text = String(root.lifeExpectancy)
      bornField.selectAll()
      bornField.forceActiveFocus()
    })
  }

  function cancelEditingLife() {
    root.editingLife = false
    Qt.callLater(function() { if (navCatcher) navCatcher.forceActiveFocus() })
  }

  // Shared by both fields: Tab hops to the other one, Enter commits the pair,
  // Escape drops the lot.
  function handleLifeKey(event, other) {
    if (event.key === Qt.Key_Escape) {
      root.cancelEditingLife()
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      root.commitLife()
      event.accepted = true
    } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
      other.selectAll()
      other.forceActiveFocus()
      event.accepted = true
    }
  }

  // Double-tapping the life bar puts it away again. The expectancy stays in
  // the config so setting a birth year again brings your own number back
  // rather than the default.
  function clearLife() {
    if (root.birthYear <= 0) return
    persistSettings({ birthYear: 0 })
  }

  function commitLife() {
    var born = Model.parseBirthYear(bornField.text, today.getFullYear())
    var span = Model.parseLifeExpectancy(expectancyField.text)
    if (born !== root.birthYear || span !== root.lifeExpectancy)
      persistSettings({ birthYear: born, lifeExpectancy: span })
    cancelEditingLife()
  }

  function toggleWeekStart() {
    setWeekStart(Model.toggledWeekStart(root.weekStart))
  }

  // English short day names, matching the rest of the interface.
  function weekdayLabel(weekday) {
    return String(labelLocale.dayName(weekday, Locale.ShortFormat)).toUpperCase()
  }

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: {
      if (Model.keyForDate(clock.date) === String(root.todayKey)) return
      var followToday = root.viewingCurrentMonth
      root.today = clock.date
      if (followToday) root.goToToday()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: navCatcher
    contentWidth: panel.fittedContentWidth(Style.space(560))
    // Follows whichever tab is active, not whichever is taller: calendarColumn/tasksTab are
    // both direct children of panelColumn, and Qt Quick's Column positioner excludes a
    // `visible: false` child from its implicit size entirely (DayDetails/UpcomingList below
    // already rely on this same exclusion) -- so panelColumn.implicitHeight is just the tab bar
    // plus whichever one tab is currently visible.
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // tasksTab.editing mirrors editingLife: typing in the quick-add field must not have "t"
      // jump to today or "w" toggle the week start out from under the user.
      blocked: root.editingLife || tasksTab.editing
      // Reached only when focus sits on the catcher itself rather than on
      // navCatcher below. Arrows and hjkl are one signal here, so both take
      // the arrow mapping — a fallback that agrees with the configured keys
      // instead of quietly reverting to the stock month/year stepping.
      onMoveRequested: function(dx, dy) {
        if (!root.calendarTabActive) return
        if (dx !== 0) root.navigate(root.navKeys.arrows.horizontal, dx)
        if (dy !== 0) root.navigate(root.navKeys.arrows.vertical, dy)
      }
      onActivateRequested: { if (root.calendarTabActive) root.goToToday() }
      onCloseRequested: {
        if (root.calendarTabActive && root.selectedDayKey !== "") root.selectedDayKey = ""
        else root.close()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "s" || t === "S") root.switchActiveTab()
        else if (!root.calendarTabActive) return
        else if (t === "[") root.moveMonth(-1)
        else if (t === "]") root.moveMonth(1)
        else if (t === "{") root.moveYear(-1)
        else if (t === "}") root.moveYear(1)
        else if (t === "t" || t === "T") root.goToToday()
        else if (t === "w" || t === "W") root.toggleWeekStart()
        else if (t === "u" || t === "U") root.toggleUpcoming()
      }

      // Holds the focus, so it sees keys before the catcher it sits in and
      // can tell an arrow from its hjkl twin, which PanelKeyCatcher folds into
      // one signal. Anything it does not accept bubbles up to the catcher and
      // is handled there as usual. No geometry: it is a key handler, not a
      // surface, and must not sit over the panel's mouse areas.
      Item {
        id: navCatcher
        width: 0
        height: 0

        Keys.onPressed: function(event) {
          if (root.editingLife || !root.calendarTabActive) return

          var arrows = root.navKeys.arrows
          var letters = root.navKeys.letters
          var unit = ""
          var delta = 0

          if (event.key === Qt.Key_Left) { unit = arrows.horizontal; delta = -1 }
          else if (event.key === Qt.Key_Right) { unit = arrows.horizontal; delta = 1 }
          else if (event.key === Qt.Key_Up) { unit = arrows.vertical; delta = -1 }
          else if (event.key === Qt.Key_Down) { unit = arrows.vertical; delta = 1 }
          else if (event.text === "h") { unit = letters.horizontal; delta = -1 }
          else if (event.text === "l") { unit = letters.horizontal; delta = 1 }
          else if (event.text === "k") { unit = letters.vertical; delta = -1 }
          else if (event.text === "j") { unit = letters.vertical; delta = 1 }
          else return

          // Accepted even when the unit is "none": the key was claimed by the
          // calendar, and letting it fall through would hand h/j/k/l back to
          // the catcher as a month step the user has just turned off.
          root.navigate(unit, delta)
          event.accepted = true
        }
      }

      Flickable {
        id: calendarScroll
        anchors.fill: parent
        contentWidth: panelColumn.width
        contentHeight: panelColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height || contentWidth > width

        Column {
          id: panelColumn
          width: Math.max(calendarScroll.width, calendarColumn.width)
          spacing: Style.space(10)

          Item {
            id: tabBarWrapper
            width: parent.width
            height: tabBar.height

            ButtonGroup {
              id: tabBar
              anchors.horizontalCenter: parent.horizontalCenter
              options: [
                { value: "calendar", label: "Calendar" },
                { value: "tasks", label: "Tasks" }
              ]
              value: root.activeTab
              // The panel's own keyboard cursor (PanelKeyCatcher / "s") drives this, not Tab
              // focus -- same reasoning DayCell/UpcomingList's controls use throughout this file.
              focusable: false
              background: "transparent"
              foreground: root.contentForeground
              accent: Color.accent
              fontFamily: root.contentFontFamily
              fontSize: Style.font.bodySmall
              onChanged: function(v) { root.activeTab = v }
            }
          }

          Column {
            id: calendarColumn
            visible: root.activeTab === "calendar"
            // Never narrower than the grid. The popup width is capped to what
            // the screen allows, and a fixed seven-column grid would otherwise
            // lose its last days off the edge instead of scrolling.
            width: Math.max(calendarScroll.width, gridColumn.width)
            spacing: Style.space(8)

            // ---- Hero: today, centered. Once the view has stepped back
            //      it is also the way home — clicking the date you are
            //      looking for beats hunting for a reset button.
            Item {
              width: parent.width
              height: heroRow.height

              Row {
                id: heroRow
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: Style.space(22)

                Text {
                  // Baseline-aligned, not center-aligned: "July 26" carries a
                  // descender, so centering the two boxes leaves the icon
                  // sitting visibly low against the digits.
                  anchors.baseline: heroDate.baseline
                  text: "󰃭"
                  color: heroMouse.containsMouse
                    ? Style.hoverStateColor(root.contentForeground, Color.accent)
                    : root.contentForeground
                  font.family: root.contentFontFamily
                  // Decorative, and deliberately outside the Style.font.*
                  // scale. Sized so the glyph reads at the cap height of the
                  // date beside it rather than towering over it.
                  font.pixelSize: 48
                }

                Text {
                  id: heroDate
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  text: Qt.formatDate(root.today, "MMMM d")
                  color: heroMouse.containsMouse
                    ? Style.hoverStateColor(root.contentForeground, Color.accent)
                    : root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: 52
                  font.bold: true
                }
              }

              MouseArea {
                id: heroMouse
                x: heroRow.x
                y: heroRow.y
                width: heroRow.width
                height: heroRow.height
                enabled: !root.viewingCurrentMonth
                hoverEnabled: enabled
                cursorShape: Qt.PointingHandCursor
                onClicked: root.goToToday()

                PanelToolTip {
                  visible: heroMouse.containsMouse
                  text: "Back to today"
                  fontFamily: root.contentFontFamily
                }
              }
            }

            // ---- Year progress, doubling as the rule under the hero:
            //      a plain hairline said nothing, and whole days done
            //      over days in the year says the same thing louder.
            Item {
              width: parent.width
              height: yearBlock.y + yearBlock.height

              Item {
                id: yearBlock
                y: Style.space(6)
                anchors.horizontalCenter: parent.horizontalCenter
                width: gridColumn.width
                height: Math.max(yearLabel.implicitHeight, Style.space(10))

                TapHandler {
                  enabled: !root.editingLife
                  onDoubleTapped: root.startEditingLife()
                }

                Row {
                  visible: root.editingLife
                  anchors.horizontalCenter: parent.horizontalCenter
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(10)

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "BORN"
                    color: Qt.darker(root.contentForeground, 1.5)
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.letterSpacing: 1
                  }

                  TextField {
                    id: bornField
                    width: Style.space(70)
                    anchors.verticalCenter: parent.verticalCenter
                    placeholderText: "year"
                    foreground: root.contentForeground
                    font.family: root.contentFontFamily
                    inputMethodHints: Qt.ImhDigitsOnly

                    Keys.onPressed: function(event) { root.handleLifeKey(event, expectancyField) }
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.verticalCenterOffset: 0
                    leftPadding: Style.space(6)
                    text: "LIVE TO"
                    color: Qt.darker(root.contentForeground, 1.5)
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.letterSpacing: 1
                  }

                  TextField {
                    id: expectancyField
                    width: Style.space(60)
                    anchors.verticalCenter: parent.verticalCenter
                    placeholderText: "90"
                    foreground: root.contentForeground
                    font.family: root.contentFontFamily
                    inputMethodHints: Qt.ImhDigitsOnly

                    Keys.onPressed: function(event) { root.handleLifeKey(event, bornField) }
                  }
                }

                Text {
                  id: yearLabel
                  textFormat: Text.PlainText
                  visible: !root.editingLife
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.today.getFullYear()
                  color: Qt.darker(root.contentForeground, 1.5)
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }

                Text {
                  id: yearPercent
                  textFormat: Text.PlainText
                  visible: !root.editingLife
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.yearDonePercent + "%"
                  color: root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Rectangle {
                  id: yearTrack
                  visible: !root.editingLife
                  anchors.left: yearLabel.right
                  anchors.right: yearPercent.left
                  anchors.leftMargin: Style.space(12)
                  anchors.rightMargin: Style.space(12)
                  anchors.verticalCenter: parent.verticalCenter
                  height: Style.space(6)
                  radius: Style.cornerRadius > 0 ? height / 2 : 0
                  color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)

                  Rectangle {
                    width: Math.round(parent.width * root.yearDone)
                    height: parent.height
                    radius: parent.radius
                    color: Style.selectedStateColor(root.contentForeground, Color.accent)

                    Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                  }
                }
              }
            }

            // ---- Memento mori. Only here once someone has gone looking and
            //      given an age; the same rail as the year above it, measured
            //      against a nominal lifetime.
            Item {
              visible: root.birthYear > 0
              width: parent.width
              height: visible ? lifeBlock.height : 0

              Item {
                id: lifeBlock
                anchors.horizontalCenter: parent.horizontalCenter
                width: gridColumn.width
                height: Math.max(lifeLabel.implicitHeight, Style.space(10))

                Text {
                  id: lifeLabel
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  text: "LIFE"
                  color: Qt.darker(root.contentForeground, 1.5)
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }

                Text {
                  id: lifePercent
                  textFormat: Text.PlainText
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.lifeDonePercent + "%"
                  color: root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Rectangle {
                  anchors.left: lifeLabel.right
                  anchors.right: lifePercent.left
                  anchors.leftMargin: Style.space(12)
                  anchors.rightMargin: Style.space(12)
                  anchors.verticalCenter: parent.verticalCenter
                  height: Style.space(6)
                  radius: Style.cornerRadius > 0 ? height / 2 : 0
                  color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)

                  Rectangle {
                    width: Math.round(parent.width * root.lifeDone)
                    height: parent.height
                    radius: parent.radius
                    color: Style.selectedStateColor(root.contentForeground, Color.accent)

                    Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                  }
                }

                TapHandler {
                  onDoubleTapped: root.clearLife()
                }

                MouseArea {
                  id: lifeMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  acceptedButtons: Qt.NoButton

                  PanelToolTip {
                    visible: lifeMouse.containsMouse
                    text: "Memento Mori"
                    fontFamily: root.contentFontFamily
                  }
                }
              }
            }

            // ---- Month grid: week numbers down a gutter on the left, then
            //      the seven day columns. Always six rows, so the popup is
            //      exactly as tall in February as it is in August.
            Item {
              width: parent.width
              height: gridColumn.y + gridColumn.height

              WheelHandler {
                onWheel: function(event) {
                  // Horizontal wheels and touchpad side-scrolls report y === 0;
                  // without this they would every one read as "next month".
                  if (event.angleDelta.y === 0) return
                  root.moveMonth(event.angleDelta.y > 0 ? -1 : 1)
                }
              }

              Column {
                id: gridColumn
                // The meter above is a solid rule; the grid needs room to
                // read as its own block rather than hanging off it.
                y: Style.space(18)
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: Style.space(3)

                Row {
                  id: headerRow
                  spacing: root.cellSpacing

                  // The week-number heading doubles as the week-start toggle.
                  // It is the one control in the panel whose meaning is not
                  // self-evident, so it carries a tooltip naming the day the
                  // click will switch to.
                  Rectangle {
                    width: root.weekColumnWidth
                    height: Style.space(16)
                    radius: Style.cornerRadius
                    color: weekStartMouse.containsMouse
                      ? Style.hoverFillFor(root.contentForeground, Color.accent)
                      : "transparent"

                    Text {
                      anchors.centerIn: parent
                      text: "W"
                      color: weekStartMouse.containsMouse
                        ? Style.hoverStateColor(root.contentForeground, Color.accent)
                        : Qt.darker(root.contentForeground, 1.9)
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      font.letterSpacing: 1
                      font.bold: true
                    }

                    MouseArea {
                      id: weekStartMouse
                      anchors.fill: parent
                      hoverEnabled: true
                      cursorShape: Qt.PointingHandCursor
                      onClicked: root.toggleWeekStart()
                    }

                    PanelToolTip {
                      visible: weekStartMouse.containsMouse
                      text: "Start weeks on " + root.nextWeekStartLabel
                      fontFamily: root.contentFontFamily
                    }
                  }

                  Item {
                    width: root.gutterWidth
                    height: Style.space(16)
                  }

                  Repeater {
                    model: root.weekdays

                    Text {
                      textFormat: Text.PlainText
                      required property var modelData
                      width: root.cellWidth
                      height: Style.space(16)
                      horizontalAlignment: Text.AlignHCenter
                      verticalAlignment: Text.AlignVCenter
                      text: root.weekdayLabel(modelData)
                      color: Qt.darker(root.contentForeground, 1.5)
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      font.letterSpacing: 1
                      font.bold: true
                    }
                  }
                }

                Repeater {
                  model: root.weeks

                  Row {
                    required property var modelData
                    spacing: root.cellSpacing

                    Text {
                      textFormat: Text.PlainText
                      width: root.weekColumnWidth
                      height: root.cellHeight
                      horizontalAlignment: Text.AlignHCenter
                      verticalAlignment: Text.AlignVCenter
                      text: modelData.week
                      color: Qt.darker(root.contentForeground, 1.9)
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                    }

                    Item {
                      width: root.gutterWidth
                      height: root.cellHeight
                    }

                    Repeater {
                      model: modelData.days

                      DayCell {
                        required property var modelData

                        day: modelData
                        info: root.dayInfo(modelData.key, root.calendarData ? root.calendarData.revision : 0)
                        taskDue: root.dayHasOpenTask(modelData.key, root.tasksData ? root.tasksData.revision : 0)
                        selected: root.selectedDayKey === modelData.key
                        foreground: root.contentForeground
                        fontFamily: root.contentFontFamily
                        cellWidth: root.cellWidth
                        cellHeight: root.cellHeight
                        onActivated: function(key) { root.selectedDayKey = root.selectedDayKey === key ? "" : key }
                      }
                    }
                  }
                }
              }

              // Hairline down the week-number gutter, drawn only beside the
              // day rows so it does not cut through the header band.
              Rectangle {
                x: gridColumn.x + root.weekColumnWidth + root.cellSpacing + Math.round((root.gutterWidth - width) / 2)
                y: gridColumn.y + headerRow.height + gridColumn.spacing
                width: Style.spacing.hairline
                height: gridColumn.height - headerRow.height - gridColumn.spacing
                color: root.contentForeground
                opacity: 0.1
              }
            }

            // ---- Month stepping, spanning the grid it drives. The chevrons
            //      sit on the grid's outer bounds, the same edges the year
            //      rail above uses, so the row reads as the panel's other
            //      full-width rail instead of a cluster floating in space.
            //      The label is centered and fixed-width, so it holds still
            //      from "MAY" to "SEPTEMBER".
            Item {
              width: parent.width
              height: monthNav.height

              Item {
                id: monthNav
                anchors.horizontalCenter: parent.horizontalCenter
                width: gridColumn.width
                height: monthLabel.implicitHeight + Style.space(10)

                Text {
                  id: monthLabel
                  textFormat: Text.PlainText
                  anchors.horizontalCenter: parent.horizontalCenter
                  anchors.verticalCenter: parent.verticalCenter
                  // Fixed width so the chevrons hold still between a
                  // "MAY 2026" and a "SEPTEMBER 2026".
                  width: Style.space(130)
                  horizontalAlignment: Text.AlignHCenter
                  text: Qt.formatDate(root.viewDate, "MMMM yyyy").toUpperCase()
                  color: Qt.darker(root.contentForeground, 1.4)
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                  font.letterSpacing: 1
                }

                PanelActionButton {
                  // Pulled out by the button's own padding so the glyph, not
                  // its hit box, lines up with the "2026" on the year rail.
                  anchors.left: parent.left
                  anchors.leftMargin: -Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: "󰅁"
                  tooltipText: "Previous month"
                  foreground: root.contentForeground
                  fontFamily: root.contentFontFamily
                  onClicked: root.moveMonth(-1)
                }

                PanelActionButton {
                  anchors.right: parent.right
                  anchors.rightMargin: -Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: "󰅂"
                  tooltipText: "Next month"
                  foreground: root.contentForeground
                  fontFamily: root.contentFontFamily
                  onClicked: root.moveMonth(1)
                }
              }
            }

            DayDetails {
              visible: root.selectedDayKey !== ""
              anchors.horizontalCenter: parent.horizontalCenter
              width: gridColumn.width
              calendarData: root.calendarData
              tasksData: root.tasksData
              dayKey: root.selectedDayKey
              nowMs: root.today.getTime()
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
            }

            UpcomingList {
              anchors.horizontalCenter: parent.horizontalCenter
              width: gridColumn.width
              calendarData: root.calendarData
              expanded: root.upcomingExpanded
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onToggleRequested: root.toggleUpcoming()
            }

            Text {
              textFormat: Text.PlainText
              visible: text !== ""
              anchors.horizontalCenter: parent.horizontalCenter
              width: gridColumn.width
              horizontalAlignment: Text.AlignHCenter
              elide: Text.ElideRight
              text: root.calendarData ? root.calendarData.statusText : ""
              color: Qt.darker(root.contentForeground, 1.5)
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
          }

          TasksTab {
            id: tasksTab
            visible: root.activeTab === "tasks"
            width: parent.width
            tasksData: root.tasksData
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onFocusReleaseRequested: Qt.callLater(function() { if (navCatcher) navCatcher.forceActiveFocus() })
          }
        }
      }
    }
  }
}
