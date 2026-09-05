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

## How many columns you get

cliamp's band count is a property of its **current visualizer mode**, not a constant:

| cliamp mode | Bands |
|-------------|-------|
| `Bars`, `BarsDot`, `Columns`, `Wave` | 10 |
| `ClassicPeak` | 64 |

So the widget draws one column per band and lets them divide a configured width, rather than
resampling to a column count of its own. Folding 10 bands up into more columns than that cannot
add detail — it only repeats each reading across two or three neighbours, which reads as
stair-steps. Set `maxBars` to fold the 64-band modes down; nothing ever folds up.

Because the *width* is what you configure and the columns divide it, switching cliamp's visualizer
mode re-slices the analyzer in place instead of resizing the widget and shoving its neighbours
along the bar.

## Configuration

The widget has no popup; everything lives in its `shell.json` entry and hot-reloads on save.

```json
{
  "id": "mapennbsd.cliamp-vis",
  "width": 120,
  "barGap": 1,
  "peaks": true,
  "hideWhenIdle": true
}
```

| Key | Default | Range | Meaning |
|-----|---------|-------|---------|
| `width` | `120` | 24–480 | Total width of the analyzer in pixels. The columns divide it. With `Bars`' 10 bands, 120 gives fat 12px columns; around 72 gives narrow ones. |
| `barGap` | `1` | 0–6 | Gap between columns. Dropped automatically when a high band count cannot afford it — the configured width wins over the gap, since a widget that overflowed would shove its neighbours. |
| `maxBars` | `0` | 0–64 | Fold down to at most this many columns. `0` follows cliamp exactly. |
| `fps` | `30` | 1–60 | Frames per second requested from `visstream`. Below about 20 the columns stop looking continuous. |
| `peaks` | `true` | | Winamp-style peak caps that hang at the loudest recent reading and then accelerate away. |
| `hideWhenIdle` | `true` | | Give up the bar slot when nothing is playing. With `false` the widget keeps its slot and shows an empty analyzer. |
| `fall` | `0.07` | 0.005–1 | How far a column may drop per frame. Higher falls faster. |
| `peakGravity` | `0.004` | 0.0005–0.5 | Downward acceleration of the peak caps. Higher drops them sooner. |
| `colorLow` | theme `green` | | Column colour at the bottom of its travel. |
| `colorMid` | theme `yellow` | | Column colour partway up. |
| `colorHigh` | theme `red` | | Column colour at full height. |
| `peakColor` | theme foreground | | Peak cap colour. |

## Toggling auto-hide

`hideWhenIdle` can be flipped at runtime over the shell's IPC, which writes the change back to
`shell.json` so it survives a restart:

```bash
omarchy-shell mapennbsd.cliamp-vis toggleAutoHide   # flip it
omarchy-shell mapennbsd.cliamp-vis autoHide         # hide when nothing is playing
omarchy-shell mapennbsd.cliamp-vis alwaysShow       # keep the slot, show an empty analyzer
omarchy-shell mapennbsd.cliamp-vis status           # which one is in force
```

Bind `toggleAutoHide` to a key in `~/.config/hypr/bindings.lua` if you want it on the keyboard.

There is deliberately no click-to-toggle: with auto-hide on and nothing playing there is no widget
left on the bar to click, so the control would be unreachable in exactly the state you would want
to leave.

Note that `omarchy bar set` writes values as strings (`"width": "120"`) unless you pass `--json`.
Every numeric setting is coerced, so both forms work.

## Colours

The gradient follows the active Omarchy theme. The `Color` singleton carries only foreground,
background, accent, urgent and muted, so the low-to-high ramp is read from the theme's own
`colors.toml` — `green`, `yellow`, `red` — and watched, so `omarchy theme set` recolours the
analyzer immediately. A theme missing one of those keys falls back to `muted`, `accent` and
`urgent` respectively.

A theme's green/yellow/red ramp is its own cool-to-hot progression, which is the same thing
Winamp's palette said, so the analyzer keeps meaning what it meant while matching the desktop.
For the literal Winamp palette instead, set the stops explicitly:

```json
{ "colorLow": "#1fb714", "colorMid": "#e8e815", "colorHigh": "#e82c0e" }
```

Colours accept `#rgb` or `#rrggbb`; `""` means "use the theme". The gradient is fixed to each
column's full height rather than stretched to the current reading, so a quiet column shows only
its coolest colour and only a loud one reaches the hottest — which is how Winamp's analyzer
coloured, and what makes column height and colour say the same thing.

Peak caps hide once they fall back to the floor. A cap resting on the baseline marks nothing, and
across a quiet spectrum a row of them reads as a dashed rule drawn under the whole widget.

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
