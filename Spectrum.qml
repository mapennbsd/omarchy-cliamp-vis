import QtQuick

// The columns themselves. Kept apart from BarWidget so the widget file is only
// stream plumbing and this file is only paint.
Item {
  id: root

  property var levels: []
  property var peaks: []
  // One entry per column. Their count is the column count, so the band count
  // cliamp is sending drives the layout directly.
  property var widths: []
  property int barGap: 1
  property bool showPeaks: true
  property color colorLow: "#1fb714"
  property color colorMid: "#e8e815"
  property color colorHigh: "#e82c0e"
  property color peakColor: "#c8c8c8"

  function levelAt(index) {
    var value = index >= 0 && index < levels.length ? Number(levels[index]) : 0
    return isFinite(value) && value > 0 ? Math.min(1, value) : 0
  }

  function peakAt(index) {
    var value = index >= 0 && index < peaks.length ? Number(peaks[index]) : 0
    return isFinite(value) && value > 0 ? Math.min(1, value) : 0
  }

  function widthAt(index) {
    var value = index >= 0 && index < widths.length ? Math.floor(Number(widths[index])) : 0
    return isFinite(value) && value > 1 ? value : 1
  }

  Row {
    anchors.fill: parent
    spacing: root.barGap

    Repeater {
      model: root.widths.length

      delegate: Item {
        id: column
        required property int index

        width: root.widthAt(index)
        height: root.height

        readonly property real level: root.levelAt(index)
        readonly property real peak: root.peakAt(index)

        // A window that grows from the bottom, clipping a gradient that is
        // always the column's full height. The palette is therefore fixed to
        // the column rather than stretched to the bar, so a quiet column shows
        // only its coolest colour and only a loud one reaches the hottest —
        // which is how Winamp's analyzer coloured. Stretching instead would
        // paint every column the same full sweep and lose all loudness
        // information.
        Item {
          anchors.bottom: parent.bottom
          width: parent.width
          height: Math.round(column.level * column.height)
          visible: height > 0
          clip: true

          Rectangle {
            anchors.bottom: parent.bottom
            width: parent.width
            height: column.height
            gradient: Gradient {
              GradientStop { position: 0.0; color: root.colorHigh }
              GradientStop { position: 0.55; color: root.colorMid }
              GradientStop { position: 1.0; color: root.colorLow }
            }
          }
        }

        // Peak cap, riding one pixel clear of the column so it stays legible as
        // a separate marker when a sustained note parks the column under it.
        //
        // Hidden once it has fallen back to the floor: a cap resting on the
        // baseline marks nothing, and across a quiet spectrum a row of them
        // reads as a dashed rule drawn under the whole widget — louder than the
        // data it is supposed to annotate.
        Rectangle {
          width: parent.width
          height: 1
          color: root.peakColor
          visible: root.showPeaks && Math.round(column.peak * column.height) >= 1
          y: Math.max(0, Math.round((1 - column.peak) * column.height) - 1)
        }
      }
    }
  }
}
