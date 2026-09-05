// Pure model layer for the cliamp spectrum widget. Everything here is plain
// JS so it can be exercised under `node --test`; nothing in this file touches
// QML types. See test/model.test.js.

// --- stream ------------------------------------------------------------------

// `cliamp visstream` accepts 1-60 and rejects anything outside it, which would
// leave the widget with a process that exits on every restart. Clamp here so a
// typo in shell.json degrades to a working frame rate instead of a blank bar.
function streamFps(value) {
  // Blank has to be rejected before Number sees it: Number("") is 0, which
  // would clamp to 1fps and leave the analyzer twitching once a second rather
  // than falling back to the default.
  var text = String(value === undefined || value === null ? "" : value).trim()
  var fps = text === "" ? NaN : Math.round(Number(text))
  if (!isFinite(fps)) return 30
  return Math.max(1, Math.min(60, fps))
}

function streamCommand(fps) {
  return ["cliamp", "visstream", "--fps", String(streamFps(fps))]
}

// One NDJSON frame: {"ok":true,"visualizer":"Bars","bands":[... 64 floats 0..1]}
//
// `visualizer` names the mode cliamp's own TUI is drawing and has no bearing on
// the numbers — the bands are the raw spectrum, so this widget renders Bars
// whatever cliamp itself is set to. Carried through for callers that want to
// report the mode; the rendering never consults it.
//
// A frame that reports ok:false carries no usable spectrum, so it is dropped
// like a malformed line: the widget then goes stale on its own and fades out,
// which is the same thing it should do when the stream dies outright.
function parseFrame(line) {
  var text = String(line === undefined || line === null ? "" : line).trim()
  if (text === "") return null

  var frame
  try {
    frame = JSON.parse(text)
  } catch (e) {
    return null
  }

  if (!frame || frame.ok === false || !Array.isArray(frame.bands) || frame.bands.length === 0) return null
  return { visualizer: String(frame.visualizer || ""), bands: frame.bands }
}

// --- band folding ------------------------------------------------------------

// How many columns to draw for a frame.
//
// The band count is a property of cliamp's current visualizer mode rather than
// a constant: Bars and Columns stream 10 bands, ClassicPeak streams 64. So the
// column count follows the frame instead of being chosen here. Folding 10 bands
// up into more columns than that cannot add detail — it just repeats each
// reading across two or three neighbours, which reads as stair-steps.
//
// `maximum` caps the 64-band modes so they do not thin the analyzer into
// hairlines; 0 means "draw whatever cliamp sends".
function columnCount(bandCount, maximum) {
  var bands = Math.max(0, Math.floor(Number(bandCount) || 0))
  var cap = Math.max(0, Math.floor(Number(maximum) || 0))
  return cap === 0 ? bands : Math.min(bands, cap)
}

// Fold the frame's bands into `count` columns by taking the maximum of each
// group rather than the mean: a mean flattens the single loud band in a group
// against its quiet neighbours, which costs the analyzer exactly the transient
// snap that makes it look alive. Winamp took the peak here too.
//
// Groups are cut linearly over the source bands, which leaves the low end
// crowded and the top end sparse — that is what produces the familiar tall-left,
// short-right silhouette rather than a flat wall. With one column per band, as
// the Bars mode gives, this passes the readings straight through.
function foldBands(bands, count) {
  var source = Array.isArray(bands) ? bands : []
  var n = Math.max(1, Math.floor(Number(count) || 0) || 1)
  var out = new Array(n)

  for (var i = 0; i < n; i++) {
    var start = Math.floor(i * source.length / n)
    var end = Math.floor((i + 1) * source.length / n)
    if (end <= start) end = start + 1

    var peak = 0
    for (var j = start; j < end && j < source.length; j++) {
      var value = Number(source[j])
      if (isFinite(value) && value > peak) peak = value
    }
    out[i] = Math.max(0, Math.min(1, peak))
  }
  return out
}

// --- animation ---------------------------------------------------------------

// Instant attack, gradual release. A bar jumps to a louder reading on the frame
// it arrives and only falls at `fall` per tick, so percussion reads as a hit
// rather than a slope. Symmetric smoothing would round the attacks off and turn
// the analyzer into a slow wobble.
function applyDecay(previous, targets, fall) {
  var prev = Array.isArray(previous) ? previous : []
  var next = Array.isArray(targets) ? targets : []
  var drop = Math.max(0, Number(fall) || 0)
  var out = new Array(next.length)

  for (var i = 0; i < next.length; i++) {
    var target = clampUnit(next[i])
    var held = i < prev.length ? clampUnit(prev[i]) : 0
    out[i] = target >= held ? target : Math.max(target, held - drop)
  }
  return out
}

// Winamp's peak caps did not fall at a constant rate, they accelerated: the
// marker hangs at the peak for a beat, then drops away faster and faster. That
// pause is what makes a cap read as a marker of the loudest recent moment
// rather than as a second bar. Modelled as free fall — velocity resets to zero
// on every new peak, so the hang comes out of the physics instead of a separate
// hold timer.
//
// State is an array of {value, velocity}; callers render `value` only.
function applyPeaks(previous, levels, gravity) {
  var prev = Array.isArray(previous) ? previous : []
  var next = Array.isArray(levels) ? levels : []
  var pull = Math.max(0, Number(gravity) || 0)
  var out = new Array(next.length)

  for (var i = 0; i < next.length; i++) {
    var level = clampUnit(next[i])
    var cap = i < prev.length && prev[i] ? clampUnit(prev[i].value) : 0
    var velocity = i < prev.length && prev[i] ? Math.max(0, Number(prev[i].velocity) || 0) : 0

    if (level >= cap) {
      out[i] = { value: level, velocity: 0 }
      continue
    }

    velocity += pull
    out[i] = { value: Math.max(level, cap - velocity), velocity: velocity }
  }
  return out
}

function peakValues(peaks) {
  var source = Array.isArray(peaks) ? peaks : []
  var out = new Array(source.length)
  for (var i = 0; i < source.length; i++) out[i] = source[i] ? clampUnit(source[i].value) : 0
  return out
}

// Idleness on this stream is not silence and not a dead stream. cliamp keeps
// serving visstream while paused, and what it serves is the last frame it
// analysed, repeated verbatim — not zeros. So a paused player looks exactly
// like a loud one to any test that only reads the current frame, and the
// analyzer would sit frozen mid-spectrum rather than standing down.
//
// What actually distinguishes playing from paused is whether the spectrum is
// still moving, so compare each frame against the one before it. Duplicates do
// occur during playback whenever the requested frame rate outruns cliamp's
// analysis rate, which is why the caller times how long the spectrum has been
// unchanged instead of standing down on a single repeat.
function sameBands(previous, next) {
  var before = Array.isArray(previous) ? previous : null
  var after = Array.isArray(next) ? next : null
  if (!before || !after || before.length !== after.length) return false

  for (var i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) return false
  }
  return true
}

// Whether anything is left to draw, used to decide when the widget can stop
// animating altogether.
function isSilent(levels, threshold) {
  var source = Array.isArray(levels) ? levels : []
  var floor = Math.max(0, Number(threshold) || 0)
  for (var i = 0; i < source.length; i++) {
    if (clampUnit(source[i]) > floor) return false
  }
  return true
}

// Whether the caps have finished falling.
//
// The columns reach zero first: a cap is still on its way down for a beat after
// the column under it has gone. So an animation that stops as soon as the
// columns are drained freezes the caps mid-air, leaving a row of marks hanging
// over an empty analyzer. Both have to be settled before there is nothing left
// to draw.
function peaksSettled(peaks) {
  var source = Array.isArray(peaks) ? peaks : []
  for (var i = 0; i < source.length; i++) {
    if (source[i] && clampUnit(source[i].value) > 0) return false
  }
  return true
}

function zeros(count) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  var out = new Array(n)
  for (var i = 0; i < n; i++) out[i] = 0
  return out
}

function clampUnit(value) {
  var n = Number(value)
  if (!isFinite(n) || n < 0) return 0
  return n > 1 ? 1 : n
}

// --- geometry and colour -----------------------------------------------------

// The gap the columns can actually afford.
//
// At a high band count the requested gap can leave less than a pixel per
// column, and since a column may never be thinner than a pixel, something has
// to give. The gap gives: a widget that grew past its configured span would
// shove every neighbour along the bar section, which is worse than columns
// sitting shoulder to shoulder. 64 bands in a 120px span come out gapless.
function effectiveGap(span, count, gap) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  if (n <= 1) return 0

  var requested = Math.max(0, Math.floor(Number(gap) || 0))
  var affordable = Math.floor((Math.max(0, Math.floor(Number(span) || 0)) - n) / (n - 1))
  return Math.max(0, Math.min(requested, affordable))
}

// Integer column widths filling a configured span.
//
// The span is what the user sets, and the columns divide it, rather than the
// user setting a column width and the total falling out of the band count.
// That keeps the analyzer one width on the bar while cliamp's band count varies
// with its visualizer mode — the columns get fatter or thinner instead of the
// widget growing and shrinking under its neighbours.
//
// The remainder is handed out a pixel at a time so the columns sum to the span
// exactly and each lands on a whole pixel; fractional widths shimmer as the
// rounding lands differently from frame to frame.
function columnWidths(span, count, gap) {
  var n = Math.max(0, Math.floor(Number(count) || 0))
  if (n === 0) return []

  var g = Math.max(0, Math.floor(Number(gap) || 0))
  // Never below one pixel per column, even if the gaps alone would exceed the
  // span at a high band count.
  var usable = Math.max(n, Math.floor(Number(span) || 0) - g * (n - 1))
  var base = Math.floor(usable / n)
  var extra = usable - base * n

  var out = new Array(n)
  for (var i = 0; i < n; i++) out[i] = base + (i < extra ? 1 : 0)
  return out
}

// What those columns actually occupy, gaps included. The trailing gap is
// dropped: a gap after the last column is padding, and the bar section already
// spaces widgets itself.
function spectrumWidth(widths, gap) {
  var list = Array.isArray(widths) ? widths : []
  if (list.length === 0) return 0

  var g = Math.max(0, Math.floor(Number(gap) || 0))
  var sum = 0
  for (var i = 0; i < list.length; i++) sum += Math.max(0, Math.floor(Number(list[i]) || 0))
  return sum + g * (list.length - 1)
}

// Qt stringifies an opaque colour as #rrggbb but one with alpha as #aarrggbb,
// and a theme may write either. Normalise to #rrggbb, dropping Qt's leading
// alpha, so a configured colour never reads its alpha channel as red.
function normalizeHex(value) {
  var h = String(value === undefined || value === null ? "" : value).replace("#", "")
  if (h.length === 8) h = h.slice(2)
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2)
  return h.length === 6 && /^[0-9A-Fa-f]{6}$/.test(h) ? "#" + h : ""
}

// shell.json carries "" for "leave it alone" — the same convention net-stats
// uses — so an unset or malformed colour falls back rather than painting the
// widget an invalid colour QML would resolve to black.
function colorOrFallback(value, fallback) {
  var hex = normalizeHex(value)
  return hex === "" ? fallback : hex
}

// --- settings write-back -----------------------------------------------------

// The shell's updateEntryInline rebuilds a widget's shell.json entry out of
// what it is handed — `{id}` plus the keys passed — so it replaces the entry
// rather than merging into it. Anything the user configured and the caller
// forgets to resend is silently dropped, so a toggle has to hand back the whole
// entry with the one key changed.
function withSetting(settings, key, value) {
  var source = settings && typeof settings === "object" ? settings : {}
  var out = {}

  for (var k in source) {
    // `id` is supplied by the shell and ignored on the way in; carrying our own
    // copy back would only risk disagreeing with it.
    if (k !== "id" && Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k]
  }
  out[String(key)] = value
  return out
}

// The gradient wants the theme's own low-to-high ramp, and the Color singleton
// does not carry one: it exposes foreground, background, accent, urgent and
// muted, but not green/yellow/red. Those come from the theme's colors.toml,
// the same way cpu-stats reads the keys it needs.
//
// Anchored to the start of the line so the bright_/dark_/light_ variants that
// sit alongside each key in the same file are not mistaken for it.
function parseThemeColors(raw) {
  var out = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*(foreground|accent|muted|green|yellow|red)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) out[match[1]] = match[2]
  }
  return out
}
