<script setup lang="ts">
/*
 * ForecastBanner — the scope's run-rate headline.
 *
 * build-design §3/§5. In-progress month: data-anchored projection
 * "On track for $X · through day N of M" (N = elapsed UTC days used as the
 * extrapolation denominator). Closed month (`forecast === null`): the ACTUAL
 * plus the settling chip(s) from `meta.providerStates` — no projection.
 *
 * Copilot itemisation (seat-final vs overage projection) is available on hover
 * (title) AND via an expand toggle. The overage projection is estimate-class —
 * labelled, never a charge (the chargeable overage is the bill's net line).
 */
import { computed, ref } from 'vue'
import UiCard from '../ui/Card.vue'
import SettlingStateChip from './SettlingStateChip.vue'
import { fmtUsd } from '../../composables/useFormat'
import type { Forecast, ReportMeta } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    forecast: Forecast | null
    actualUsd?: number
    meta: ReportMeta
  }>(),
  { actualUsd: undefined },
)

const isProjection = computed(() => props.forecast != null)
const copilot = computed(() => props.forecast?.copilot ?? null)

const copilotTitle = computed(() =>
  copilot.value
    ? `Copilot: seat licence (final) ${fmtUsd(copilot.value.seatFinalUsd)} · overage projection ${fmtUsd(copilot.value.projectedOverageUsd)} (estimated — never a charge)`
    : undefined,
)

const expanded = ref(false)
</script>

<template>
  <UiCard data-testid="forecast-banner">
    <!-- In-progress month: data-anchored projection. -->
    <template v-if="isProjection && forecast">
      <div class="flex items-baseline gap-2 flex-wrap">
        <span
          class="text-2xl font-bold tabular-nums text-carbon"
          :title="copilotTitle"
          data-testid="forecast-projected"
        >On track for {{ fmtUsd(forecast.projectedUsd) }}</span>
        <span class="text-sm text-carbon-3">· through day {{ forecast.daysElapsed }} of {{ forecast.daysInMonth }}</span>
      </div>

      <div v-if="copilot" class="mt-2">
        <button
          type="button"
          class="text-[11px] font-semibold text-brand-harmony hover:underline"
          :aria-expanded="expanded"
          data-testid="forecast-copilot-toggle"
          @click="expanded = !expanded"
        >{{ expanded ? 'Hide' : 'Copilot breakdown' }}</button>

        <dl v-if="expanded" class="mt-1.5 text-[12px] text-carbon-2 space-y-0.5" data-testid="forecast-copilot-detail">
          <div class="flex justify-between gap-4">
            <dt>Copilot seat licence (final)</dt>
            <dd class="tabular-nums">{{ fmtUsd(copilot.seatFinalUsd) }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt>
              Copilot overage projection
              <span class="text-carbon-3 italic">— estimated · never a charge</span>
            </dt>
            <dd class="tabular-nums">{{ fmtUsd(copilot.projectedOverageUsd) }}</dd>
          </div>
        </dl>
      </div>
    </template>

    <!-- Closed month: actual + settling chip(s). -->
    <template v-else>
      <div class="flex items-baseline gap-2 flex-wrap">
        <span class="text-2xl font-bold tabular-nums text-carbon" data-testid="forecast-actual">{{ fmtUsd(actualUsd) }}</span>
        <span class="text-sm text-carbon-3">· actual for the month</span>
      </div>
      <div class="mt-2 flex flex-col gap-1.5">
        <SettlingStateChip
          v-for="p in meta.providerStates"
          :key="p.vendor"
          :state="p.state"
          :horizon-date="p.settlesAt"
          :vendor="p.vendor"
        />
      </div>
    </template>
  </UiCard>
</template>
