<script setup lang="ts">
/*
 * ActivityDetailDrawer — the tag/activity drill-down: "how much did this
 * activity cost me, on which models, across which sessions." A right-anchored
 * slide-over opened by clicking an activity chip (My usage tagged-spend card,
 * My consumption composition). Consumes GET /api/v1/me/activity/{activity}.
 *
 * Rolling-window (7/30/90d) deep-dive — deliberately its OWN window, labelled
 * as such, not a mirror of the MTD card it may open from. Each session row
 * hands off to the session drill-down via `open-session` (the parent owns that
 * drawer), so model detail lives exactly one hop deeper.
 */
import { ref, computed, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtUsd, fmtTokens, fmtTimeAgo } from '../../composables/useFormat'
import { modelDisplay } from '../../composables/useModelDisplay'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
import type { PeriodOption } from '../ui/PeriodSwitch.vue'
import { TOKEN_TYPES, type ActivityDetail } from '#shared/schemas/usage'

const props = defineProps<{
  /** Activity label to drill into; null = drawer closed. */
  activity: string | null
}>()
const emit = defineEmits<{ close: []; 'open-session': [sessionId: string] }>()

const WINDOW_OPTIONS: PeriodOption[] = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
]
const windowKey = ref('30')

const detail = ref<ActivityDetail | null>(null)
const pending = ref(false)
const error = ref<string | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLElement | null>(null)
const titleId = 'activity-detail-title'

async function load(activity: string, window: string) {
  pending.value = true
  error.value = null
  try {
    detail.value = await $fetch<ActivityDetail>(
      `/api/v1/me/activity/${encodeURIComponent(activity)}`,
      { query: { window } },
    )
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Could not load this activity’s detail.')
    detail.value = null
  } finally {
    pending.value = false
  }
}

// Fetch on open AND on window change (SSR-null-guarded, testable — see the
// SessionDetailDrawer note on why this is a plain watch, not useModalA11y.onOpen).
watch(
  [() => props.activity, windowKey],
  ([activity, window]) => {
    if (activity) void load(activity, window)
    else {
      detail.value = null
      error.value = null
      windowKey.value = '30' // reset to the default window for the next open
    }
  },
  { immediate: true },
)

useModalA11y({
  isOpen: () => !!props.activity,
  dialogEl,
  // UiButton is a COMPONENT, so this ref holds its instance; useModalA11y
  // resolves that to its root element. No cast — the cast was the bug.
  firstField: closeBtn,
  onClose: () => emit('close'),
})

const windowDays = computed(() => Number(windowKey.value))
const modelSlices = computed(() =>
  (detail.value?.by_model ?? []).map((m) => ({
    label: modelDisplay(m.model).label,
    value: Number(m.cost_usd),
    title: `${modelDisplay(m.model).label} — ${fmtUsd(m.cost_usd)} · ${fmtTokens(m.tokens)}`,
  })),
)
const LANE_LABELS: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  'cache-read': 'Cache read',
  'cache-write': 'Cache write',
}
const laneRows = computed(() => {
  const by = new Map((detail.value?.by_token_type ?? []).map((t) => [t.token_type, t]))
  return TOKEN_TYPES.map((tt) => {
    const row = by.get(tt)
    return { key: tt, label: LANE_LABELS[tt] ?? tt, tokens: row?.tokens ?? 0, cost: Number(row?.cost_usd ?? 0) }
  }).filter((r) => r.tokens > 0 || r.cost > 0)
})
const laneMaxCost = computed(() => Math.max(0, ...laneRows.value.map((r) => r.cost)))
const advisoryUsd = computed(() => Number(detail.value?.fidelity.tier2_cost_usd ?? 0))
</script>

<template>
  <div
    v-if="activity"
    class="fixed inset-0 z-50 flex justify-end bg-carbon/40"
    data-testid="activity-detail-drawer"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-xl h-full bg-paper shadow-2xl overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <!-- Header -->
      <div class="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-calm-2 px-6 py-4 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Activity detail</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5 capitalize truncate">{{ activity }}</h2>
          <p class="text-[11px] text-carbon-3 mt-0.5">Your spend on this tag over the selected window.</p>
        </div>
        <UiButton ref="closeBtn" kind="ghost" size="sm" data-testid="activity-detail-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4 flex items-center justify-end">
        <UiPeriodSwitch v-model="windowKey" :options="WINDOW_OPTIONS" />
      </div>

      <div v-if="pending" class="px-6 py-16 text-center text-sm text-carbon-3" data-testid="activity-detail-loading">
        Loading activity detail…
      </div>

      <div v-else-if="error" class="px-6 py-16 text-center" data-testid="activity-detail-error">
        <p class="text-sm text-rag-red">{{ error }}</p>
        <UiButton v-if="activity" kind="ghost" size="sm" class="mt-3" @click="load(activity, windowKey)">Retry</UiButton>
      </div>

      <div v-else-if="detail" class="px-6 pb-6 space-y-6">
        <!-- Summary tiles -->
        <div class="grid grid-cols-3 gap-3" data-testid="activity-detail-summary">
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Spend · {{ windowDays }}d</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ fmtUsd(detail.total_cost_usd) }}</div>
          </div>
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Tokens</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ fmtTokens(detail.total_tokens) }}</div>
          </div>
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Sessions</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ detail.session_count }}</div>
          </div>
        </div>
        <p v-if="advisoryUsd > 0" class="text-[11px] text-rag-amber -mt-3">
          incl. {{ fmtUsd(detail.fidelity.tier2_cost_usd) }} advisory (telemetry-only) spend
        </p>

        <!-- Model mix -->
        <section data-testid="activity-detail-models">
          <UiEyebrow>Model mix</UiEyebrow>
          <div class="mt-3">
            <ChartsDonutChart :slices="modelSlices" aria-label="Model mix by cost for this activity" :center-label="fmtUsd(detail.total_cost_usd)" center-sub="total" />
          </div>
        </section>

        <!-- Token lanes -->
        <section v-if="laneRows.length" data-testid="activity-detail-lanes">
          <UiEyebrow>Where the tokens went</UiEyebrow>
          <ul class="mt-3 space-y-2">
            <li v-for="l in laneRows" :key="l.key" class="text-xs">
              <div class="flex items-center justify-between gap-2">
                <span class="font-semibold text-carbon-2">{{ l.label }}</span>
                <span class="text-carbon-3 shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtTokens(l.tokens) }} · {{ fmtUsd(l.cost) }}</span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-calm-2 overflow-hidden">
                <div class="h-full rounded-full bg-brand-harmony" :style="{ width: (laneMaxCost > 0 ? (l.cost / laneMaxCost) * 100 : 0) + '%' }" />
              </div>
            </li>
          </ul>
        </section>

        <!-- Sessions carrying this tag -->
        <section data-testid="activity-detail-sessions">
          <UiEyebrow>Sessions ({{ detail.sessions.length }})</UiEyebrow>
          <!-- The server caps the session list at 100 (by cost) — surface it rather
               than silently truncate. -->
          <p v-if="detail.sessions.length >= 100" class="text-[11px] text-carbon-3 mt-0.5" data-testid="activity-detail-session-cap">
            Showing the top 100 sessions by cost.
          </p>
          <ul v-if="detail.sessions.length" class="mt-2 divide-y divide-calm-2">
            <li v-for="s in detail.sessions" :key="s.session_id">
              <button
                type="button"
                class="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:bg-brand-harmony-sheer/40 rounded px-2 -mx-2 transition-colors"
                :data-testid="`activity-session-${s.session_id}`"
                @click="emit('open-session', s.session_id)"
              >
                <div class="min-w-0">
                  <div class="font-mono text-[12px] text-carbon truncate">{{ s.session_id.slice(0, 16) }}</div>
                  <div class="text-[11px] text-carbon-3">
                    {{ s.project_code ?? 'Unallocated' }} · {{ fmtTimeAgo(s.ts_last) }}
                  </div>
                </div>
                <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(s.cost_usd) }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="text-xs text-carbon-3 italic mt-2" data-testid="activity-detail-empty">
            No spend on this activity in the last {{ windowDays }} days.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
