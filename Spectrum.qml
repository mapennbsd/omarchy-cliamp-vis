import QtQuick

// The columns themselves. Kept apart from BarWidget so the widget file is only
// stream plumbing and this file is only paint.
Item {
  id: root

  property var levels: []
  property var peaks: []
  property int barWidth: 3
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

  Row {
    anchors.fill: parent
    spacing: root.barGap

    Repeater {
      model: root.levels.length

      delegate: Item {
        id: column
        required property int index

        width: root.barWidth
        height: root.height

        readonly property real level: root.levelAt(index)
        readonly property real peak: root.peakAt(index)

        // A window that grows from the bottom, clipping a gradient that is
        // always the column's full height. The palette is therefore fixed to
        // the column rather than stretched to the bar, so a quiet bar shows
        // only its green foot and only a loud one reaches the red — which is
        // how Winamp's analyzer coloured. Stretching instead would paint every
        // bar the same green-to-red sweep and lose all loudness information.
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

        // Peak cap, riding one pixel clear of the column so it stays legible
        // as a separate marker when a sustained note parks the bar under it.
        Rectangle {
          width: parent.width
          height: 1
          color: root.peakColor
          visible: root.showPeaks && column.peak > 0
          y: Math.max(0, Math.round((1 - column.peak) * column.height) - 1)
        }
      }
    }
  }
}
