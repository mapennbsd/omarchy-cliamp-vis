import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "mapennbsd.cliamp-vis"

  // --- settings -------------------------------------------------------------
  // This widget has no popup by design, so every knob lives in the widget's
  // shell.json entry and hot-reloads with the file. `setting` is the base class
  // helper; reading through it keeps the bindings live when shell.json is
  // edited under a running shell.

  // Blank is rejected before Number sees it, since Number("") is 0 and would
  // silently clamp to the minimum instead of taking the documented default.
  function numberSetting(name, fallback) {
    var raw = setting(name, fallback)
    var text = String(raw === undefined || raw === null ? "" : raw).trim()
    var value = text === "" ? NaN : Number(text)
    return isFinite(value) ? value : fallback
  }

  function intSetting(name, fallback, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, Math.round(numberSetting(name, fallback))))
  }

  function realSetting(name, fallback, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, numberSetting(name, fallback)))
  }

  // The analyzer's total width. The columns divide it, rather than the width
  // falling out of a column count — cliamp's band count changes with its
  // visualizer mode, and the widget should not resize under its neighbours
  // every time that happens.
  readonly property int spanWidth: intSetting("width", 120, 24, 480)
  readonly property int barGap: intSetting("barGap", 1, 0, 6)
  // 0 follows cliamp's band count exactly. A cap only ever folds columns away,
  // never invents them.
  readonly property int maxBars: intSetting("maxBars", 0, 0, 64)
  readonly property int fps: Model.streamFps(setting("fps", 30))
  readonly property bool showPeaks: setting("peaks", true) !== false
  readonly property bool hideWhenIdle: setting("hideWhenIdle", true) !== false

  // Per-tick fall rates. Defaults are tuned for 30fps: a full-height column
  // reaches the floor in about half a second, and a peak cap hangs for a beat
  // before accelerating away over roughly three quarters of a second.
  readonly property real fall: realSetting("fall", 0.07, 0.005, 1)
  readonly property real gravity: realSetting("peakGravity", 0.004, 0.0005, 0.5)

  // --- colour ---------------------------------------------------------------

  // Palette read from the active theme, keyed as in colors.toml.
  property var themeColors: ({})

  // Resolution order for a gradient stop: an explicit shell.json colour, then
  // the theme's own palette entry, then the nearest role on the Color singleton
  // for a theme whose colors.toml is missing that key.
  function stopColor(key, paletteName, singletonRole) {
    var configured = Model.normalizeHex(setting(key, ""))
    if (configured !== "") return configured

    var themed = Model.normalizeHex(themeColors[paletteName])
    if (themed !== "") return themed

    return Model.colorOrFallback(String(singletonRole), "#cacccc")
  }

  // Low to high across the column's travel. A theme's green/yellow/red is its
  // own cool-to-hot ramp, which is the same thing Winamp's palette said, so the
  // analyzer keeps meaning what it meant while matching the desktop.
  readonly property color colorLow: stopColor("colorLow", "green", Color.muted)
  readonly property color colorMid: stopColor("colorMid", "yellow", Color.accent)
  readonly property color colorHigh: stopColor("colorHigh", "red", Color.urgent)
  // The caps follow the bar's own foreground, which is what every other glyph
  // on the bar is drawn in.
  readonly property color peakColor: Model.colorOrFallback(setting("peakColor", ""),
                                                           bar ? bar.foreground : Color.foreground)

  function refreshThemeNow() { themeFile.reload() }
  function handleTheme(raw) { root.themeColors = Model.parseThemeColors(raw) }

  FileView {
    id: themeFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    printErrors: false
    // text() is stale inside the change signal itself, so route both paths
    // through reload() -> onLoaded, as Commons/Color.qml does for its own file.
    onFileChanged: reload()
    onLoaded: root.handleTheme(text())
    onLoadFailed: root.handleTheme("")
  }

  // A theme switch arrives as a `shell applyTheme` IPC call carrying the
  // palette in memory, which a plugin cannot hook. The Color singleton that
  // handler updates is observable, so it serves as a second trigger in case the
  // on-disk write does not wake the watcher.
  Connections {
    target: Color
    function onAccentChanged() { root.refreshThemeNow() }
    function onForegroundChanged() { root.refreshThemeNow() }
    function onUrgentChanged() { root.refreshThemeNow() }
    function onMutedChanged() { root.refreshThemeNow() }
  }

  // --- state ----------------------------------------------------------------

  property var targets: []       // newest frame, folded to the column count
  property var levels: []        // what is drawn, after decay
  property var peaks: []         // [{value, velocity}]
  property var lastBands: null   // newest frame, raw, for the idle test
  property real lastFrameAt: 0   // a frame arrived: the stream is alive
  property real lastChangeAt: 0  // the spectrum moved: the player is playing
  property bool active: false

  // The gap the span can afford at this band count, and the columns that fill
  // what is left. Both the layout and the Row's spacing read the same value, or
  // the widget would render wider than it measured.
  readonly property int columnGap: Model.effectiveGap(spanWidth, levels.length, barGap)
  readonly property var widths: Model.columnWidths(spanWidth, levels.length, columnGap)

  // A stream that has delivered nothing for this long is treated as dead, so
  // the columns drain instead of freezing on the last frame that arrived.
  readonly property int staleMs: 1200
  // How long the spectrum has to sit unchanged before the player counts as
  // paused. Long enough to ride out the repeated frames that playback itself
  // produces when the frame rate outruns cliamp's analysis, and long enough
  // that a track change does not flicker the widget out and straight back in.
  readonly property int idleMs: 1500

  function onFrame(line) {
    var frame = Model.parseFrame(line)
    if (!frame) return

    var now = Date.now()
    if (!Model.sameBands(root.lastBands, frame.bands)) root.lastChangeAt = now
    root.lastBands = frame.bands
    root.targets = Model.foldBands(frame.bands, Model.columnCount(frame.bands.length, root.maxBars))
    root.lastFrameAt = now
    // Frames are arriving, so whatever backoff the last outage built up has
    // been paid off; the next one should start from the short delay again.
    root.retryDelay = 2000
  }

  function tick() {
    var now = Date.now()
    // Dead stream (cliamp gone) and a live one that has stopped advancing
    // (paused, stopped, between tracks) are the same thing to the rendering:
    // both mean there is nothing to show. They differ only in that the second
    // recovers on its own, without the process having to be restarted.
    var idle = now - root.lastFrameAt > root.staleMs || now - root.lastChangeAt > root.idleMs

    // Settled before the early return below, so visibility still follows a
    // hideWhenIdle toggle while the widget is parked. Deciding it after the
    // return would leave a widget that is already hidden hidden — the toggle
    // would appear to do nothing until the music came back.
    root.active = !(idle && root.hideWhenIdle)

    // Drained, with nothing arriving to move it: skip the arithmetic rather
    // than decaying zeros into zeros thirty times a second for as long as the
    // bar is up and cliamp is not playing.
    //
    // The caps have to be settled too, not just the columns. They are still
    // falling for a beat after the columns have gone, so stopping at an empty
    // spectrum alone strands them mid-air over an empty analyzer — which
    // auto-hide used to cover up by fading the widget out first.
    if (idle && Model.isSilent(root.levels, 0) && Model.peaksSettled(root.peaks)) return

    // The columns always drain when idle, whether or not the widget goes on to
    // hide: a frozen spectrum reads as a hung widget, an empty one reads as a
    // paused player.
    root.levels = Model.applyDecay(root.levels, idle ? Model.zeros(root.levels.length) : root.targets, root.fall)
    root.peaks = Model.applyPeaks(root.peaks, root.levels, root.gravity)
  }

  Timer {
    interval: Math.max(16, Math.round(1000 / root.fps))
    running: true
    repeat: true
    onTriggered: root.tick()
  }

  // --- auto-hide toggle -------------------------------------------------------

  // Writes hideWhenIdle back to shell.json so the choice survives a restart,
  // rather than flipping a property that resets with the shell.
  //
  // updateEntryInline replaces the widget's entry with what it is handed rather
  // than merging into it, so the whole entry goes back with the one key
  // changed. Sending `{hideWhenIdle}` alone would drop the width, colours and
  // everything else the user had set.
  function setAutoHide(enable) {
    if (!bar || !bar.shell || typeof bar.shell.updateEntryInline !== "function")
      return "unavailable: no shell config to write to"

    bar.shell.updateEntryInline(moduleName, Model.withSetting(settings, "hideWhenIdle", !!enable))
    return enable ? "auto-hide on: hides when cliamp is not playing"
                  : "auto-hide off: always visible"
  }

  // Bindable from Hyprland or runnable from a script:
  //   omarchy-shell mapennbsd.cliamp-vis toggleAutoHide
  //
  // The bar is built once per monitor, so every surface registers this target
  // and one of them wins the route — which is enough, because the winner
  // persists to shell.json and every surface picks the change up from there.
  IpcHandler {
    target: root.moduleName

    function toggleAutoHide(): string { return root.setAutoHide(!root.hideWhenIdle) }
    function autoHide(): string { return root.setAutoHide(true) }
    function alwaysShow(): string { return root.setAutoHide(false) }
    function status(): string {
      return root.hideWhenIdle ? "auto-hide on" : "auto-hide off"
    }
  }

  // --- stream ---------------------------------------------------------------

  // cliamp serves visstream to any number of subscribers at once, so this never
  // competes with the player's own TUI or with anything else reading the bands.
  //
  // Started from Component.onCompleted rather than a `running: true` binding.
  // Any assignment to `running` replaces such a binding, so a restart racing
  // start-up would leave the process stopped with nothing left to turn it back
  // on — and assigning false to an already-stopped process raises no
  // onRunningChanged, so not even the retry timer would be armed.
  Process {
    id: stream
    command: Model.streamCommand(root.fps)
    stdout: SplitParser {
      onRead: function(data) { root.onFrame(data) }
    }
    onRunningChanged: if (!running) retry.restart()
  }

  // cliamp is not always up, and visstream exits when it is not. Back off
  // rather than respawning a process every couple of seconds for the whole
  // session; a frame arriving resets the delay, so the widget still returns
  // promptly once cliamp is started again.
  property int retryDelay: 2000

  Timer {
    id: retry
    interval: root.retryDelay
    onTriggered: {
      // A restart that has already happened by other means leaves nothing to do
      // and must not spend a doubling, or start-up alone would push the backoff
      // up before the first real outage.
      if (stream.running) return
      root.retryDelay = Math.min(30000, root.retryDelay * 2)
      stream.running = true
    }
  }

  function restartStream() {
    stream.running = false
    retry.restart()
  }

  // Restart onto the new frame rate; the command binding has already picked it
  // up by the time the retry timer fires.
  onFpsChanged: restartStream()

  Component.onCompleted: stream.running = true

  // --- presentation ---------------------------------------------------------

  // Fading rather than snapping, and collapsing the slot only once the fade has
  // finished, so the widgets to the left do not jump the instant a track ends.
  opacity: active ? 1 : 0
  visible: opacity > 0
  Behavior on opacity { NumberAnimation { duration: 220; easing.type: Easing.InOutQuad } }

  implicitWidth: spanWidth + Style.spacing.controlGap
  implicitHeight: barSize

  Spectrum {
    anchors.centerIn: parent
    width: Model.spectrumWidth(root.widths, root.columnGap)
    height: Math.max(Style.space(12), root.barSize - Style.space(10))

    levels: root.levels
    peaks: Model.peakValues(root.peaks)
    widths: root.widths
    barGap: root.columnGap
    showPeaks: root.showPeaks
    colorLow: root.colorLow
    colorMid: root.colorMid
    colorHigh: root.colorHigh
    peakColor: root.peakColor
  }
}
