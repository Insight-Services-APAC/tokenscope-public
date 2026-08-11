<script setup lang="ts">
/*
 * SessionDetailDrawer — the developer's "how was THIS conversation's spend
 * attributed" drill-down. A right-anchored slide-over, opened from any
 * recent-session row (My usage today; My consumption / project detail next).
 *
 * It is a pure CONSUMER of the already-shipped session contract
 * `GET /api/v1/me/sessions/{sid}` → SessionDetail (breakdowns.ts primitives):
 * the model×token-type matrix, per-lane split, main-vs-aux (harness) overhead,
 * cache economics (hit ratio + $ saved) and the estimated-vs-advisory fidelity
 * split. All of it was computed server-side and, until now, never surfaced.
 *
 * NOT EVERY PROVIDER PRICES PER TOKEN LANE (fix sprint F3 / D16). A credit-
 * priced session's whole cost is conserved on ONE carrier lane by design
 * (server/usage/span-costing.ts), so drawing the other lanes as $0.00 would say
 * "cache reads were free" when the truth is "this provider never quoted a
 * per-lane price". The payload's `priced_per_lane` decides: money per lane when
 * it is true, an explicit "not priced per lane" when it is false — and the lane
 * BARS measure tokens either way, which is what the section header promises and
 * what stays real on every provider.
 *
 * Teammate-scoped by the endpoint (AR-based ownership → 404 for a foreign id);
 * this component trusts that gate and never passes a teammate id.
 *
 * Accessibility: role="dialog" + aria-modal + aria-labelledby via the shared
 * useModalA11y contract (Escape, focus-trap, focus-restore) — the same one
 * TagSessionDialog uses.
 */
import { ref, computed, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtUsd, fmtTokens, fmtTimeAgo, clientMeta } from '../../composables/useFormat'
import { modelDisplay } from '../../composables/useModelDisplay'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
import { TOKEN_TYPES, type SessionDetail } from '#shared/schemas/usage'

const props = defineProps<{
  /** Claude session id (conversation) to load; null = drawer closed. */
  sessionId: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const detail = ref<SessionDetail | null>(null)
const pending = ref(false)
const error = ref<string | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLElement | null>(null)
const titleId = 'session-detail-title'

async function load(id: string) {
  pending.value = true
  error.value = null
  detail.value = null
  try {
    detail.value = await $fetch<SessionDetail>(`/api/v1/me/sessions/${encodeURIComponent(id)}`)
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Could not load this session’s detail.')
  } finally {
    pending.value = false
  }
}

// The DATA fetch is driven by the id directly (not useModalA11y.onOpen) so it
// runs under SSR-null guard AND in tests — useModalA11y's body is client-only
// (`import.meta.client`), which is right for focus/Escape but would strand the
// fetch. A null id (drawer closed) clears the payload so a reopen never flashes
// the previous session.
watch(
  () => props.sessionId,
  (id) => {
    if (id) void load(id)
    else {
      detail.value = null
      error.value = null
    }
  },
  { immediate: true },
)

// useModalA11y handles ONLY the a11y contract (Escape-close, focus-trap,
// focus-restore) — client-only by design.
useModalA11y({
  isOpen: () => !!props.sessionId,
  dialogEl,
  // UiButton is a COMPONENT, so this ref holds its instance; useModalA11y
  // resolves that to its root element. No cast — the cast was the bug.
  firstField: closeBtn,
  onClose: () => emit('close'),
})

// ── Derived views over the detail payload ────────────────────────────────

/** Human elapsed span between first and last attributed event. */
const durationLabel = computed(() => {
  const d = detail.value
  if (!d) return ''
  const ms = new Date(d.ts_last).getTime() - new Date(d.ts_start).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 'single burst'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
})

/** Model-mix donut slices, cost-share desc (endpoint already orders by_model). */
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
function laneLabel(tt: string): string {
  return LANE_LABELS[tt] ?? tt
}

/**
 * Does this session's provider price per token lane (D14)? Server-derived and
 * shipped on the payload; the client never re-derives it from the tool name.
 * Absent (an older payload) is treated as "priced" — the pre-F3 behaviour.
 */
const pricedPerLane = computed(() => detail.value?.priced_per_lane !== false)

/**
 * Token-lane rows in canonical order (input → output → cache-read → cache-write).
 *
 * `cost` is `number | null`, and NULL means the provider does not price per
 * lane — NOT $0.00. The section measures TOKENS (D16): that is what the header
 * promises, it is real on every provider, and it is the one lane quantity a
 * credit-priced session still has.
 */
const laneRows = computed(() => {
  const by = new Map((detail.value?.by_token_type ?? []).map((t) => [t.token_type, t]))
  return TOKEN_TYPES.map((tt) => {
    const row = by.get(tt)
    const raw = row?.cost_usd ?? null
    return {
      key: tt,
      label: laneLabel(tt),
      tokens: row?.tokens ?? 0,
      cost: raw === null ? null : Number(raw),
    }
  }).filter((r) => r.tokens > 0 || (r.cost ?? 0) > 0)
})
/** Bars are sized by TOKENS — see laneRows. */
const laneMaxTokens = computed(() => Math.max(0, ...laneRows.value.map((r) => r.tokens)))

/**
 * The model × token-type matrix. Rows follow by_model order (cost desc);
 * columns are the four canonical lanes.
 *
 * The CELL MEASURE follows the same rule as the lane bars: money where the
 * provider prices per lane, TOKENS where it does not. The row total stays money
 * either way — a model's total IS priced (each span's whole cost lands on that
 * span's own model), it is only the lane split that the provider never quoted.
 */
const matrixModels = computed(() => (detail.value?.by_model ?? []).map((m) => m.model))
const matrixLanes = computed(() =>
  TOKEN_TYPES.filter((tt) => (detail.value?.matrix ?? []).some((c) => c.token_type === tt)),
)
const matrixLookup = computed(() => {
  const map = new Map<string, { cost: number | null; tokens: number }>()
  for (const c of detail.value?.matrix ?? []) {
    map.set(`${c.model}|${c.token_type}`, {
      cost: c.cost_usd === null ? null : Number(c.cost_usd),
      tokens: c.tokens,
    })
  }
  return map
})
function cellCost(model: string, tt: string): number | null {
  return matrixLookup.value.get(`${model}|${tt}`)?.cost ?? null
}
function cellTokens(model: string, tt: string): number {
  return matrixLookup.value.get(`${model}|${tt}`)?.tokens ?? 0
}
function modelRowTotal(model: string): number {
  return Number(detail.value?.by_model.find((m) => m.model === model)?.cost_usd ?? 0)
}

/** Main-vs-aux (harness overhead) split by cost. NULL query_source = unknown lane. */
const querySplit = computed(() => {
  const rows = detail.value?.by_query_source ?? []
  const total = rows.reduce((a, r) => a + Number(r.cost_usd), 0)
  return rows
    .map((r) => {
      const label = r.query_source === null ? 'Unknown' : r.query_source === 'main' ? 'Your conversation' : r.query_source
      return {
        label,
        raw: r.query_source,
        cost: Number(r.cost_usd),
        tokens: r.tokens,
        share: total > 0 ? Number(r.cost_usd) / total : 0,
      }
    })
    .sort((a, b) => b.cost - a.cost)
})

const advisoryUsd = computed(() => Number(detail.value?.fidelity.tier2_cost_usd ?? 0))
const hitPct = computed(() => {
  const r = detail.value?.cache.hit_ratio
  return r == null ? null : Math.round(r * 100)
})
</script>

<template>
  <!-- z-[60] (above the z-50 activity drawer) so the activity→session drill-down
       always lands the session drawer ON TOP, regardless of DOM sibling order on
       the hosting page. -->
  <div
    v-if="sessionId"
    class="fixed inset-0 z-[60] flex justify-end bg-carbon/40"
    data-testid="session-detail-drawer"
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
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Session detail</p>
          <h2 :id="titleId" class="inline-flex items-center gap-1.5 text-lg font-bold text-carbon mt-0.5">
            <Icon v-if="detail" :name="clientMeta(detail.tool).icon" class="text-base" aria-hidden="true" />
            {{ detail ? clientMeta(detail.tool).name : 'Conversation' }}
            <UsageModelBadge v-if="detail" :by-model="detail.by_model" />
          </h2>
          <p class="font-mono text-[11px] text-carbon-3 mt-0.5 truncate" :title="sessionId">{{ sessionId }}</p>
        </div>
        <UiButton ref="closeBtn" kind="ghost" size="sm" data-testid="session-detail-close" @click="emit('close')">Close</UiButton>
      </div>

      <!-- Loading -->
      <div v-if="pending" class="px-6 py-16 text-center text-sm text-carbon-3" data-testid="session-detail-loading">
        Loading session detail…
      </div>

      <!-- Error -->
      <div v-else-if="error" class="px-6 py-16 text-center" data-testid="session-detail-error">
        <p class="text-sm text-rag-red">{{ error }}</p>
        <UiButton v-if="sessionId" kind="ghost" size="sm" class="mt-3" @click="load(sessionId)">Retry</UiButton>
      </div>

      <!-- Content -->
      <div v-else-if="detail" class="px-6 py-5 space-y-6">
        <!-- Summary tiles -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="session-detail-summary">
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Cost</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ fmtUsd(detail.cost_usd) }}</div>
          </div>
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Tokens</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ fmtTokens(detail.tokens) }}</div>
          </div>
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Duration</div>
            <div class="text-lg font-bold text-carbon mt-0.5">{{ durationLabel }}</div>
          </div>
          <div class="rounded-lg bg-white border border-calm-2 px-3 py-2.5">
            <div class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">Requests</div>
            <div class="text-lg font-bold text-carbon mt-0.5" style="font-variant-numeric: tabular-nums">{{ fmtTokens(detail.record_count) }}</div>
          </div>
        </div>

        <!-- Context line: project · activity · when · fidelity -->
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span
            v-if="detail.project_code"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-brand-harmony-sheer text-brand-harmony font-semibold"
          >{{ detail.project_code }}<span class="text-carbon-3 font-normal">· {{ detail.project_display_name }}</span></span>
          <span v-else class="px-2 py-0.5 rounded bg-calm/60 text-carbon-3 font-semibold">Unallocated</span>
          <span v-if="detail.activity" class="px-2 py-0.5 rounded bg-brand-zeal-lite/60 text-carbon-2 font-medium">{{ detail.activity }}</span>
          <span class="text-carbon-3">Last active {{ fmtTimeAgo(detail.ts_last) }}</span>
          <span
            v-if="advisoryUsd > 0"
            class="px-2 py-0.5 rounded bg-rag-amber/10 text-rag-amber font-semibold"
            title="Advisory (tier-2) spend is telemetry-only — not corroborated by a provider bill."
          >incl. {{ fmtUsd(detail.fidelity.tier2_cost_usd) }} advisory</span>
        </div>

        <!-- Model mix -->
        <section data-testid="session-detail-models">
          <UiEyebrow>Model mix</UiEyebrow>
          <div class="mt-3">
            <ChartsDonutChart :slices="modelSlices" aria-label="Model mix by cost for this session" :center-label="fmtUsd(detail.cost_usd)" center-sub="total" />
          </div>
        </section>

        <!-- Token lanes -->
        <section data-testid="session-detail-lanes">
          <UiEyebrow>Where the tokens went</UiEyebrow>
          <ul class="mt-3 space-y-2">
            <li v-for="l in laneRows" :key="l.key" class="text-xs" :data-testid="`session-detail-lane-${l.key}`">
              <div class="flex items-center justify-between gap-2">
                <span class="font-semibold text-carbon-2">{{ l.label }}</span>
                <span class="text-carbon-3 shrink-0" style="font-variant-numeric: tabular-nums">
                  {{ fmtTokens(l.tokens) }}
                  <template v-if="l.cost !== null"> · {{ fmtUsd(l.cost) }}</template>
                </span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-calm-2 overflow-hidden">
                <div class="h-full rounded-full bg-brand-harmony" :style="{ width: (laneMaxTokens > 0 ? (l.tokens / laneMaxTokens) * 100 : 0) + '%' }" />
              </div>
            </li>
          </ul>
          <!-- D16: say what is true instead of printing $0.00 four times. The
               money is stated once, in the Cost tile above. -->
          <p
            v-if="laneRows.length && !pricedPerLane"
            class="text-[11px] text-carbon-3 mt-2"
            data-testid="session-detail-lanes-unpriced"
          >
            Not priced per lane — this provider bills in credits per request, not per token
            lane, so this session’s cost (stated once, above) cannot be split across these
            lanes. The token counts are measured.
          </p>
          <p v-if="!laneRows.length" class="text-xs text-carbon-3 italic mt-2">No token-lane detail for this session.</p>
        </section>

        <!-- Model × lane matrix -->
        <section v-if="matrixModels.length" data-testid="session-detail-matrix">
          <UiEyebrow>{{ pricedPerLane ? 'Cost by model & lane' : 'Tokens by model & lane' }}</UiEyebrow>
          <div class="mt-3 overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-[10px] uppercase tracking-wide text-carbon-3">
                  <th class="text-left font-bold py-1.5 pr-3">Model</th>
                  <th v-for="tt in matrixLanes" :key="tt" class="text-right font-bold py-1.5 px-2 whitespace-nowrap">{{ laneLabel(tt) }}</th>
                  <th class="text-right font-bold py-1.5 pl-2">{{ pricedPerLane ? 'Total' : 'Cost' }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr v-for="m in matrixModels" :key="m">
                  <td class="py-1.5 pr-3 font-semibold text-carbon whitespace-nowrap">{{ modelDisplay(m).label }}</td>
                  <td v-for="tt in matrixLanes" :key="tt" class="text-right py-1.5 px-2 text-carbon-2" style="font-variant-numeric: tabular-nums">
                    <span v-if="pricedPerLane && (cellCost(m, tt) ?? 0) > 0">{{ fmtUsd(cellCost(m, tt) ?? 0) }}</span>
                    <span v-else-if="!pricedPerLane && cellTokens(m, tt) > 0">{{ fmtTokens(cellTokens(m, tt)) }}</span>
                    <span v-else class="text-carbon-3">—</span>
                  </td>
                  <td class="text-right py-1.5 pl-2 font-bold text-carbon" style="font-variant-numeric: tabular-nums">{{ fmtUsd(modelRowTotal(m)) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- Cache economics + harness overhead -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <section class="rounded-lg bg-white border border-calm-2 px-4 py-3" data-testid="session-detail-cache">
            <UiEyebrow>Cache economics</UiEyebrow>
            <p class="text-base font-bold text-carbon mt-1">
              <template v-if="detail.cache.savings_usd != null">Caching saved {{ fmtUsd(detail.cache.savings_usd) }}</template>
              <!-- Not "saved nothing": with no per-lane price there is no input
                   rate to reprice the cached tokens against. -->
              <template v-else-if="!pricedPerLane">Cache saving not priceable</template>
              <template v-else>No cache savings measurable</template>
            </p>
            <p class="text-[11px] text-carbon-3 mt-1">
              {{ hitPct != null ? hitPct + '% hit ratio' : 'no hit ratio yet' }} ·
              {{ fmtTokens(detail.cache.read_tokens) }} read · {{ fmtTokens(detail.cache.write_tokens) }} write
            </p>
          </section>

          <section class="rounded-lg bg-white border border-calm-2 px-4 py-3" data-testid="session-detail-aux">
            <UiEyebrow>Conversation vs harness</UiEyebrow>
            <ul class="mt-1 space-y-1">
              <li v-for="q in querySplit" :key="q.label" class="flex items-center justify-between text-[11px]">
                <span class="text-carbon-2">{{ q.label }}</span>
                <span class="text-carbon-3" style="font-variant-numeric: tabular-nums">{{ Math.round(q.share * 100) }}% · {{ fmtUsd(q.cost) }}</span>
              </li>
            </ul>
            <p v-if="!querySplit.length" class="text-[11px] text-carbon-3 italic mt-1">No lane split available.</p>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>
