const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("./load")

const FRAME = '{"ok":true,"visualizer":"Bars","bands":[0.5,0.25,0,1]}'

// --- streamFps / streamCommand ---------------------------------------------

test("streamFps clamps to the range visstream accepts", () => {
  assert.equal(Model.streamFps(30), 30)
  assert.equal(Model.streamFps(0), 1)
  assert.equal(Model.streamFps(-5), 1)
  assert.equal(Model.streamFps(61), 60)
  assert.equal(Model.streamFps(1000), 60)
})

test("streamFps falls back to 30 for junk rather than producing NaN", () => {
  for (const raw of ["", null, undefined, "fast", {}])
    assert.equal(Model.streamFps(raw), 30, JSON.stringify(raw))
})

test("streamFps rounds fractional rates", () => {
  assert.equal(Model.streamFps(29.6), 30)
  assert.equal(Model.streamFps("24"), 24)
})

test("streamCommand builds an argv with the frame rate as a string", () => {
  assert.deepEqual(Model.streamCommand(24), ["cliamp", "visstream", "--fps", "24"])
  assert.deepEqual(Model.streamCommand(999), ["cliamp", "visstream", "--fps", "60"])
})

// --- player state -------------------------------------------------------------

test("statusCommand asks cliamp for machine-readable state", () => {
  assert.deepEqual(Model.statusCommand(), ["cliamp", "status", "--json"])
})

test("parseStatus reads playing and paused", () => {
  assert.equal(Model.parseStatus('{"ok":true,"state":"playing","volume":0}'), "playing")
  assert.equal(Model.parseStatus('{"ok":true,"state":"paused"}'), "paused")
  assert.equal(Model.parseStatus('{"ok":true,"state":"Paused"}'), "paused")
})

test("parseStatus treats a blank state as stopped, as cliamp's own text output does", () => {
  assert.equal(Model.parseStatus('{"ok":true,"state":""}'), "stopped")
  assert.equal(Model.parseStatus('{"ok":true}'), "stopped")
  assert.equal(Model.parseStatus('{"ok":true,"state":"stopped"}'), "stopped")
})

test("parseStatus treats anything unreadable as stopped", () => {
  // cliamp not running prints its error on stderr and nothing on stdout.
  for (const raw of ["", null, undefined, "not json", "[]", "null", '{"ok":false,"state":"paused"}'])
    assert.equal(Model.parseStatus(raw), "stopped", JSON.stringify(raw))
})

test("holdsSlot keeps a paused player clickable and hides a stopped one", () => {
  assert.equal(Model.holdsSlot("paused"), true)
  assert.equal(Model.holdsSlot("playing"), true)
  assert.equal(Model.holdsSlot("stopped"), false)
  assert.equal(Model.holdsSlot(""), false)
})

// --- clickCommand -------------------------------------------------------------

test("clickCommand maps left, right and middle to toggle, next and prev", () => {
  assert.deepEqual(Model.clickCommand(1), ["cliamp", "toggle"])
  assert.deepEqual(Model.clickCommand(2), ["cliamp", "next"])
  assert.deepEqual(Model.clickCommand(4), ["cliamp", "prev"])
})

test("clickCommand ignores buttons it has no action for", () => {
  for (const button of [0, 8, 16, undefined, "left"])
    assert.equal(Model.clickCommand(button), null, JSON.stringify(button))
})

// --- parseFrame -------------------------------------------------------------

test("parseFrame reads a visstream line", () => {
  const frame = Model.parseFrame(FRAME)
  assert.equal(frame.visualizer, "Bars")
  assert.deepEqual(frame.bands, [0.5, 0.25, 0, 1])
})

test("parseFrame tolerates the trailing newline SplitParser may leave", () => {
  assert.deepEqual(Model.parseFrame(FRAME + "\n").bands, [0.5, 0.25, 0, 1])
})

test("parseFrame rejects a frame that reports failure", () => {
  assert.equal(Model.parseFrame('{"ok":false,"bands":[0.5]}'), null)
})

test("parseFrame rejects junk instead of throwing", () => {
  for (const raw of ["", "   ", null, undefined, "not json", "{", "[1,2]", '{"ok":true}', '{"ok":true,"bands":"nope"}'])
    assert.equal(Model.parseFrame(raw), null, JSON.stringify(raw))
})

test("parseFrame rejects a frame carrying no bands at all", () => {
  // An empty spectrum would otherwise lay out zero columns and read as a live
  // stream, holding the widget open on nothing.
  assert.equal(Model.parseFrame('{"ok":true,"bands":[]}'), null)
})

test("parseFrame accepts a frame with no visualizer field", () => {
  assert.equal(Model.parseFrame('{"ok":true,"bands":[0.5]}').visualizer, "")
})

// --- foldBands --------------------------------------------------------------

test("foldBands takes the group maximum, not the mean", () => {
  // A mean would give 0.5 for the first group and flatten the transient.
  assert.deepEqual(Model.foldBands([1, 0, 0, 0], 2), [1, 0])
})

test("foldBands folds 64 bands down to the requested column count", () => {
  const bands = Array.from({ length: 64 }, (_, i) => i / 63)
  const folded = Model.foldBands(bands, 16)
  assert.equal(folded.length, 16)
  assert.equal(folded[15], 1)
  // Each group is four source bands, so group 0 peaks at index 3.
  assert.equal(folded[0], 3 / 63)
})

test("foldBands clamps readings into 0..1", () => {
  assert.deepEqual(Model.foldBands([-2, 5], 2), [0, 1])
})

test("foldBands passes readings straight through at one column per band", () => {
  // The Bars mode's 10 bands are drawn as 10 columns, so nothing is folded.
  assert.deepEqual(Model.foldBands([0.1, 0.9, 0.4], 3), [0.1, 0.9, 0.4])
})

test("foldBands never leaves an empty group when asked for more columns than bands", () => {
  const folded = Model.foldBands([1, 0.5], 5)
  assert.equal(folded.length, 5)
  assert.ok(folded.every(v => v >= 0 && v <= 1))
})

test("foldBands returns zeros for a missing or empty spectrum", () => {
  assert.deepEqual(Model.foldBands([], 3), [0, 0, 0])
  assert.deepEqual(Model.foldBands(null, 3), [0, 0, 0])
})

test("foldBands ignores non-finite bands rather than propagating NaN", () => {
  assert.deepEqual(Model.foldBands([NaN, 0.4], 1), [0.4])
})

// --- columnCount ------------------------------------------------------------

test("columnCount follows cliamp's band count when uncapped", () => {
  // Bars and Columns stream 10 bands, ClassicPeak streams 64.
  assert.equal(Model.columnCount(10, 0), 10)
  assert.equal(Model.columnCount(64, 0), 64)
})

test("columnCount caps a wide mode without inventing columns for a narrow one", () => {
  assert.equal(Model.columnCount(64, 24), 24)
  // 10 bands stay 10 columns even when a larger cap is set: folding up would
  // only repeat readings across neighbours.
  assert.equal(Model.columnCount(10, 24), 10)
})

test("columnCount handles the degenerate cases", () => {
  assert.equal(Model.columnCount(0, 0), 0)
  assert.equal(Model.columnCount(null, null), 0)
  assert.equal(Model.columnCount(-4, 0), 0)
})

// --- columnWidths -----------------------------------------------------------

test("columnWidths fills the span exactly, gaps included", () => {
  const widths = Model.columnWidths(120, 10, 1)
  assert.equal(widths.length, 10)
  assert.equal(Model.spectrumWidth(widths, 1), 120)
})

test("columnWidths spreads the remainder rather than dropping it", () => {
  // 100 - 9 gaps = 91 across 10 columns: nine 9s and one 10, not ten 9s.
  const widths = Model.columnWidths(100, 10, 1)
  assert.equal(widths.reduce((a, b) => a + b, 0), 91)
  assert.deepEqual([...new Set(widths)].sort((a, b) => a - b), [9, 10])
})

test("columnWidths keeps every column a whole number of pixels", () => {
  for (const count of [7, 10, 13, 24, 64]) {
    for (const w of Model.columnWidths(120, count, 1))
      assert.equal(w, Math.floor(w), `count=${count}`)
  }
})

test("columnWidths keeps the analyzer one width as the band count changes", () => {
  // A cliamp visualizer switch changes the band count; the widget must not
  // resize under its neighbours on the bar. At 64 bands the gap is what gives.
  for (const count of [10, 24, 64]) {
    const gap = Model.effectiveGap(120, count, 1)
    assert.equal(Model.spectrumWidth(Model.columnWidths(120, count, gap), gap), 120, `count=${count}`)
  }
})

// --- effectiveGap -----------------------------------------------------------

test("effectiveGap grants the requested gap when the span can afford it", () => {
  assert.equal(Model.effectiveGap(120, 10, 1), 1)
})

test("effectiveGap drops the gap rather than overflowing the span", () => {
  // 64 columns at 1px plus 63 gaps is 127px, which would not fit in 120.
  assert.equal(Model.effectiveGap(120, 64, 1), 0)
})

test("effectiveGap never exceeds what was asked for", () => {
  assert.equal(Model.effectiveGap(480, 10, 1), 1)
  assert.equal(Model.effectiveGap(480, 10, 0), 0)
})

test("effectiveGap has nothing to space with fewer than two columns", () => {
  assert.equal(Model.effectiveGap(120, 1, 1), 0)
  assert.equal(Model.effectiveGap(120, 0, 1), 0)
})

test("columnWidths never produces a column narrower than a pixel", () => {
  // 64 columns and 63 gaps cannot fit in 40px; the columns win.
  for (const w of Model.columnWidths(40, 64, 1)) assert.ok(w >= 1)
})

test("columnWidths returns nothing to lay out when there are no columns", () => {
  assert.deepEqual(Model.columnWidths(120, 0, 1), [])
})

// --- spectrumWidth ----------------------------------------------------------

test("spectrumWidth counts the gaps between columns, not after the last one", () => {
  assert.equal(Model.spectrumWidth([3, 3, 3, 3], 1), 4 * 3 + 3)
})

test("spectrumWidth handles the degenerate cases", () => {
  assert.equal(Model.spectrumWidth([], 1), 0)
  assert.equal(Model.spectrumWidth(null, 1), 0)
  assert.equal(Model.spectrumWidth([3], 1), 3)
  assert.equal(Model.spectrumWidth([3, 3], 0), 6)
})

// --- applyDecay -------------------------------------------------------------

test("applyDecay rises instantly", () => {
  assert.deepEqual(Model.applyDecay([0], [1], 0.1), [1])
})

test("applyDecay falls by at most the fall rate", () => {
  assert.deepEqual(Model.applyDecay([1], [0], 0.1), [0.9])
})

test("applyDecay never falls below the target", () => {
  assert.deepEqual(Model.applyDecay([0.5], [0.45], 0.1), [0.45])
})

test("applyDecay reaches zero rather than approaching it forever", () => {
  let levels = [1]
  for (let i = 0; i < 20; i++) levels = Model.applyDecay(levels, [0], 0.07)
  assert.equal(levels[0], 0)
})

test("applyDecay adopts the target's length when the column count changes", () => {
  assert.deepEqual(Model.applyDecay([1, 1, 1], [0.5, 0.5], 1), [0.5, 0.5])
  assert.deepEqual(Model.applyDecay([1], [1, 1], 1), [1, 1])
})

// --- applyPeaks -------------------------------------------------------------

test("applyPeaks snaps a cap up to a new peak and resets its fall", () => {
  const peaks = Model.applyPeaks([{ value: 0.2, velocity: 0.5 }], [0.9], 0.004)
  assert.deepEqual(peaks, [{ value: 0.9, velocity: 0 }])
})

test("applyPeaks accelerates downward instead of falling at a constant rate", () => {
  let peaks = Model.applyPeaks([], [1], 0.01)
  const drops = []
  let previous = peaks[0].value
  for (let i = 0; i < 3; i++) {
    peaks = Model.applyPeaks(peaks, [0], 0.01)
    drops.push(previous - peaks[0].value)
    previous = peaks[0].value
  }
  assert.ok(drops[1] > drops[0] && drops[2] > drops[1], `expected acceleration, got ${drops}`)
})

test("applyPeaks hangs briefly at the peak before the fall is visible", () => {
  let peaks = Model.applyPeaks([], [1], 0.004)
  peaks = Model.applyPeaks(peaks, [0], 0.004)
  assert.ok(peaks[0].value > 0.99, "first frame after the peak should barely move")
})

test("applyPeaks never lets a cap sink below its column", () => {
  const peaks = Model.applyPeaks([{ value: 0.5, velocity: 10 }], [0.4], 0.004)
  assert.equal(peaks[0].value, 0.4)
})

test("applyPeaks settles at zero", () => {
  let peaks = Model.applyPeaks([], [1], 0.004)
  for (let i = 0; i < 60; i++) peaks = Model.applyPeaks(peaks, [0], 0.004)
  assert.equal(peaks[0].value, 0)
})

test("applyPeaks starts from nothing when the column count grows", () => {
  assert.deepEqual(Model.applyPeaks([], [0.5, 0.25], 0.004),
                   [{ value: 0.5, velocity: 0 }, { value: 0.25, velocity: 0 }])
})

test("peaksSettled is false while a cap is still falling", () => {
  // The columns reach zero a beat before the caps do; stopping the animation on
  // the columns alone strands the caps mid-air.
  assert.equal(Model.peaksSettled([{ value: 0.3, velocity: 0.02 }]), false)
})

test("peaksSettled is true once every cap has reached the floor", () => {
  assert.equal(Model.peaksSettled([{ value: 0, velocity: 0 }, { value: 0, velocity: 0 }]), true)
  assert.equal(Model.peaksSettled([]), true)
  assert.equal(Model.peaksSettled(null), true)
})

test("peaksSettled ignores a hole in the peak state", () => {
  assert.equal(Model.peaksSettled([null, { value: 0, velocity: 0 }]), true)
})

test("a cap is still falling at the moment its column lands", () => {
  // This is the invariant the render guard depends on: stopping the animation
  // when the columns drain would strand the cap in mid-air. Run to the exact
  // tick the columns land on rather than a fixed count, so the test does not
  // quietly stop proving anything if the default rates are retuned.
  let levels = [1]
  let peaks = Model.applyPeaks([], levels, 0.004)
  let ticks = 0
  while (!Model.isSilent(levels, 0) && ticks < 1000) {
    levels = Model.applyDecay(levels, [0], 0.07)
    peaks = Model.applyPeaks(peaks, levels, 0.004)
    ticks++
  }

  assert.equal(Model.isSilent(levels, 0), true, "columns should have drained")
  assert.equal(Model.peaksSettled(peaks), false, "cap should still be falling when its column lands")
})

test("peakValues projects the render values out of the peak state", () => {
  assert.deepEqual(Model.peakValues([{ value: 0.5, velocity: 0.1 }, null]), [0.5, 0])
  assert.deepEqual(Model.peakValues(null), [])
})

// --- sameBands --------------------------------------------------------------

test("sameBands spots the repeated frame a paused player streams", () => {
  // cliamp repeats its last analysed frame verbatim while paused, so the test
  // for idleness has to be equality against the previous frame, not quietness.
  assert.equal(Model.sameBands([0.5, 0.25], [0.5, 0.25]), true)
})

test("sameBands spots a spectrum that is still moving", () => {
  assert.equal(Model.sameBands([0.5, 0.25], [0.5, 0.26]), false)
})

test("sameBands treats a changed column count as movement", () => {
  assert.equal(Model.sameBands([0.5], [0.5, 0.5]), false)
})

test("sameBands treats a missing frame as movement, so a first frame never reads as idle", () => {
  assert.equal(Model.sameBands(null, [0.5]), false)
  assert.equal(Model.sameBands([0.5], null), false)
  assert.equal(Model.sameBands(null, null), false)
})

test("sameBands compares every column, not just the loud ones", () => {
  const a = new Array(64).fill(0)
  const b = new Array(64).fill(0)
  b[63] = 0.0001
  assert.equal(Model.sameBands(a, b), false)
})

test("sameBands reads two all-zero frames as unchanged", () => {
  assert.equal(Model.sameBands([0, 0, 0], [0, 0, 0]), true)
})

// --- isSilent / zeros -------------------------------------------------------

test("isSilent reads a spectrum of zeros as silence", () => {
  assert.equal(Model.isSilent([0, 0, 0], 0.005), true)
})

test("isSilent reads one audible column as sound", () => {
  assert.equal(Model.isSilent([0, 0, 0.2], 0.005), false)
})

test("isSilent ignores noise under the threshold", () => {
  assert.equal(Model.isSilent([0.001, 0.002], 0.005), true)
})

test("isSilent treats an empty spectrum as silence", () => {
  assert.equal(Model.isSilent([], 0.005), true)
  assert.equal(Model.isSilent(null, 0.005), true)
})

test("zeros builds a spectrum of the requested width", () => {
  assert.deepEqual(Model.zeros(3), [0, 0, 0])
  assert.deepEqual(Model.zeros(0), [])
  assert.deepEqual(Model.zeros(-1), [])
})

// --- colour -----------------------------------------------------------------

test("normalizeHex drops the alpha channel Qt puts in front", () => {
  assert.equal(Model.normalizeHex("#ff1fb714"), "#1fb714")
})

test("normalizeHex expands shorthand", () => {
  assert.equal(Model.normalizeHex("#0f0"), "#00ff00")
})

test("normalizeHex rejects anything that is not a colour", () => {
  for (const raw of ["", null, undefined, "green", "#12", "#12345"])
    assert.equal(Model.normalizeHex(raw), "", JSON.stringify(raw))
})

test("colorOrFallback keeps a configured colour and falls back on an unset one", () => {
  assert.equal(Model.colorOrFallback("#1fb714", "#ffffff"), "#1fb714")
  assert.equal(Model.colorOrFallback("", "#ffffff"), "#ffffff")
  assert.equal(Model.colorOrFallback("nonsense", "#ffffff"), "#ffffff")
})

// --- withSetting ------------------------------------------------------------

test("withSetting carries every other key back", () => {
  // updateEntryInline replaces the entry rather than merging, so anything left
  // out of the payload is dropped from the user's config.
  const entry = { id: "mapennbsd.cliamp-vis", width: 96, barGap: 2, colorLow: "#1fb714" }
  const next = Model.withSetting(entry, "hideWhenIdle", false)
  assert.equal(next.width, 96)
  assert.equal(next.barGap, 2)
  assert.equal(next.colorLow, "#1fb714")
  assert.equal(next.hideWhenIdle, false)
})

test("withSetting drops id, which the shell supplies itself", () => {
  assert.equal("id" in Model.withSetting({ id: "x", width: 96 }, "hideWhenIdle", true), false)
})

test("withSetting overwrites a key that is already set", () => {
  assert.equal(Model.withSetting({ hideWhenIdle: true }, "hideWhenIdle", false).hideWhenIdle, false)
})

test("withSetting does not mutate the entry it was given", () => {
  const entry = { width: 96 }
  Model.withSetting(entry, "hideWhenIdle", false)
  assert.deepEqual(entry, { width: 96 })
})

test("withSetting copes with an empty or missing entry", () => {
  assert.deepEqual(Model.withSetting({}, "hideWhenIdle", true), { hideWhenIdle: true })
  assert.deepEqual(Model.withSetting(null, "hideWhenIdle", true), { hideWhenIdle: true })
  assert.deepEqual(Model.withSetting(undefined, "hideWhenIdle", true), { hideWhenIdle: true })
})

// --- parseThemeColors -------------------------------------------------------

// Shaped like a real Omarchy theme's colors.toml, variants included.
const THEME = [
  'mode = "dark"',
  '',
  'accent = "#faa968"',
  'muted = "#2a6b78"',
  'background = "#05182e"',
  'foreground = "#f6dcac"',
  'dark_foreground = "#3f8f8a"',
  'light_foreground = "#a7c9c6"',
  'red = "#f85525"',
  'yellow = "#e97b3c"',
  'green = "#028391"',
  'bright_red = "#f85525"',
  'bright_yellow = "#e97b3c"',
  'bright_green = "#028391"'
].join("\n")

test("parseThemeColors picks up the ramp the gradient needs", () => {
  const colors = Model.parseThemeColors(THEME)
  assert.equal(colors.green, "#028391")
  assert.equal(colors.yellow, "#e97b3c")
  assert.equal(colors.red, "#f85525")
})

test("parseThemeColors picks up the singleton roles too", () => {
  const colors = Model.parseThemeColors(THEME)
  assert.equal(colors.accent, "#faa968")
  assert.equal(colors.muted, "#2a6b78")
  assert.equal(colors.foreground, "#f6dcac")
})

test("parseThemeColors does not mistake a bright_/dark_/light_ variant for the key", () => {
  // dark_foreground sits two lines below foreground and would win if the match
  // were not anchored, repainting the caps in the wrong colour.
  assert.equal(Model.parseThemeColors(THEME).foreground, "#f6dcac")
  assert.equal(Model.parseThemeColors('bright_green = "#111111"').green, undefined)
  assert.equal(Model.parseThemeColors('dark_foreground = "#111111"').foreground, undefined)
})

test("parseThemeColors ignores keys it was not asked for", () => {
  const colors = Model.parseThemeColors(THEME)
  assert.equal(colors.background, undefined)
  assert.equal(colors.mode, undefined)
})

test("parseThemeColors accepts unquoted values", () => {
  assert.equal(Model.parseThemeColors("green = #028391").green, "#028391")
})

test("parseThemeColors returns an empty palette rather than throwing", () => {
  for (const raw of ["", null, undefined, "garbage", "green = teal"])
    assert.deepEqual(Model.parseThemeColors(raw), {}, JSON.stringify(raw))
})
