<script setup lang="ts">
/*
 * TopDriversCard — the whole-company "what is driving spend" card.
 *
 * ── ONE CARD, FIVE PIVOTS, AND THEY ARE CHIPS ────────────────────────────────
 * The pivot control is DriversTable's own (re-used, not duplicated) and it is a
 * row of CHIPS: every axis a reader may ask for is on screen, so switching is one
 * click instead of open-read-choose-close.
 *
 * REGION IS NOT ONE OF THEM (prototype `note('fix 4a', …)`). This page already
 * answers "which region" in its own Regions table, off `fetchAcrossRegionCards`;
 * the pivot answered it a second time off `v_complete_usage`, and the two
 * disagreed — different values AND a different rank order, with nothing on screen
 * telling a reader which was wrong. One fact needs one home, so the pivot's copy
 * went and `ACROSS_DRIVER_AXES` no longer offers the axis at all. PRACTICE stays,
 * because it has no card of its own.
 *
 * There is also no ranked chart above the table any more: the table's own
 * `share of spend` column IS the ranking read, and rendering it twice is the same
 * divergence one card smaller.
 *
 * ── THE LEDE STATES THE LANE, AND THE PROMISE THAT GOES WITH IT ──────────────
 * "Every pivot sums to that lane's total" is a claim, so it is only made where it
 * holds. The BUDGET pivot answers `attributed` even under the chargeback toggle
 * (`provider_usage_fact` has no project column — engine/budget-axis.ts), and on
 * that pivot the lede names the exception instead of the promise. WHICH lane the
 * rows are on is read from `measureLanes.rows` — the response's own statement —
 * never from the requested `?lane=`, because those two legitimately differ.
 *
 * AND IT NAMES WHOSE CHARGE IT IS. "company billed spend" is a false claim on any
 * axis the Copilot invoice cannot reach (the teammate and model axes today —
 * Copilot bills ONE pooled invoice per cost centre). WHICH axes those are is NOT
 * decided here and must not be listed here: the qualifier comes from the
 * response's `chargebackCoverage`, the same source as the gap sentences the table
 * renders, so the label and the explanation can never disagree — and neither can
 * outlive a change in what the bill can answer.
 *
 * ── THE PERIOD IS THE PAGE'S, AND THE VALUE COLUMN SAYS SO ───────────────────
 * These rows are NOT month-anchored: the endpoint windows the page's active
 * `[from, to]` range usage-lane-cleanly, and the CSV export windows the same one.
 * So the value column's word is passed in from the container that owns the window
 * rather than hardcoded here — "This month" over a custom range would be a false
 * claim, and this card used to carry exactly that claim in a comment.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import DriversTable, { type AxisOption } from '../DriversTable.vue'
import {
  projectDrillTarget,
  dimFact, teammateDrillTarget,
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
  type DrillTarget,
} from '../drill-contract'
import { BUDGET_LABEL } from '#shared/reports/vocabulary'
import { chargebackScopeClause } from '#shared/reports/types'
import type { ReportLane } from '../../../composables/useReportState'
import type { DriverRow } from '#shared/reports/types'
import type { AcrossDriversResp } from './across-view-types'

const props = withDefaults(
  defineProps<{
    drivers: AcrossDriversResp | null
    axis: string
    /** The page's active lens — used ONLY to spot a pivot answering off-lane. */
    lane?: ReportLane
    /** The word over the value column — the container owns the window, so it owns this. */
    periodLabel?: string
    /** THE DRILL CONTRACT (D29/D30) — from the container; fail-closed defaults. */
    drillGrants?: DrillGrants
    drillWindow?: Omit<DrillFrame, 'src'>
  }>(),
  {
    lane: 'usage',
    periodLabel: 'Spend',
    drillGrants: () => NO_DRILL_GRANTS,
    drillWindow: () => ({}),
  },
)

const emit = defineEmits<{
  'update:axis': [axis: string]
}>()

/*
 * THE DRILL CONTRACT (D29, fix 7). This card is the whole-company width, so its
 * frame token is `across` — the grant that admits this width IS the grant a
 * drill opened from it must be framed by. There is no practice axis here (fix
 * 4a retired the region axis and the practice pivot lives on the regional
 * width), so every row is a link or plain text; nothing is an in-page action.
 */
const drillGrants = computed(() => props.drillGrants)
const drillFrame = computed<DrillFrame>(() => ({ ...props.drillWindow, src: 'across' }))
function driversDrillable(row: DriverRow): DrillTarget | null {
  if (props.axis === 'teammate') {
    if (row.key.startsWith('__null')) return null
    return teammateDrillTarget(
      drillGrants.value,
      {
        id: row.key,
        isActive: dimFact(row.dims, 'teammate_active'),
        // Server-carried (r4-H2): an unconfirmed shadow identity 403s at the
        // destination, so its row is a NAME, never a door.
        isProvisional: dimFact(row.dims, 'teammate_provisional'),
      },
      drillFrame.value,
    )
  }
  if (props.axis === 'project') {
    return projectDrillTarget(drillGrants.value, row.dims?.project_code ?? null, drillFrame.value)
  }
  return null
}

// Project leads — the budgeted unit of account (decisions D1). The KEY stays
// `'project'` (the wire, the export column and every saved `?axis=` URL); only
// the WORD is the product's own — see shared/reports/vocabulary.ts.
//
// ORDER is the prototype's: the unit of account, then the two org cuts, then the
// technical one. Membership must be a subset of `ACROSS_DRIVER_AXES` — an
// option the endpoint does not accept would silently answer as `project`.
//
// MODEL IS NOT ONE OF THEM (07-model-axis-subtraction-build.md D6, owner
// 2026-08-04) — the same move that removed the region axis (header above): the
// Top models card beside this one is the single model surface and shows
// strictly more (provenance, coverage footer, notes). The ENDPOINT deliberately
// keeps accepting `axis=model` — that is the dedicated card's own fetch
// (`ScopeAcrossRegions.vue`), not a pivot here. Axis state is component-local
// and never persisted, so no saved-state normalisation is needed.
const AXIS_OPTIONS: AxisOption[] = [
  { value: 'project', label: BUDGET_LABEL },
  { value: 'practice', label: 'Practice' },
  { value: 'teammate', label: 'Teammate' },
  { value: 'surface', label: 'Surface' },
]

/** The lane the ROWS were computed on, per the response — never `?lane=`. */
const rowsLane = computed(() => props.drivers?.measureLanes?.rows ?? 'attributed')
const isBilled = computed(() => rowsLane.value === 'billed')
/**
 * This pivot answers a different lane from the one the page is toggled to — the
 * budget axis under chargeback, and nothing else today. The REASON is the
 * server's own sentence (`chargebackCoverage.gaps`, rendered by the table); this
 * flag only decides whether the lede may promise a sum-back to the page lane.
 */
const laneDiverges = computed(() => props.lane === 'chargeback' && !isBilled.value)

/** `'Anthropic only'` when the chargeback figure is one provider's, else null. */
const scopeClause = computed(() => chargebackScopeClause(props.drivers?.chargebackCoverage))
const denominatorLabel = computed(() =>
  isBilled.value
    ? `company billed spend${scopeClause.value ? ` — ${scopeClause.value}` : ''}`
    : 'company usage',
)
const laneWord = computed(() => (isBilled.value ? 'billed' : 'attributed'))
const headerNote = computed(
  () =>
    `What is driving whole-company spend on the ${laneWord.value} lane${
      isBilled.value && scopeClause.value ? ` · ${scopeClause.value}` : ''
    }.`,
)
const sumBackNote = computed(() =>
  laneDiverges.value
    ? `This pivot answers on the ${laneWord.value} lane and sums to its own total, not to the billed headline.`
    : "Every pivot sums to that lane's total.",
)

/*
 * NO `drill` EMIT ANY MORE. Region was the only axis on this card that carried a
 * scope to drill into, and it has its own card now; the other five never had one.
 * A card-level emit nobody can fire is worse than its absence — the View would
 * still wire a `select-region` handler to it and a reader would learn nothing
 * about why no row ever navigates.
 */
</script>

<template>
  <UiCard data-testid="across-drivers-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Top drivers</div>
      <div class="text-[11px] text-carbon-3" data-testid="across-drivers-lane">{{ headerNote }}</div>
    </div>
    <p class="text-[11px] text-carbon-3 mb-3" data-testid="across-drivers-sumback-note">
      {{ sumBackNote }}
    </p>

    <DriversTable
      v-if="drivers"
      :rows="drivers.rows"
      :headline-usd="drivers.headlineUsd"
      :axis="axis"
      :axis-options="AXIS_OPTIONS"
      :denominator-label="denominatorLabel"
      :value-column-label="periodLabel"
      :billed-lane="drivers.billedLane"
      :chargeback-coverage="drivers.chargebackCoverage"
      :drillable="driversDrillable"
      @update:axis="emit('update:axis', $event)"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">Loading drivers…</p>
  </UiCard>
</template>
