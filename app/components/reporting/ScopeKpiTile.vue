<script setup lang="ts">
/*
 * ScopeKpiTile — a quiet, legible KPI tile for the Region scope's hero row, at
 * BOTH widths (whole-company and one region).
 *
 * Deliberately calmer than the dashboard UiKpi: carbon value, hairline border,
 * no heavy accent bar. Brand shows up sparingly — only as an optional inline
 * MonthSpark (the daily-spend shape beside the Genuine figure).
 *
 * EVERY TILE CARRIES ITS OWN DELTA (`deltaLabel` + `deltaTrend`), rather than the
 * row carrying one standalone "MoM change" card. That card never said of WHAT, in
 * a row where two tiles sit on different lanes (§A usage / §B bill) — so the basis
 * was ambiguous exactly where it mattered most. A delta ON its figure is
 * unambiguous by construction. When there is no comparable prior operand the tile
 * says so (`deltaEmpty`) instead of printing a delta it could not compute.
 *
 * DATAVIZ: a delta (MoM) is NOT a status — status colours (RAG) are reserved. So
 * `deltaTrend` renders a NEUTRAL ↑/↓ arrow in carbon ink, never a green/red tint.
 * A `#sub-badge` slot carries a small status chip INSIDE the sub line, against
 * the sentence it qualifies (F2/D10 — it used to be a `#badge` beside the label,
 * four lines from the budget statement it was about); a `#footer` slot pins a
 * status chip to the BOTTOM of the card (used for the Copilot-pending
 * marker so the label above renders in full, un-truncated). `note` adds a smaller
 * caption under the delta — the emitting split and the median's percentiles ride
 * it — optionally set off by a rule (`noteSeparated`) when it is a different
 * statistic rather than more of the same one.
 *
 * `emphasis` gives the ACTIVE-lane money tile a quiet brand ring so the current
 * lens's headline figure reads as primary. There is no longer a `usageOnly` grey:
 * the row no longer re-lenses tile-by-tile, so nothing could set it and the
 * "switch to Usage" caption it rendered was unreachable copy.
 */
import { computed } from 'vue'
import MonthSpark from '../charts/MonthSpark.vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string
    sub?: string
    /** A caption BELOW the delta. */
    note?: string
    /** Set `note` off with a hairline rule — it is a different statistic, not a gloss. */
    noteSeparated?: boolean
    /**
     * Inline sparkline data, over the SAME window as `value` (prototype fix 1 —
     * a 60-day line under a this-month figure is two different periods stacked).
     * One value per ELAPSED day. There is no floor: see MonthSpark. Omit for a
     * plain tile — `undefined` is a tile never meant to carry one, and stays
     * silent; an EMPTY array still reserves the slot, so a row of tiles keeps
     * one shape.
     */
    spark?: number[]
    /**
     * Total days in the spark's frame — the calendar month. Days beyond
     * `spark.length` draw as baseline dots out to month end, so the picture's
     * width is constant all month. Omit on a custom range: "the month ahead" is
     * not a concept a range has.
     */
    sparkSpan?: number
    /**
     * Is the LAST spark value a still-filling day? Decides the hollow "still
     * accruing" endpoint.
     *
     * OMIT AND THERE IS NO ENDPOINT AT ALL — this comment used to say MonthSpark
     * "infers it from the frame", and it does not: `endpoint` is null whenever
     * the caller made no claim, deliberately, so silence is never read as an
     * assertion about today. State `true` for a still-filling day, `false` when
     * the series stops at the SETTLED edge inside an unfinished month (which the
     * frame alone cannot see — F1, external review), and omit only when no mark
     * is wanted.
     */
    sparkPartial?: boolean
    /** Sparkline hue (defaults to the magnitude hue inside MonthSpark). */
    sparkColor?: string
    /**
     * The MAGNITUDE of this tile's own delta, formatted with its unit ("31%",
     * "24"). Money takes a percentage; a headcount takes an absolute count,
     * because ↑13% of a headcount is arithmetic the reader has to undo.
     */
    deltaLabel?: string
    /**
     * What the delta is AGAINST ("vs last month"). Carried by the caller, not
     * assumed here: the tile renders the basis, it does not decide it.
     */
    deltaBasis?: string
    /** Direction of `deltaLabel` — a NEUTRAL ↑/↓ arrow in carbon ink. */
    deltaTrend?: 'up' | 'down' | 'flat'
    /** Shown in the delta's place when there is no comparable prior operand. */
    deltaEmpty?: string
    /** Ring the ACTIVE-lane money tile so the current lens's figure reads as primary. */
    emphasis?: boolean
  }>(),
  {
    sub: undefined,
    note: undefined,
    noteSeparated: false,
    spark: undefined,
    sparkSpan: undefined,
    sparkPartial: undefined,
    sparkColor: undefined,
    deltaLabel: undefined,
    deltaBasis: undefined,
    deltaTrend: undefined,
    deltaEmpty: undefined,
    emphasis: false,
  },
)

const arrow = computed(() =>
  props.deltaTrend === 'up' ? '↑' : props.deltaTrend === 'down' ? '↓' : '',
)

/*
 * THE SPARK HAS NO FLOOR (F2/D7, owner 2026-08-05). This tile used to require a
 * full week of days and print "not enough days yet" below it, which fired on
 * every hero on every page for the first six days of every month. The window is
 * now the whole month either way — elapsed days as a line, the rest as baseline
 * dots — so there is nothing a short month-start can fail to draw. See
 * MonthSpark for the reasoning; the honest empty states on the Daily-spend area
 * chart and on session economics are a different question and SURVIVE.
 *
 * `undefined` spark = a tile that was never meant to carry one: silent, and no
 * slot reserved. An empty array is a tile that carries one and has no days yet.
 */
const hasSparkSlot = computed(() => props.spark != null)
</script>

<template>
  <div
    class="bg-white rounded-xl border shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
    :class="emphasis ? 'border-brand-harmony/40 ring-1 ring-brand-harmony/15' : 'border-calm-2/80'"
    data-testid="scope-kpi-tile"
  >
    <div class="flex items-center justify-between gap-2 min-w-0">
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3 truncate">
        {{ label }}
      </span>
    </div>

    <div class="flex items-baseline gap-1 text-carbon">
      <span class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums">
        {{ value }}
      </span>
    </div>

    <!-- The sub line, and the status pill that QUALIFIES it (F2/D10). The pill
         used to sit up beside the tile's label, four lines away from the budget
         sentence it is about; the prototype attaches it to that sentence
         (`sub: '71% of $4,000 ' + pacePill(pc)`, D:669). -->
    <div
      v-if="sub || $slots['sub-badge']"
      class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] leading-snug text-carbon-2"
    >
      <span v-if="sub">{{ sub }}</span>
      <slot name="sub-badge" />
    </div>

    <div
      v-if="deltaLabel"
      class="text-[12px] leading-snug text-carbon-3 tabular-nums"
      data-testid="kpi-delta"
    >
      <!-- Non-breaking spaces, not template whitespace: Vue's `condense` mode
           strips whitespace between elements that spans a newline, which silently
           ran the arrow into the magnitude ("↑2vs last month"). -->
      <span class="font-bold text-carbon-2">
        <span v-if="arrow" aria-hidden="true">{{ arrow }}&nbsp;</span>{{ deltaLabel }}
      </span>
      <span v-if="deltaBasis">&nbsp;{{ deltaBasis }}</span>
    </div>
    <div
      v-else-if="deltaEmpty"
      class="text-[12px] leading-snug text-carbon-3"
      data-testid="kpi-delta-empty"
    >{{ deltaEmpty }}</div>

    <div
      v-if="note"
      class="text-[11px] leading-snug text-carbon-2 tabular-nums"
      :class="noteSeparated ? 'mt-2 pt-2 border-t border-calm-2/70' : ''"
      data-testid="kpi-note"
    >{{ note }}</div>

    <!-- The spark slot reserves its height whether or not there are days in it,
         and it does NOT push to the bottom (no `mt-auto`, F2/D9): a stretched
         grid item with a bottom-pinned spark is exactly the block of dead space
         three of the four tiles were carrying. -->
    <div v-if="hasSparkSlot" class="pt-1 -mb-1 h-[30px]">
      <MonthSpark :data="spark!" :span="sparkSpan" :partial="sparkPartial" :color="sparkColor" :height="28" />
    </div>

    <div v-if="$slots.footer" class="mt-auto pt-2.5">
      <slot name="footer" />
    </div>
  </div>
</template>
