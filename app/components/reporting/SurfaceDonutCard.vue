<script setup lang="ts">
/*
 * SurfaceDonutCard — "Spend by surface · billed" (lane-visuals iter-2 I1): the
 * folded lane donut that REPLACES the old "Claude Code vs GitHub Copilot"
 * §A usage donut on the Across + Regional usage views.
 *
 * BILLED basis ONLY, its window PINNED to the hero's (one shared window object
 * — the slices are the hero's own per-lane window totals, same fold membership,
 * r2-2; the conservation test asserts donut Σ == hero Σ). The attributed-basis
 * provider figures the old card carried live ONLY in the §A KPI strip now (one
 * card one basis — r1-F6); the footer is a POINTER to them, never a number.
 *
 * No per-card legend: the page-level LaneLegend carries lane identity
 * (V1 item 5); slice tooltips carry label + $.
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartDonut from './charts/ChartDonut.client.vue'
import LaneSwitchLink from './LaneSwitchLink.vue'
import { fmtUsd } from '../../composables/useFormat'
import type { BuiltSurfaceHeroDonut } from './build-surface-hero'

const props = defineProps<{
  donut: BuiltSurfaceHeroDonut | null
  /** The hero's shared window label, echoed so the pinning is visible. */
  windowLabel?: string
}>()

const slices = computed(() =>
  (props.donut?.slices ?? []).map((s) => ({ name: s.label, key: s.lane, value: s.value })),
)
const hasData = computed(() => slices.value.length > 0)
</script>

<template>
  <UiCard data-testid="surface-donut-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Spend by surface · billed</div>
      <div class="text-[11px] text-carbon-3" data-testid="surface-donut-basis">
        billed usage · same weekly window as the hero<template v-if="windowLabel"> · {{ windowLabel }}</template>
      </div>
    </div>

    <div v-if="hasData" class="mt-4">
      <ChartDonut
        :slices="slices"
        :center-value="fmtUsd(donut!.totalUsd)"
        center-label="billed"
        :legend="false"
        :value-format="(v) => fmtUsd(v)"
        :height="176"
      />
    </div>
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="surface-donut-empty">
      No billed showback in this window yet.
    </p>

    <p class="mt-3 text-[11px] text-carbon-3 leading-snug" data-testid="surface-donut-pointer">
      attributed telemetry view — see the KPIs above; bases differ
    </p>
    <LaneSwitchLink label="See the chargeback view" />
  </UiCard>
</template>
