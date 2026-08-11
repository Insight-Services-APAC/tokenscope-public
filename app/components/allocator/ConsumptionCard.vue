<script setup lang="ts">
/*
 * ConsumptionCard — sticky right-column card showing live consumption
 * against the aggregate allocation (focused row + siblings).
 *
 * Per design-notes §Screen 4: accent-bordered Hunger when over;
 * over-banner copy "Project is over allocation. Add a top-up below,
 * or talk to the team — TokenScope won't block sessions."
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import UiPbar from '../ui/Pbar.vue'
import UiBadge from '../ui/Badge.vue'
import { ragOf, ragLabel } from '../../composables/useRagState'
import { fmtUsd } from '../../composables/useFormat'

const props = withDefaults(
  defineProps<{
    usedUsd: number
    totalUsd: number
    /**
     * The share of `usedUsd` that arrived through provider reconciliation
     * rather than emitted telemetry. Same figure, same lane and same window as
     * the project page's headline — shown so a PM deciding on a top-up can see
     * where the number came from instead of assuming it is all telemetry.
     */
    reconciledUsd?: number
  }>(),
  { reconciledUsd: 0 },
)

const pct = computed(() => (props.totalUsd > 0 ? props.usedUsd / props.totalUsd : 0))
const sev = computed(() => ragOf(pct.value))
const isOver = computed(() => pct.value > 1)
const statusLabel = computed(() => ragLabel(pct.value))
const overByUsd = computed(() => Math.max(0, props.usedUsd - props.totalUsd))
// Money cells use the shared guarded formatter (SYS-5).
</script>

<template>
  <UiCard
    :accent="sev === 'red' ? 'hunger' : sev === 'amber' ? 'hunger' : 'harmony'"
    data-testid="consumption-card"
  >
    <div class="flex items-center justify-between">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3">
        Consumption to date
      </div>
      <UiBadge
        :kind="sev === 'red' ? 'rag-red' : sev === 'amber' ? 'rag-amber' : 'rag-green'"
        data-testid="consumption-status"
      >
        {{ statusLabel }}
      </UiBadge>
    </div>
    <div
      class="text-[32px] font-bold text-carbon mt-2 leading-[1]"
      style="font-variant-numeric: tabular-nums"
    >
      {{ fmtUsd(usedUsd) }}
    </div>
    <div class="text-xs text-carbon-2 mt-1" style="font-variant-numeric: tabular-nums">
      of {{ fmtUsd(totalUsd) }} ({{ Math.round(pct * 100) }}%)
    </div>
    <div
      v-if="reconciledUsd > 0"
      class="text-[11px] text-carbon-3 mt-1"
      data-testid="consumption-reconciled-share"
      title="Reconciled from provider usage rather than emitted telemetry — counted in full, and the same figure the project page shows."
    >
      incl. {{ fmtUsd(reconciledUsd) }} reconciled from provider usage
    </div>
    <UiPbar :pct="pct" size="lg" class="mt-4" />
    <div
      v-if="isOver"
      class="mt-4 p-3 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-xs text-brand-heart leading-relaxed"
      data-testid="consumption-over-banner"
    >
      <span class="font-bold">${{ overByUsd.toFixed(2) }} over.</span>
      Project is over allocation. Add a top-up below, or talk to the team —
      TokenScope won't block sessions.
    </div>
  </UiCard>
</template>
