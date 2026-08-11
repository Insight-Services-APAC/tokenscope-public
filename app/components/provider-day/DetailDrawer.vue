<script setup lang="ts">
/*
 * ProviderDayDetailDrawer — the drill-down for a PROVIDER-RECORDED DAY, the
 * counterpart of SessionDetailDrawer for the unit that has no session.
 *
 * WHY IT EXISTS. A day the provider's API reported (because the teammate had no
 * OTel emission for it) used to render as a bare dollar figure and a Tag button,
 * while a session next to it opened a full breakdown. The dimensions were
 * already stored — model, token lanes and requests all arrive per day from the
 * provider — so the gap was a missing rendering panel, not missing data.
 *
 * A pure CONSUMER of GET /api/v1/me/unaccounted/{id} → ProviderDayDetail. Every
 * figure it renders is one the provider sent for this (teammate, day, tool),
 * read from provider_usage_fact's own rows: no proportion, no apportionment and
 * no ratio produces any money on this panel.
 *
 * WHAT A SESSION HAS AND THIS DOES NOT, and why those sections are simply absent
 * rather than explained: a session id, a duration and the conversation-vs-harness
 * split exist only at OTel granularity, and cache SAVINGS would require pricing
 * tokens at a rate divided out of cost and token rows that are disjoint by
 * construction (mig 0118). The observed cache lanes ARE shown, under "Where the
 * tokens went". Absent things get no paragraph.
 *
 * Accessibility: the shared useModalA11y contract (Escape, focus-trap,
 * focus-restore), same as SessionDetailDrawer and TagSessionDialog.
 */
import { type ComponentPublicInstance, ref, computed, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtUsd, fmtTokens, clientMeta } from '../../composables/useFormat'
import { modelDisplay } from '../../composables/useModelDisplay'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
import {
  PROVIDER_DAY_TOKEN_LANES,
  type ProviderDayDetail,
  type ProviderDayNullModelReason,
} from '#shared/schemas/provider-day'

const props = defineProps<{
  /** unaccounted_usage record id to load; null = drawer closed. */
  recordId: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const detail = ref<ProviderDayDetail | null>(null)
const pending = ref(false)
const error = ref<string | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
/*
 * A template ref on a COMPONENT holds its instance, not an element — typing it
 * as HTMLElement is what let a `.focus()` call through the typechecker and
 * throw at runtime. `useModalA11y`/`focusTarget` resolves `$el`; the type says
 * what is actually there so the cast cannot come back.
 */
const closeBtn = ref<ComponentPublicInstance | null>(null)
const titleId = 'provider-day-detail-title'

async function load(id: string) {
  pending.value = true
  error.value = null
  detail.value = null
  try {
    detail.value = await $fetch<ProviderDayDetail>(
      `/api/v1/me/unaccounted/${encodeURIComponent(id)}`,
    )
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Could not load this day’s detail.')
  } finally {
    pending.value = false
  }
}

// Driven by the id directly (not useModalA11y.onOpen) so the fetch runs under
// the SSR-null guard AND in tests — useModalA11y's body is client-only, which is
// right for focus/Escape but would strand the fetch. A null id clears the
// payload so a reopen never flashes the previous day.
watch(
  () => props.recordId,
  (id) => {
    if (id) void load(id)
    else {
      detail.value = null
      error.value = null
    }
  },
  { immediate: true },
)

useModalA11y({
  isOpen: () => !!props.recordId,
  dialogEl,
  // UiButton is a COMPONENT, so this ref holds its instance; useModalA11y
  // resolves that to its root element. No cast — the cast was the bug.
  firstField: closeBtn,
  onClose: () => emit('close'),
})

// ── Derived views ────────────────────────────────────────────────────────

/*
 * What a disclosed bucket is called. The three reasons are deliberately NOT
 * collapsed into one label: two of them are permanent and one resolves on its
 * own within the hour, and an operator who cannot tell them apart watches the
 * same bucket appear and vanish between refreshes.
 */
const NULL_MODEL_LABELS: Record<ProviderDayNullModelReason, string> = {
  'provider-reports-day-grain': 'Reported at day grain',
  'provider-carried-no-model': 'No model on the provider record',
  'awaiting-provider-detail': 'Awaiting provider detail',
}
function modelLabel(model: string | null, reason: ProviderDayNullModelReason | null): string {
  if (model !== null) return modelDisplay(model).label
  return reason ? NULL_MODEL_LABELS[reason] : 'No model on the provider record'
}

const modelRows = computed(() =>
  (detail.value?.by_model ?? []).map((m) => ({
    key: m.model ?? `bucket:${m.null_model_reason ?? 'none'}`,
    label: modelLabel(m.model, m.null_model_reason),
    isBucket: m.model === null,
    // NULL cost stays NULL. Number(null) is 0, which would put a $0.00 model
    // beside a deliberately blank provider total — the false claim the schema
    // was just made nullable to prevent. `tokens` and `requests` follow the
    // same contract: null is "never measured" (a Copilot model row's tokens),
    // 0 is a measurement the provider made.
    cost: m.cost_usd == null ? null : Number(m.cost_usd),
    tokens: m.tokens,
    requests: m.requests,
  })),
)

/** Donut slices, cost-share desc (the endpoint already orders by_model). */
const modelSlices = computed(() =>
  // A model whose cost is not yet derived has no slice — an unknown cannot be
  // drawn as a proportion of a total. It still appears in the table below with
  // its tokens and requests, which ARE observed.
  modelRows.value
    .filter((m): m is typeof m & { cost: number } => m.cost != null)
    .map((m) => ({
      label: m.label,
      value: m.cost,
      title: `${m.label} — ${fmtUsd(m.cost)}${m.tokens ? ` · ${fmtTokens(m.tokens)}` : ''}`,
    })),
)

/** What the donut's centre reports: the sum the slices actually add up to. */
const sliceTotal = computed(() => modelRows.value.reduce((a, m) => a + (m.cost ?? 0), 0))

const LANE_LABELS: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  'cache-read': 'Cache read',
  'cache-write': 'Cache write',
}
function laneLabel(tt: string): string {
  return LANE_LABELS[tt] ?? tt
}

/** Token lanes in canonical order. Tokens only — the provider sends no money on them. */
const laneRows = computed(() => {
  const by = new Map((detail.value?.by_token_type ?? []).map((t) => [t.token_type, t]))
  return PROVIDER_DAY_TOKEN_LANES.filter((tt) => by.has(tt)).map((tt) => ({
    key: tt,
    label: laneLabel(tt),
    tokens: by.get(tt)?.tokens ?? 0,
  }))
})
const laneMaxTokens = computed(() => Math.max(0, ...laneRows.value.map((r) => r.tokens)))

/*
 * The provider's own total is shown only when it DIFFERS from the amount being
 * tagged. They are the same number whenever OTel captured nothing that day,
 * which is the ordinary shape of these records, and printing one figure twice
 * under two headings invites the reader to hunt for a distinction that is not
 * there. When they do differ — OTel covered part of the day — the provider total
 * is what the model rows below sum to, so it is exactly then that it is needed.
 */
const showProviderTotal = computed(
  () =>
    detail.value?.provider_cost_usd != null &&
    detail.value.provider_cost_usd !== detail.value.unallocated_cost_usd,
)

const webSearches = computed(() => detail.value?.web_search_requests ?? 0)
</script>

<template>
  <!-- z-[60], matching SessionDetailDrawer: a drill-down always lands on top of
       the z-50 activity drawer regardless of DOM sibling order. -->
  <div
    v-if="recordId"
    class="fixed inset-0 z-[60] flex justify-end bg-carbon/40"
    data-testid="provider-day-detail-drawer"
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
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Provider-recorded day</p>
          <h2 :id="titleId" class="inline-flex items-center gap-1.5 text-lg font-bold text-carbon mt-0.5">
            <Icon v-if="detail" :name="clientMeta(detail.tool).icon" class="text-base" aria-hidden="true" />
            {{ detail ? detail.day : 'Day' }}
          </h2>
          <p v-if="detail" class="text-[11px] text-carbon-3 mt-0.5">{{ clientMeta(detail.tool).name }}</p>
        </div>
        <UiButton ref="closeBtn" kind="ghost" size="sm" data-testid="provider-day-detail-close" @click="emit('close')">Close</UiButton>
      </div>

      <!-- Loading -->
      <div v-if="pending" class="px-6 py-16 text-center text-sm text-carbon-3" data-testid="provider-day-detail-loading">
        Loading day detail…
      </div>

      <!-- Error -->
      <div v-else-if="error" class="px-6 py-16 text-center" data-testid="provider-day-detail-error">
        <p class="text-sm text-rag-red">{{ error }}</p>
        <UiButton v-if="recordId" kind="ghost" size="sm" class="mt-3" @click="load(recordId)">Retry</UiButton>
      </div>

      <!-- Content -->
      <div v-else-if="detail" class="px-6 py-5 space-y-6">
        <!-- Summary tiles -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="provider-day-detail-summary">
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Unallocated</div>
            <div
              class="text-lg font-bold text-carbon mt-0.5"
              style="font-variant-numeric: tabular-nums"
              data-testid="provider-day-unallocated"
            >{{ fmtUsd(detail.unallocated_cost_usd) }}</div>
          </div>
          <div v-if="showProviderTotal" class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Provider recorded</div>
            <div
              class="text-lg font-bold text-carbon mt-0.5"
              style="font-variant-numeric: tabular-nums"
              data-testid="provider-day-provider-total"
            >{{ fmtUsd(detail.provider_cost_usd ?? 0) }}</div>
          </div>
          <div v-if="detail.tokens > 0" class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Tokens</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ fmtTokens(detail.tokens) }}</div>
          </div>
          <div v-if="detail.requests > 0" class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Requests</div>
            <div
              class="text-lg font-bold text-carbon mt-0.5"
              style="font-variant-numeric: tabular-nums"
              data-testid="provider-day-requests"
            >{{ fmtTokens(detail.requests) }}</div>
          </div>
          <!-- The provider counts server-side web searches per day (mig 0122).
               A session has no equivalent, so it appears only here, and only
               when the provider actually reported some. -->
          <div v-if="webSearches > 0" class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Web searches</div>
            <div
              class="text-lg font-bold text-carbon mt-0.5"
              style="font-variant-numeric: tabular-nums"
              data-testid="provider-day-web-searches"
            >{{ fmtTokens(webSearches) }}</div>
          </div>
        </div>

        <!-- Context line: project · activity · dismissed · multi-org -->
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span
            v-if="detail.project_code"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-brand-harmony-sheer text-brand-harmony font-semibold"
          >{{ detail.project_code }}<span class="text-carbon-3 font-normal">· {{ detail.project_display_name }}</span></span>
          <span v-else class="px-2 py-0.5 rounded bg-calm/60 text-carbon-3 font-semibold">Unallocated</span>
          <span v-if="detail.activity" class="px-2 py-0.5 rounded bg-brand-zeal-lite/60 text-carbon-2 font-medium">{{ detail.activity }}</span>
          <span v-if="detail.dismissed" class="px-2 py-0.5 rounded bg-calm-2 text-carbon-2 font-semibold">Dismissed</span>
          <!-- One taggable record can stand against rows from more than one
               provider org; the figures above aggregate across them. -->
          <span
            v-if="detail.source_count > 1"
            class="px-2 py-0.5 rounded bg-calm/60 text-carbon-2 font-semibold"
            data-testid="provider-day-source-count"
          >{{ detail.source_count }} provider orgs</span>
        </div>

        <!-- Model mix -->
        <section data-testid="provider-day-detail-models">
          <UiEyebrow>Model mix</UiEyebrow>
          <div class="mt-3">
            <ChartsDonutChart
              :slices="modelSlices"
              aria-label="Model mix by cost for this provider-recorded day"
              :center-label="fmtUsd(sliceTotal)"
              center-sub="total"
            />
          </div>
        </section>

        <!-- Token lanes. Tokens only: the provider's usage report carries the
             four lanes with no money on them. -->
        <section v-if="laneRows.length" data-testid="provider-day-detail-lanes">
          <UiEyebrow>Where the tokens went</UiEyebrow>
          <ul class="mt-3 space-y-2">
            <li v-for="l in laneRows" :key="l.key" class="text-xs">
              <div class="flex items-center justify-between gap-2">
                <span class="font-semibold text-carbon-2">{{ l.label }}</span>
                <span class="text-carbon-3 shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtTokens(l.tokens) }}</span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-calm-2 overflow-hidden">
                <div
                  class="h-full rounded-full bg-brand-harmony"
                  :style="{ width: (laneMaxTokens > 0 ? (l.tokens / laneMaxTokens) * 100 : 0) + '%' }"
                />
              </div>
            </li>
          </ul>
        </section>

        <!-- Cost by model. `tokens` comes from the token rows' own aggregate,
             never from the cost share — mig 0118 puts them in disjoint rows, so
             a model's dollar share is not its token share. -->
        <section v-if="modelRows.length" data-testid="provider-day-detail-model-table">
          <UiEyebrow>Cost by model</UiEyebrow>
          <div class="mt-3 overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-[10px] uppercase tracking-wide text-carbon-3">
                  <th class="text-left font-bold py-1.5 pr-3">Model</th>
                  <th class="text-right font-bold py-1.5 px-2">Tokens</th>
                  <th class="text-right font-bold py-1.5 px-2">Requests</th>
                  <th class="text-right font-bold py-1.5 pl-2">Cost</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr v-for="m in modelRows" :key="m.key" :data-testid="`provider-day-model-${m.key}`">
                  <td
                    class="py-1.5 pr-3 font-semibold whitespace-nowrap"
                    :class="m.isBucket ? 'text-carbon-3 italic' : 'text-carbon'"
                  >{{ m.label }}</td>
                  <!-- Null and 0 are DIFFERENT statements on these two cells:
                       null is "the provider never measured this here" (every
                       Copilot model row's tokens; the day-grain bucket's
                       requests) and renders as an em-dash; 0 is a measurement
                       the provider made, and folding it into the same em-dash
                       is how a Copilot model row's one real figure — its
                       requests — became indistinguishable from a fabricated
                       zero (Dev, 2026-08-04). -->
                  <td class="text-right py-1.5 px-2 text-carbon-2" style="font-variant-numeric: tabular-nums">
                    <span v-if="m.tokens != null">{{ fmtTokens(m.tokens) }}</span>
                    <span v-else class="text-carbon-3">—</span>
                  </td>
                  <td class="text-right py-1.5 px-2 text-carbon-2" style="font-variant-numeric: tabular-nums">
                    <span v-if="m.requests != null">{{ fmtTokens(m.requests) }}</span>
                    <span v-else class="text-carbon-3">—</span>
                  </td>
                  <td class="text-right py-1.5 pl-2 font-bold text-carbon" style="font-variant-numeric: tabular-nums">
                    <span v-if="m.cost != null">{{ fmtUsd(m.cost) }}</span>
                    <span v-else class="text-carbon-3" title="No cost row derived for this model yet">&mdash;</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
