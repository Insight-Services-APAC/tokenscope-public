<script setup lang="ts">
/*
 * RegionRankCard — region ranking, RE-LENSED by the active lane.
 *   - USAGE (§A): "Usage by region", ranked by `genuineUsd` (attributed usage) off
 *     the region cards.
 *   - CHARGEBACK (§B): "Chargeback by region", ranked off `chargebackRows` — a
 *     SEPARATE bill-lane fetch (fetchAcrossChargebackByRegion over
 *     v_finance_chargeback_month), NOT the region cards' §A-derived figure. It sums
 *     to the chargeable headline (charge-only regions with no in-window usage are
 *     included, which ranking off the usage cards would drop). The two lanes NEVER
 *     share an operand.
 *
 * Rankings are MAGNITUDE, so the ranked bars wear a single hue with the $ labelled
 * at the bar end (the chart kit replaces the old hand-SVG RankedBars + its
 * black-bar bug). Rows carry the `region_id` as `meta`; a click emits `select`
 * with that id so the container can navigate to the Regional scope. The explicit
 * "Unassigned" bucket (region_id = null) is shown for sum-back honesty but carries
 * no drill target — the container ignores a null selection.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { ReportLane } from '../../../composables/useReportState'
import type { AcrossRegionCard, AcrossChargebackRegion } from './across-view-types'

const props = defineProps<{
  cards: AcrossRegionCard[]
  /**
   * §B chargeback-by-region rows (sourced off `v_finance_chargeback_month`). The
   * chargeback-lane ranking source — a region with charge but no in-window usage still
   * appears here (the usage cards would silently drop it), and it sums to the chargeable.
   */
  chargebackRows: AcrossChargebackRegion[]
  /** The active lens — flips the ranked field + title between §A and §B. */
  lane: ReportLane
}>()

const emit = defineEmits<{ select: [regionId: string | null] }>()

const isChargeback = computed(() => props.lane === 'chargeback')

// Rank by the ACTIVE lane's OWN source, re-sorted DESC so the leader is honest per lens:
// usage ranks the usage region cards; chargeback ranks the bill-lane chargeback rows (so
// the §A and §B rankings never share an operand AND the §B ranking sums to the chargeable).
const rows = computed(() =>
  isChargeback.value
    ? [...props.chargebackRows]
        .map((r) => ({ label: r.label, value: r.chargeableUsd, meta: r.regionId }))
        .sort((a, b) => b.value - a.value)
    : [...props.cards]
        .map((c) => ({ label: c.displayName, value: c.genuineUsd, meta: c.regionId }))
        .sort((a, b) => b.value - a.value),
)

function onSelect(row: { label: string; value: number; meta?: unknown }) {
  emit('select', (row.meta as string | null) ?? null)
}
</script>

<template>
  <UiCard data-testid="across-region-rank">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">
        {{ isChargeback ? 'Chargeback by region' : 'Usage by region' }}
      </div>
      <div class="text-[11px] text-carbon-3">
        {{ isChargeback ? 'Ranked by chargeback · sums to chargeable' : 'Ranked by usage · sums to attributed usage' }}
      </div>
    </div>
    <div class="text-[11px] text-carbon-3 mb-3">Select a region to drill into its regional report.</div>

    <ChartRankedBar
      :rows="rows"
      :value-format="(v) => fmtUsd(v)"
      clickable
      @select="onSelect"
    />
  </UiCard>
</template>
