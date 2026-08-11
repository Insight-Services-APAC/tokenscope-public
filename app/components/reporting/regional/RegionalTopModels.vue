<script setup lang="ts">
/*
 * RegionalTopModels — the region's top models by spend (ChartRankedBar).
 *
 * A magnitude read of `/reports/region/drivers?axis=model`: a SINGLE-hue ranked
 * bar (top 10, tail folded into "Other") with the $ labelled at the bar end —
 * never a categorical colour cycle (a ranking is magnitude, not identity). Models
 * have no scope to drill into, so the bars are not clickable.
 *
 * THE LANE IS A PROP, NOT A CONSTANT IN THE CAPTION. This card used to state
 * "usage lane" unconditionally. Once the page's toggle reached the drivers
 * endpoint that became a false claim in chargeback mode — the bars would be
 * `provider_usage_fact` money under a caption naming the attributed lane, which
 * is the exact defect class (copy asserting what the data does not) that the
 * measure-lane contract exists to stop. The caption now comes from the response.
 *
 * SO IS THE SCOPE. A per-MODEL charge is Anthropic's alone — Copilot raises one
 * pooled invoice per cost centre and reports no model on it — so "billed lane"
 * over these bars still read as the region's whole charge. The scope clause and
 * the reason both come from `chargebackCoverage`, so the caption cannot outlive
 * the coverage it describes any more than it can outlive the lane.
 *
 * THE BODY IS `ModelSplitPanel` (prototype note `fix 3`), shared with the
 * whole-company card. This card owns the heading, the caption and the coverage
 * gaps; the panel owns the three-way split and the lane footer, so the two
 * widths of the same question cannot end up with different answers.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ModelSplitPanel from '../ModelSplitPanel.vue'
import { chargebackScopeClause } from '#shared/reports/types'
import type {
  BilledLaneMeta,
  ChargebackCoverage,
  DriverRow,
  MeasureLane,
} from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    rows: DriverRow[] | null
    /**
     * The lane the ROWS were computed on — the response's own `measureLanes.rows`,
     * never the page's `?lane=`. They differ on any axis that cannot follow the
     * toggle, and the caption must state what was measured, not what was asked.
     */
    lane?: MeasureLane
    /** WHOSE charge these bars are, in the chargeback lane — see the header. */
    chargebackCoverage?: ChargebackCoverage
    /** The model axis's OWN total, in `lane`. The panel's only denominator. */
    headlineUsd?: number | null
    /** Billed-lane completeness, so an empty card says WHY it is empty. */
    billedLane?: BilledLaneMeta
  }>(),
  {
    lane: 'attributed',
    chargebackCoverage: undefined,
    headlineUsd: null,
    billedLane: undefined,
  },
)

const scopeClause = computed(() => chargebackScopeClause(props.chargebackCoverage))
const caption = computed(() =>
  props.lane === 'billed'
    ? `Model spend across the region · billed lane, per the provider${scopeClause.value ? ` · ${scopeClause.value}` : ''}`
    : 'Model spend across the region · attributed usage lane',
)
/** The unavailable-for-this-lane sentences, in the server's own words. */
const gaps = computed(() => props.chargebackCoverage?.gaps ?? [])
</script>

<template>
  <UiCard data-testid="regional-top-models">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Top models</div>
      <div class="text-[11px] text-carbon-3" data-testid="regional-top-models-lane">{{ caption }}</div>
    </div>
    <!-- Whose charge these bars are NOT, above them rather than under them. -->
    <div
      v-if="gaps.length"
      class="mt-3 rounded-md border border-calm-2 bg-calm-1/50 px-3 py-2"
      data-testid="regional-top-models-gaps"
      role="note"
    >
      <p v-for="(g, i) in gaps" :key="i" class="text-[11px] leading-snug text-carbon-2">
        {{ g.reason }}
      </p>
    </div>
    <div class="mt-3">
      <ModelSplitPanel
        :rows="rows"
        :denominator-usd="headlineUsd"
        :lane="lane"
        :billed-lane="billedLane"
        :top-n="10"
      />
    </div>
  </UiCard>
</template>
