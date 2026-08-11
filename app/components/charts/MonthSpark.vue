<script setup lang="ts">
/*
 * MonthSpark — the hero tile's sparkline, over the WHOLE month, always (F2/D7).
 *
 * THERE IS NO FLOOR, and that is the whole point. `ScopeKpiTile` used to
 * suppress the line below seven days (`SPARK_MIN_DAYS`, itself a knowing fork of
 * the prototype's three) and print "not enough days yet" in its place, so every
 * hero on every page went to italic prose for the first six days of every month.
 * A month's first days are not an error state: five days of spend is five days
 * of measured shape, and the tile beside the blank spark was already printing a
 * month-on-month delta off last month's data. Day 1 is one point and thirty
 * dots (owner, 2026-08-05; prototype `spark()`, D:214-241).
 *
 * THE SHAPE. Elapsed days are a LINE; the days still to come are baseline DOTS
 * out to `span` (the month's length), in a recessive ink. The dots are a track
 * of what has not happened yet — never a projection. Two things follow, and they
 * are the reason this beats a trailing window: the drawn width is constant all
 * month, so nothing shifts under the reader and nothing can ever refuse to draw;
 * and the tiles in a row share one time axis, so they can be compared by eye.
 *
 * THE ENDPOINT IS HOLLOW ONLY WHEN IT REALLY IS TODAY (F1/D5, external review).
 * It used to be hollow UNCONDITIONALLY, which put the "still accruing" mark on a
 * completed day every time the frame was a finished month or a custom range —
 * the partial marker asserting a partial day that does not exist.
 *
 * AND THE FRAME CANNOT ANSWER IT (external review r2). The first fix inferred
 * the mark from the frame when the caller stayed silent — `span > data.length`,
 * "days still to come ⇒ the last day is the in-progress one". That is false for
 * every series that stops at the SETTLED edge inside an unfinished month, which
 * is the normal shape of a §A series each UTC morning: the same false-partial
 * defect, relocated. The frame knows how long the month is; only the caller
 * knows what its own last point IS. So the mark is now a claim NOBODY makes on
 * the caller's behalf — `partial` states it, and a caller that omits it gets NO
 * endpoint marker at all. Silence is the honest rendering of an unknown: the
 * line simply ends where the data ends, asserting neither "still filling" nor
 * "finished".
 *
 * `span` omitted (or ≤ the data length) ⇒ no dots. A quarter or custom range has
 * no "month ahead" to draw, and a complete month has no days left in it.
 *
 * TWO THINGS IT MUST NOT INVENT (carried over from the ECharts sparkline this
 * replaced, whose honesty tests moved here with them):
 *
 * 1. SHAPE BETWEEN THE POINTS. A polyline, never a spline. Curve interpolation
 *    draws shape where no measurement exists — on a daily window the renderer's
 *    swoop between two days is a spend pattern nobody spent.
 *
 * 2. MAGNITUDE, WITHIN ONE TILE. The baseline is ZERO, not the data's own
 *    minimum. Auto-ranging makes a 2% drift fill the tile and read exactly like
 *    a cliff; with a zero floor a day at half the peak draws at half the height,
 *    so the SHAPE inside one spark is proportional to the numbers.
 *
 *    IT DOES NOT MAKE TILES COMPARABLE, and this comment used to imply it did
 *    (external review). Each spark scales its OWN peak to the top, so two tiles
 *    whose lines look identical can be a hundredfold apart — only the time axis
 *    is shared across a row. The KPI value beside each spark is what carries
 *    magnitude between tiles; the drawing never does.
 *
 * Decorative for AT (`aria-hidden`) — the KPI value beside it carries the data.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** One value per ELAPSED day of the frame, in day order. */
    data: number[]
    /**
     * Total days in the frame (the calendar month). Days beyond `data.length`
     * render as baseline dots. Omit for a range that has no month ahead.
     */
    span?: number
    /**
     * Is the LAST value a still-filling day? Drives the endpoint marker, and
     * nothing else: `true` hollow ("still accruing"), `false` solid ("this day
     * is finished"). OMIT IT AND NO MARKER IS DRAWN — the component will not
     * guess, because the frame cannot tell a series that stopped at the settled
     * edge from one that runs to today.
     */
    partial?: boolean
    /** Line hue. Defaults to the magnitude hue. */
    color?: string
    /** Drawn height in CSS px — fixed, so a row of tiles keeps one shape. */
    height?: number
  }>(),
  { span: undefined, partial: undefined, color: undefined, height: 28 },
)

/* The drawing box. 100 × 28 user units, stretched to the tile's width — the
 * prototype's own geometry, so the app and the drawing cannot drift. */
const VB_W = 350
const BASELINE = 26
const TOP = 2

const n = computed(() => props.data.length)
/** Never shorter than the data: a span that contradicts its own series is a bug
 *  in the caller, and silently cropping the measured days would hide it. */
const span = computed(() => Math.max(props.span ?? n.value, n.value, 1))
const den = computed(() => Math.max(span.value - 1, 1))
/*
 * Zero-based scale: the peak sets the top, the floor is always 0.
 *
 * THE PARTIAL DAY IS IN THIS MAX, DELIBERATELY, and it is the one place D4 does
 * not reach (external review, round 2). The partial day is still DRAWN — as the
 * detached endpoint below — so excluding it from the scale would let that mark
 * escape the viewBox on any day that outruns the settled peak. D4 governs the
 * trend LINE, the means and peak LABELS, none of which include it.
 *
 * The cost is real and worth naming: settled `[10, 10]` under a partial of
 * `1000` draws the settled line compressed near the floor. That is a faithful
 * picture of an unusually large day in progress rather than a fabricated dip,
 * but it IS the partial day influencing how the settled days read. Fixing it
 * properly means clamping the partial mark to the top of a settled-only scale
 * and marking it as clipped — a chart change, not a comment change, and not one
 * to make unreviewed. Left as-is, stated rather than implied.
 */
const peak = computed(() => Math.max(...props.data, 0) || 1)

const x = (i: number) => (i / den.value) * VB_W
const y = (v: number) => BASELINE - (v / peak.value) * (BASELINE - TOP)

/*
 * THE LINE STOPS AT THE LAST SETTLED DAY (clock doc D4: the partial day is
 * "excluded from trend lines, means and any peak label").
 *
 * It used to run through the still-filling day, and the hollow endpoint was
 * drawn on top of it — so every KPI spark PLUNGED to the floor each UTC morning
 * while the hero chart on the same page, which excludes it, did not. That is the
 * morning-dip defect surviving in miniature: F1 applied the rule to the hero,
 * F2 built this component in a different slice, and nothing checked the rule had
 * reached both. The endpoint below still marks the partial day — as a DETACHED
 * mark, which is what the hero does and what "still accruing" should look like.
 */
/** Hollow ⇒ "still accruing". Only ever the caller's own statement. */
const lastIsPartial = computed(() => props.partial === true)
const settledCount = computed(() => (lastIsPartial.value ? n.value - 1 : n.value))

const points = computed(() =>
  props.data
    .slice(0, settledCount.value)
    .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' '),
)
/** The days still to come — a track, at the baseline, in a recessive ink. */
const dots = computed(() =>
  Array.from({ length: Math.max(0, span.value - n.value) }, (_, k) => x(n.value + k)),
)
/** Null when there is no data OR when the caller made no claim about the last day. */
const endpoint = computed(() => {
  if (n.value === 0 || props.partial === undefined) return null
  const v = props.data[n.value - 1]!
  return { cx: x(n.value - 1), cy: y(v) }
})
/*
 * THE DASHED CONTINUATION. The still-filling day is deliberately NOT part of the
 * settled polyline (D4) — joining it would let a day that is three hours old
 * read as a measured dip. But leaving it as a bare detached mark made it read as
 * a rendering artefact instead: the marker says "there is a value here" while
 * its isolation says "this is not part of the series", and a viewer resolves
 * that conflict as "something rendered wrong".
 *
 * A DASH resolves it the way every chart resolves it. Dashed = provisional is
 * read without a legend, so the segment belongs to the series while visibly
 * claiming less confidence than the solid line beside it — which is exactly the
 * distinction D4 wants, expressed as weight rather than as absence.
 *
 * Null unless the caller says the last day is partial AND there is a settled day
 * to draw from: one lone point has nothing to continue.
 *
 * DASHED, matching the Spend-trend chart, which has always rendered its
 * projection correctly for one reason: it scales UNIFORMLY.
 *
 * This component set `preserveAspectRatio="none"` against a 100x28 viewBox while
 * rendering ~350x28, stretching x by ~3.5x. That single attribute caused every
 * symptom here — the endpoint circle drawn as an ellipse, and two dash attempts
 * that rendered as a fleck because the pattern was consumed by the transform.
 * The viewBox now matches the render aspect, so no stretch is needed, circles
 * are circles and a dash is a dash.
 *
 * Superseded note, kept because it is the reasoning that found it: A dashed
 * connector is the better convention, but `preserveAspectRatio="none"` makes the
 * dash pattern unpredictable here: measured in screen pixels it spends its whole
 * first dash inside the first few pixels of the segment; measured in user units
 * it is consumed by the horizontal stretch. Both attempts rendered as a fleck at
 * the line's end — worse than no connector, because a fragment reads as damage.
 *
 * A faint solid connector cannot fail to draw, and carries the same meaning: it
 * joins the mark to the series while claiming visibly less than the solid line
 * beside it. If the aspect ratio is ever fixed, a dash becomes available and is
 * the upgrade.
 */
const partialSegment = computed(() => {
  if (!lastIsPartial.value || n.value < 2) return null
  const prev = props.data[n.value - 2]!
  const last = props.data[n.value - 1]!
  return {
    x1: x(n.value - 2), y1: y(prev),
    x2: x(n.value - 1), y2: y(last),
  }
})
const stroke = computed(() => props.color ?? 'var(--brand-vision)')

</script>

<template>
  <svg
    :viewBox="`0 0 ${VB_W} 28`"
    :style="{ height: `${height}px` }"
    class="block w-full"
    aria-hidden="true"
    data-testid="month-spark"
  >
    <circle
      v-for="(cx, i) in dots"
      :key="`d${i}`"
      :cx="cx.toFixed(1)"
      cy="26"
      r="1"
      fill="var(--calm)"
      data-testid="month-spark-dot"
    />
    <!-- A polyline, not a spline: straight segments claim exactly what was
         measured between two days and nothing more. -->
    <polyline
      v-if="n"
      :points="points"
      fill="none"
      :stroke="stroke"
      stroke-width="1.6"
      vector-effect="non-scaling-stroke"
      data-testid="month-spark-line"
    />
    <!-- The unfinished segment: dashed, so it joins the series without claiming
         the solid line's confidence. Drawn BEFORE the endpoint so the mark sits
         on top of it. -->
    <line
      v-if="partialSegment"
      :x1="partialSegment.x1.toFixed(1)"
      :y1="partialSegment.y1.toFixed(1)"
      :x2="partialSegment.x2.toFixed(1)"
      :y2="partialSegment.y2.toFixed(1)"
      :stroke="stroke"
      stroke-width="1.6"
      stroke-dasharray="4 3"
      stroke-opacity="0.85"
      data-testid="month-spark-partial-segment"
    />
    <!-- Hollow ONLY while the last day is still filling; solid once it is a
         finished day, so the partial mark keeps meaning something. -->
    <circle
      v-if="endpoint"
      :cx="endpoint.cx.toFixed(1)"
      :cy="endpoint.cy.toFixed(1)"
      r="1.8"
      :fill="lastIsPartial ? 'var(--paper)' : stroke"
      :stroke="stroke"
      stroke-width="1"
      vector-effect="non-scaling-stroke"
      :data-partial="lastIsPartial ? 'true' : 'false'"
      data-testid="month-spark-endpoint"
    />
  </svg>
</template>
