# Omarchy Cliamp Visualizer

**A Winamp-style spectrum analyzer for the Omarchy bar, driven by cliamp's own visualizer bands.**

![preview](preview.png)

The widget appears while [cliamp](https://github.com/dmarcoux/cliamp) is playing and gets out of
the way when it is not. It is display only — there are no transport controls.

## Why it reads cliamp instead of the audio device

cliamp ships `visstream`, which streams its visualizer bands as NDJSON, one frame per line, at a
requested frame rate. This widget subscribes to that.

The alternative — capturing a PipeWire monitor source and running an FFT — produces a visualizer
that is plausibly music-shaped but never in step with cliamp's own: different window size, band
mapping and smoothing, and readings taken before cliamp's EQ, mono and speed settings rather than
after. Reading `visstream` means the bar is drawing cliamp's numbers, so it matches the player
frame for frame.

The tradeoff is that this is a cliamp extension, not a general system visualizer. It does not
react to a browser, mpv, or notification sounds.

cliamp serves `visstream` to any number of subscribers at once, so this never competes with the
player's own TUI or with anything else reading the bands.

## Installation

```bash
omarchy plugin add https://github.com/mapennbsd/omarchy-cliamp-vis --enable
```

Or from a local checkout:

```bash
mkdir -p ~/.config/omarchy/plugins
cp -r omarchy-cliamp-vis ~/.config/omarchy/plugins/mapennbsd.cliamp-vis
omarchy plugin enable mapennbsd.cliamp-vis --section right
omarchy restart shell
```

A plugin the shell has never seen before is not picked up by a hot reload — or by
`omarchy-shell shell rescanPlugins` — so restart the shell once after the first install. Later
edits to the plugin's own files do hot-reload normally.

## Configuration

The widget has no popup; everything lives in its `shell.json` entry and hot-reloads on save.

```json
{
  "id": "mapennbsd.cliamp-vis",
  "bars": 16,
  "barWidth": 3,
  "barGap": 1,
  "peaks": true,
  "hideWhenIdle": true
}
```

| Key | Default | Range | Meaning |
|-----|---------|-------|---------|
| `bars` | `16` | 4–32 | Columns. cliamp's 64 bands are folded down to this many, taking the loudest of each group. |
| `barWidth` | `3` | 1–12 | Column width in pixels. |
| `barGap` | `1` | 0–6 | Gap between columns in pixels. |
| `fps` | `30` | 1–60 | Frames per second requested from `visstream`. Below about 20 the bars stop looking continuous. |
| `peaks` | `true` | | Winamp-style peak caps that hang at the loudest recent reading and then accelerate away. |
| `hideWhenIdle` | `true` | | Give up the bar slot when nothing is playing. With `false` the widget keeps its slot and shows an empty analyzer. |
| `fall` | `0.07` | 0.005–1 | How far a column may drop per frame. Higher falls faster. |
| `peakGravity` | `0.004` | 0.0005–0.5 | Downward acceleration of the peak caps. Higher drops them sooner. |
| `colorLow` | `#1fb714` | | Column colour at the bottom of its travel. |
| `colorMid` | `#e8e815` | | Column colour partway up. |
| `colorHigh` | `#e82c0e` | | Column colour at full height. |
| `peakColor` | theme foreground | | Peak cap colour. |

Colours accept `#rgb` or `#rrggbb`; `""` means "use the default". The gradient is fixed to each
column's full height rather than stretched to the current reading, so a quiet column shows only
its green foot and only a loud one reaches the red — which is how Winamp's analyzer coloured, and
what makes column height and colour say the same thing.

## Behaviour when nothing is playing

cliamp keeps serving `visstream` while paused, and what it serves is the last frame it analysed,
repeated verbatim — not zeros. A widget that only looked at the current frame would sit frozen
mid-spectrum and look hung. This one watches whether the spectrum is still *changing*, so a paused
or stopped player drains the columns and (by default) releases the bar slot.

If cliamp is not running at all, `visstream` exits and the widget retries on a backoff that starts
at two seconds and doubles to a thirty-second ceiling, resetting as soon as frames arrive. Starting
cliamp brings the widget back on its own.

## Multiple monitors

The bar is built once per monitor, so each screen's widget opens its own `visstream`. That is
supported and cheap — a reader process costs no measurable CPU — but it is one process per bar
rather than one per machine.

## Development

```bash
node --test test/model.test.js
```

`Model.js` holds the frame parsing, band folding, decay, peak physics and idle detection as plain
functions with no QML dependency, which is what the tests exercise. `Spectrum.qml` is paint only
and `BarWidget.qml` is stream plumbing.

## License

MIT
