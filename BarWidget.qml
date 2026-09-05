import QtQuick
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

  readonly property int barCount: intSetting("bars", 16, 4, 32)
  readonly property int barWidth: intSetting("barWidth", 3, 1, 12)
  readonly property int barGap: intSetting("barGap", 1, 0, 6)
  readonly property int fps: Model.streamFps(setting("fps", 30))
  readonly property bool showPeaks: setting("peaks", true) !== false
  readonly property bool hideWhenIdle: setting("hideWhenIdle", true) !== false

  // Per-tick fall rates. Defaults are tuned for 30fps: a full-height bar
  // reaches the floor in about half a second, and a peak cap hangs for a beat
  // before accelerating away over roughly three quarters of a second.
  readonly property real fall: realSetting("fall", 0.07, 0.005, 1)
  readonly property real gravity: realSetting("peakGravity", 0.004, 0.0005, 0.5)

  readonly property color colorLow: Model.colorOrFallback(setting("colorLow", ""), "#1fb714")
  readonly property color colorMid: Model.colorOrFallback(setting("colorMid", ""), "#e8e815")
  readonly property color colorHigh: Model.colorOrFallback(setting("colorHigh", ""), "#e82c0e")
  readonly property color peakColor: Model.colorOrFallback(setting("peakColor", ""),
                                                           bar ? bar.foreground : Color.foreground)

  // A stream that has delivered nothing for this long is treated as dead, so
  // the columns drain instead of freezing on the last frame that arrived.
  readonly property int staleMs: 1200
  // How long the spectrum has to sit unchanged before the player counts as
  // paused. Long enough to ride out the repeated frames that playback itself
  // produces when the frame rate outruns cliamp's analysis, and long enough
  // that a track change does not flicker the widget out and straight back in.
  readonly property int idleMs: 1500

  // --- state ----------------------------------------------------------------

  property var targets: Model.zeros(barCount)   // newest frame, folded
  property var levels: Model.zeros(barCount)    // what is drawn, after decay
  property var peaks: []                        // [{value, velocity}]
  property var lastBands: null                  // newest frame, raw, for the idle test
  property real lastFrameAt: 0                  // a frame arrived: the stream is alive
  property real lastChangeAt: 0                 // the spectrum moved: the player is playing
  property bool active: false

  function onFrame(line) {
    var frame = Model.parseFrame(line)
    if (!frame) return

    var now = Date.now()
    if (!Model.sameBands(root.lastBands, frame.bands)) root.lastChangeAt = now
    root.lastBands = frame.bands
    root.targets = Model.foldBands(frame.bands, root.barCount)
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

    // Nothing moving and nothing on screen: skip the arithmetic entirely rather
    // than decaying zeros into zeros thirty times a second for as long as the
    // bar is up and cliamp is not playing.
    if (idle && !root.active && Model.isSilent(root.levels, 0)) return

    // The columns always drain when idle, whether or not the widget goes on to
    // hide: a frozen spectrum reads as a hung widget, an empty one reads as a
    // paused player.
    root.levels = Model.applyDecay(root.levels, idle ? Model.zeros(root.barCount) : root.targets, root.fall)
    root.peaks = Model.applyPeaks(root.peaks, root.levels, root.gravity)

    root.active = !(idle && root.hideWhenIdle)
  }

  Timer {
    interval: Math.max(16, Math.round(1000 / root.fps))
    running: true
    repeat: true
    onTriggered: root.tick()
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

  implicitWidth: Model.spectrumWidth(barCount, barWidth, barGap) + Style.spacing.controlGap
  implicitHeight: barSize

  Spectrum {
    anchors.centerIn: parent
    width: Model.spectrumWidth(root.barCount, root.barWidth, root.barGap)
    height: Math.max(Style.space(12), root.barSize - Style.space(10))

    levels: root.levels
    peaks: Model.peakValues(root.peaks)
    barWidth: root.barWidth
    barGap: root.barGap
    showPeaks: root.showPeaks
    colorLow: root.colorLow
    colorMid: root.colorMid
    colorHigh: root.colorHigh
    peakColor: root.peakColor
  }
}
