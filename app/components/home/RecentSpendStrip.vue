<script setup lang="ts">
/*
 * RecentSpendStrip — the developer home page's rolling-window "recent spend"
 * snapshot. This is the HONEST home for My usage's 7/30/90-day time controls:
 * the page hero stays month-to-date (budget vs allocation is monthly), while
 * this strip answers "how much have I spent lately, and at what pace" with no
 * budget/quota framing. Self-contained: owns its window state + fetch.
 *
 * Data: GET /api/v1/me/home/recent (attribution_aggregate, teammate-scoped).
 */
import { ref, computed } from 'vue'
import { fmtUsd, fmtTokens } from '../../composables/useFormat'
import { modelDisplay } from '../../composables/useModelDisplay'
import type { PeriodOption } from '../ui/PeriodSwitch.vue'
import type { RecentUsage } from '#shared/schemas/usage'

// Rolling windows only (no MTD/prior — those are the hero's / reporting's job).
const WINDOW_OPTIONS: PeriodOption[] = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
]
const windowKey = ref('30')

const { data, pending, error, refresh } = await useFetch<RecentUsage>('/api/v1/me/home/recent', {
  query: computed(() => ({ window: windowKey.value })),
  default: () => ({
    window_days: 30,
    total_cost_usd: '0.00',
    total_tokens: 0,
    active_days: 0,
    cost_per_active_day: null,
    series: [],
    by_model: [],
  }),
  lazy: true,
})

const windowDays = computed(() => Number(windowKey.value))
// The axis edge is the SERVER's settled day, never a browser `new Date()`
// (F1/D3). Today rides beyond it as the partial marker when it carries spend.
const { settledThrough, today } = useServerClock()
const topModels = computed(() => (data.value?.by_model ?? []).slice(0, 3))
const hasSpend = computed(() => Number(data.value?.total_cost_usd ?? 0) > 0)
</script>

<template>
  <UiCard data-testid="recent-spend-strip" class="mb-6">
    <div class="flex items-center justify-between gap-4 mb-3">
      <div>
        <UiEyebrow>Recent spend</UiEyebrow>
        <p class="text-xs text-carbon-3 mt-0.5">Your rolling-window spend velocity — separate from this month's budget.</p>
      </div>
      <UiPeriodSwitch v-model="windowKey" :options="WINDOW_OPTIONS" />
    </div>

    <UiFetchErrorBanner :error="error" label="your recent spend" @retry="refresh" />

    <div class="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-6 items-center">
      <!-- Stat tiles -->
      <div class="grid grid-cols-2 gap-3" data-testid="recent-spend-stats">
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Spend · {{ windowDays }}d</div>
          <div class="text-[32px] font-bold tracking-[-1px] text-carbon leading-none mt-1" style="font-variant-numeric: tabular-nums">
            {{ fmtUsd(data?.total_cost_usd ?? '0.00') }}
          </div>
        </div>
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Tokens</div>
          <div class="text-[32px] font-bold tracking-[-1px] text-carbon leading-none mt-1" style="font-variant-numeric: tabular-nums">
            {{ fmtTokens(data?.total_tokens ?? 0) }}
          </div>
        </div>
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Active days</div>
          <div class="text-lg font-bold text-carbon mt-1" style="font-variant-numeric: tabular-nums">{{ data?.active_days ?? 0 }}</div>
        </div>
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Per active day</div>
          <div class="text-lg font-bold text-carbon mt-1" style="font-variant-numeric: tabular-nums">
            {{ data?.cost_per_active_day != null ? fmtUsd(data.cost_per_active_day) : '—' }}
          </div>
        </div>
      </div>

      <!-- Trend sparkline + top models -->
      <div>
        <ChartsTrendArea
          v-if="settledThrough"
          :series="data?.series ?? []"
          :window-days="windowDays"
          :end-day="settledThrough"
          :partial-day="today"
          :height="120"
          empty-label="No telemetry-observed spend in this window — provider-recorded days are not charted here."
        />
        <div v-if="topModels.length" class="flex flex-wrap items-center gap-1.5 mt-2" data-testid="recent-spend-models">
          <span class="text-[11px] text-carbon-3">Top models:</span>
          <span
            v-for="m in topModels"
            :key="m.model"
            class="text-[11px] px-1.5 py-0.5 rounded bg-brand-harmony-sheer text-brand-harmony font-medium"
          >{{ modelDisplay(m.model).label }} · {{ fmtUsd(m.cost_usd) }}</span>
        </div>
      </div>
    </div>

    <p v-if="!pending && !hasSpend" class="text-xs text-carbon-3 italic mt-3" data-testid="recent-spend-empty">
      <!--
        THE SIBLING PATH. /usage's chart carried this same promise and was fixed
        by naming its lane; this strip was left with its own copy of it, and the
        coverage estate's API-only personas walked straight into it: a hero
        reading $36.21 above a strip reading "no spend … as sessions land", for a
        person whose every dollar arrived as a provider-recorded day and will
        never have a session behind it.
      -->
      No telemetry-observed spend in the last {{ windowDays }} days — provider-recorded days
      are counted in your totals above, but are not charted here.
    </p>
  </UiCard>
</template>
