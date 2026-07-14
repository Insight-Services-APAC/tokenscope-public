<script setup lang="ts">
/*
 * ConcentrationCard — how concentrated is spend among teammates.
 *
 * build-design §5: top-1/5/10% cohort shares (fractions of total spend) plus
 * the AEUF cut-point segments. Reuses ChartsRankedBars for the segment bars and
 * `fmtPct` for the shares (both fractions in [0,1]).
 */
import UiCard from '../ui/Card.vue'
import ChartsRankedBars from '../charts/RankedBars.vue'
import { fmtPct } from '../../composables/useFormat'

export interface ConcentrationSegment {
  label: string
  /** Share of total spend held by this segment, fraction in [0,1]. */
  sharePct: number
  /** Optional teammate count in the segment. */
  count?: number
}

export interface ConcentrationStats {
  /** Share of total spend held by the top 1% of teammates, fraction [0,1]. */
  top1: number
  /** Top 5% cohort share. */
  top5: number
  /** Top 10% cohort share. */
  top10: number
  segments: ConcentrationSegment[]
}

const props = defineProps<{ stats: ConcentrationStats }>()

const tiles = () => [
  { label: 'Top 1%', value: props.stats.top1 },
  { label: 'Top 5%', value: props.stats.top5 },
  { label: 'Top 10%', value: props.stats.top10 },
]

const segmentRows = () =>
  props.stats.segments.map((s) => ({
    label: s.count != null ? `${s.label} (${s.count})` : s.label,
    value: s.sharePct,
  }))
</script>

<template>
  <UiCard data-testid="concentration-card">
    <div class="text-sm font-semibold mb-1">Concentration</div>
    <div class="text-[11px] text-carbon-3 mb-3">Share of spend held by the heaviest cohorts</div>

    <div class="grid grid-cols-3 gap-3 mb-4">
      <div v-for="t in tiles()" :key="t.label" class="text-center">
        <div class="text-xl font-bold tabular-nums text-carbon">{{ fmtPct(t.value) }}</div>
        <div class="text-[11px] uppercase tracking-wide text-carbon-3">{{ t.label }}</div>
      </div>
    </div>

    <ChartsRankedBars
      v-if="stats.segments.length"
      :rows="segmentRows()"
      :max="1"
      :format="(v) => fmtPct(v)"
    />
  </UiCard>
</template>
