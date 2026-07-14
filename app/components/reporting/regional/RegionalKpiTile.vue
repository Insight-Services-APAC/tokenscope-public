<script setup lang="ts">
/*
 * RegionalKpiTile — a quiet, legible KPI tile for the Regional hero row.
 *
 * Hairline card, carbon value, NO coloured top-border (the locked design
 * language). Brand shows up sparingly — only as an optional inline
 * ChartSparkline (the daily-spend shape beside the Genuine figure). Deltas
 * (MoM) render as a NEUTRAL carbon value with a small ↑/↓ arrow — status
 * colours (RAG green/red) are reserved and never used for a spend delta. A
 * `#badge` slot carries a small status chip inline with the label; a `#footer`
 * slot pins a status chip to the BOTTOM of the card (used for the Copilot chips
 * so the "Chargeable" label above renders in full). `note` adds a smaller muted
 * caption under `sub`.
 *
 * LANE RE-LENS: `usageOnly` greys a §A-only tile (tokens / active users / avg usage)
 * in chargeback mode (reduced opacity + "switch to Usage" caption; never hidden, for
 * layout stability); `emphasis` rings the ACTIVE-lane money tile. Mirrors AcrossKpiTile.
 *
 * No hardcoded root `data-testid`: a `data-testid` passed by the caller falls
 * through to the root so each tile can be addressed individually.
 */
import ChartSparkline from '../charts/ChartSparkline.client.vue'

withDefaults(
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
    /** Neutral delta arrow (MoM): up → ↑, down → ↓. Never tints the value. */
    arrow?: 'up' | 'down'
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
    arrow: undefined,
    usageOnly: false,
    emphasis: false,
  },
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
  >
    <div class="flex items-center justify-between gap-2 min-w-0">
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3 truncate">
        {{ label }}
      </span>
      <slot name="badge" />
    </div>

    <div class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums text-carbon flex items-baseline gap-1.5">
      <span
        v-if="arrow"
        class="text-[15px] text-carbon-3 leading-none"
        aria-hidden="true"
      >{{ arrow === 'up' ? '↑' : '↓' }}</span>
      <span>{{ value }}</span>
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
