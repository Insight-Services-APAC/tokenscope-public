<script setup lang="ts">
/*
 * AcrossKpiTile — a quiet, legible KPI tile for the Across-Regions hero row.
 *
 * Deliberately calmer than the dashboard UiKpi: carbon value, hairline border,
 * no heavy accent bar. Brand shows up sparingly — only as an optional inline
 * ChartSparkline (the daily-spend shape beside the Genuine figure).
 *
 * DATAVIZ: a delta (MoM) is NOT a status — status colours (RAG) are reserved. So
 * `trend` renders a NEUTRAL ↑/↓ arrow in carbon ink beside the value, never a
 * green/red tint. A `#badge` slot carries a small status chip inline with the
 * label; a `#footer` slot pins a status chip to the BOTTOM of the card (used for
 * the Copilot-pending marker so the label above renders in full, un-truncated).
 * `note` adds a smaller muted caption under `sub` (e.g. the honest "not an
 * invoice" line under the attributed-usage tile).
 *
 * LANE RE-LENS: `usageOnly` renders the tile GREYED (reduced opacity + a "switch to
 * Usage" caption) in chargeback mode for a metric that is inherently §A (tokens /
 * active users / avg usage) — kept visible (never hidden) for layout stability, a
 * consistent deliberate treatment. `emphasis` gives the ACTIVE-lane money tile a
 * quiet brand ring so the current lens's headline figure reads as primary.
 */
import { computed } from 'vue'
import ChartSparkline from '../charts/ChartSparkline.client.vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string
    sub?: string
    /** A smaller muted caption under `sub` (optional; other tiles are unaffected). */
    note?: string
    /** Inline sparkline data (≥2 points). Omit for a plain tile. */
    spark?: number[]
    /** Sparkline hue (defaults to the magnitude hue inside ChartSparkline). */
    sparkColor?: string
    /**
     * Direction of a delta figure — renders a NEUTRAL ↑/↓ arrow (carbon ink), the
     * dataviz-correct treatment for a magnitude change (a spend delta is not a
     * RAG status). `flat` / omitted → no arrow.
     */
    trend?: 'up' | 'down' | 'flat'
    /** Grey this §A-only tile in chargeback mode (muted + "switch to Usage" caption). */
    usageOnly?: boolean
    /** Ring the ACTIVE-lane money tile so the current lens's figure reads as primary. */
    emphasis?: boolean
  }>(),
  {
    sub: undefined,
    note: undefined,
    spark: undefined,
    sparkColor: undefined,
    trend: undefined,
    usageOnly: false,
    emphasis: false,
  },
)

const arrow = computed(() =>
  props.trend === 'up' ? '↑' : props.trend === 'down' ? '↓' : '',
)
</script>

<template>
  <div
    class="bg-white rounded-xl border shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0 transition-opacity"
    :class="[
      emphasis ? 'border-brand-harmony/40 ring-1 ring-brand-harmony/15' : 'border-calm-2/80',
      usageOnly ? 'opacity-45' : '',
    ]"
    :data-usage-only="usageOnly ? 'true' : undefined"
    data-testid="across-kpi-tile"
  >
    <div class="flex items-center justify-between gap-2 min-w-0">
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3 truncate">
        {{ label }}
      </span>
      <slot name="badge" />
    </div>

    <div class="flex items-baseline gap-1 text-carbon">
      <span
        v-if="arrow"
        class="text-[18px] leading-none font-semibold text-carbon-2 tabular-nums"
        aria-hidden="true"
      >{{ arrow }}</span>
      <span class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums">
        {{ value }}
      </span>
    </div>

    <div v-if="sub" class="text-[12px] leading-snug text-carbon-2">{{ sub }}</div>
    <div v-if="note" class="text-[11px] leading-snug text-carbon-3">{{ note }}</div>
    <div v-if="usageOnly" class="text-[11px] leading-snug text-carbon-3 italic" data-testid="kpi-usage-only-note">
      usage metric — switch to Usage
    </div>

    <div v-if="spark && spark.length > 1" class="mt-auto pt-1 -mb-1">
      <ChartSparkline :data="spark" :color="sparkColor" :height="30" />
    </div>

    <div v-if="$slots.footer" class="mt-auto pt-2.5">
      <slot name="footer" />
    </div>
  </div>
</template>
