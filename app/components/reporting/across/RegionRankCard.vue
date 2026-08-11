<script setup lang="ts">
/*
 * RegionRankCard — the Regions TABLE, and the only place this page answers
 * "which region".
 *
 * ── WHY A TABLE AND NOT A BAR CHART (prototype `note('fix 4a', …)`) ──────────
 * Region used to be answered TWICE: here as a ranked bar, and again as a pivot of
 * the Top-drivers card. The two disagreed — different values AND a different rank
 * order — and a reader had no way to tell which was wrong. The pivot is gone
 * (`ACROSS_DRIVER_AXES`), so this card is now the single home for the fact, and it
 * carries what a bar chart could not: HOW MANY PEOPLE are behind each figure and
 * what SHARE of the total it is. A region leading on spend with a fifth of the
 * headcount is a different conversation from one leading with twice the headcount,
 * and only the first two columns together can start it.
 *
 * ── THE CARD STILL RE-LENSES, BECAUSE THE TWO LANES ARE DIFFERENT MONEY ──────
 *   - USAGE (§A): ranked by `genuineUsd` (attributed usage) off the region cards,
 *     which also carry the active-developer count.
 *   - CHARGEBACK (§B): ranked off `chargebackRows` — a SEPARATE bill-lane fetch
 *     (fetchAcrossChargebackByRegion over `v_finance_chargeback_month`), NOT the
 *     region cards' §A-derived figure. It sums to the chargeable headline
 *     (charge-only regions with no in-window usage are included, which ranking off
 *     the usage cards would drop). The two lanes NEVER share an operand.
 *
 * WHICH IS WHY PEOPLE IS A §A-ONLY COLUMN. An active-developer count is a usage
 * fact; there is no such thing on `v_finance_chargeback_month`, and borrowing the
 * §A count to sit beside a §B charge would put two concerns in one row — exactly
 * the conflation `docs/design/provider-billing-attribution-model.md` separates.
 * The column is ABSENT in the chargeback lane rather than blank or borrowed.
 *
 * Rows carry the `region_id`; activating one emits `select` so the container can
 * navigate to that region's scope. The explicit "Unassigned" bucket
 * (region_id = null) is shown for sum-back honesty but carries no drill target —
 * it is rendered as plain text, not a dead button.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
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

interface Row {
  regionId: string | null
  label: string
  usd: number
  /** §A only — `null` in the chargeback lane, where no such count exists. */
  people: number | null
}

// Rank by the ACTIVE lane's OWN source, re-sorted DESC so the leader is honest per lens:
// usage ranks the usage region cards; chargeback ranks the bill-lane chargeback rows (so
// the §A and §B rankings never share an operand AND the §B ranking sums to the chargeable).
const rows = computed<Row[]>(() =>
  isChargeback.value
    ? [...props.chargebackRows]
        .map((r) => ({ regionId: r.regionId, label: r.label, usd: r.chargeableUsd, people: null }))
        .sort((a, b) => b.usd - a.usd)
    : [...props.cards]
        .map((c) => ({
          regionId: c.regionId,
          label: c.displayName,
          usd: c.genuineUsd,
          people: c.activeUsers,
        }))
        .sort((a, b) => b.usd - a.usd),
)

/*
 * SHARE IS COMPUTED FROM THE ROWS ON SCREEN, in the lane those rows came from.
 * `AcrossRegionCard.sharePct` is the §A card's own share and would be the wrong
 * denominator the moment the chargeback lens swapped the operand underneath it —
 * one of the two figures fix 4a found disagreeing. One source per lane, one
 * denominator, derived here so it cannot drift from the column beside it.
 */
const total = computed(() => rows.value.reduce((a, r) => a + r.usd, 0))
function share(r: Row): number {
  return total.value > 0 ? r.usd / total.value : 0
}

const valueHeading = computed(() => (isChargeback.value ? 'Chargeback' : 'Attributed usage'))
</script>

<template>
  <UiCard data-testid="across-region-rank">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Regions</div>
      <div class="text-[11px] text-carbon-3" data-testid="across-region-rank-lane">
        {{ isChargeback ? 'Chargeback by region · sums to chargeable' : 'Attributed usage by region · sums to attributed usage' }}
      </div>
    </div>
    <div class="text-[11px] text-carbon-3 mb-3">Select a region to drill into its regional report.</div>

    <table class="w-full text-sm">
      <thead>
        <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
          <th class="text-left font-semibold py-2">Region</th>
          <th v-if="!isChargeback" class="text-right font-semibold py-2 w-[90px]">People</th>
          <th class="text-right font-semibold py-2" data-testid="across-region-value-col">
            {{ valueHeading }}
          </th>
          <th class="text-right font-semibold py-2 w-[80px]">Share</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.regionId ?? '__unassigned'"
          class="border-b border-calm-1 last:border-0 hover:bg-calm-1/40"
          :data-testid="`across-region-row-${r.regionId ?? 'unassigned'}`"
        >
          <td class="py-2.5">
            <button
              v-if="r.regionId"
              type="button"
              class="font-medium text-left text-carbon-1 hover:text-brand-harmony hover:underline"
              data-testid="across-region-drill"
              @click="emit('select', r.regionId)"
            >{{ r.label }}</button>
            <span v-else class="font-medium text-carbon-2">{{ r.label }}</span>
            <UiBadge v-if="!r.regionId" kind="rag-amber" class="ml-2 align-middle">No region</UiBadge>
          </td>
          <td v-if="!isChargeback" class="py-2.5 text-right tabular-nums text-carbon-2">
            {{ r.people }}
          </td>
          <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(r.usd) }}</td>
          <td class="py-2.5 text-right tabular-nums text-carbon-2">{{ fmtPct(share(r)) }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td
            :colspan="isChargeback ? 3 : 4"
            class="py-8 text-center text-carbon-3 text-sm"
            data-testid="across-region-empty"
          >No region carries spend in this period.</td>
        </tr>
      </tbody>
    </table>
  </UiCard>
</template>
