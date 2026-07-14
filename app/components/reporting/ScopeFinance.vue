<script setup lang="ts">
/*
 * ScopeFinance — the DATA CONTAINER + persistent header for the FINANCE (§B
 * chargeback / bill-reconciliation) scope. Owns the fetches
 * (`/reports/finance{,/[couId]}`), the URL state (via useReportState), and the
 * header (title + DateRangeControl + the ONE consolidated settling chip), then hands
 * the pure body props to ScopeFinanceView. Keeping the header here (not in the view)
 * is deliberate: the view stays bare-mountable / unit-testable, while the header —
 * which self-wires the useReportState-bound DateRangeControl — lives where the router
 * is always present.
 *
 * WINDOW: a custom `[from, to]` range wins when the DateRangeControl set one; else
 * Finance DEFAULTS to the LAST COMPLETE month (you cannot charge back a month in
 * progress). The bill/chargeback surfaces are month-grained, so a custom range picks
 * up the whole `period_month`s it spans (server side). The per-CoU DRILL windows on the
 * SAME period as the index (the full range in quarter mode), so the drill's Chargeable
 * foots to the index's per-CoU total — never to just the range's first month.
 *
 * The CoU drill reuses the shared `cc` URL key (a CoU IS a cost-owning unit); a tab
 * switch already clears `cc`, so no stale drill survives a scope change.
 */
import { computed, ref, watch } from 'vue'
import ScopeFinanceView from './ScopeFinanceView.vue'
import FinancePeriodControl from './FinancePeriodControl.vue'
import SettlingStateChip from './SettlingStateChip.vue'
import { useReportState } from '../../composables/useReportState'
import type { FinanceReport, FinanceDrill } from './finance-report-types'
import type { SettlingState } from '#shared/reports/types'

/** Last COMPLETE calendar month, `YYYY-MM` (day 0 of this month = last of prior). */
function lastCompleteMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthLabel(m: string): string {
  const d = new Date(`${m}-01T00:00:00.000Z`)
  return Number.isNaN(d.getTime())
    ? m
    : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const rs = useReportState()

// Active window: a custom range wins when BOTH bounds are set; else the finance
// month default (last complete month — an in-progress month cannot be charged back).
const isRange = computed(() => Boolean(rs.from.value && rs.to.value))
const effectiveMonth = computed(() => rs.month.value ?? lastCompleteMonth())

// The window params both the index AND the drill bind on — a custom `[from, to]` range
// in quarter mode, else the finance month default (region is index-only, added below).
const windowQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = {}
  if (isRange.value) {
    q.from = rs.from.value as string
    q.to = rs.to.value as string
  } else {
    q.month = effectiveMonth.value
  }
  return q
})

const indexQuery = computed<Record<string, string>>(() => {
  const q: Record<string, string> = { ...windowQuery.value }
  if (rs.region.value) q.region = rs.region.value
  return q
})

const {
  data: report,
  pending,
  error,
} = useFetch<FinanceReport>('/api/v1/reports/finance', {
  query: indexQuery,
  key: 'reports-finance',
  lazy: true,
  server: false,
})

// The drill is a per-`cc` (CoU) resource — fetch imperatively so a null `cc` never
// fires a request, and a missing CoU surfaces its 404 here.
const drill = ref<FinanceDrill | null>(null)
const drillPending = ref(false)
const drillError = ref<unknown>(null)
watch(
  [() => rs.cc.value, windowQuery],
  async () => {
    const cc = rs.cc.value
    if (!cc) {
      drill.value = null
      drillError.value = null
      drillPending.value = false
      return
    }
    drillPending.value = true
    drillError.value = null
    try {
      drill.value = await $fetch<FinanceDrill>(`/api/v1/reports/finance/${cc}`, {
        query: windowQuery.value,
      })
    } catch (e) {
      drillError.value = e
      drill.value = null
    } finally {
      drillPending.value = false
    }
  },
  { immediate: true },
)

// ── Header meta ──────────────────────────────────────────────────────────────
// A range produced by the period control is always a whole quarter — label it as
// such ("Q2 2026"); fall back to the raw span for any hand-crafted URL range.
function quarterLabel(from: string): string | null {
  const m = Number(from.slice(5, 7))
  if (!from.endsWith('-01') || ![1, 4, 7, 10].includes(m)) return null
  return `Q${(m - 1) / 3 + 1} ${from.slice(0, 4)}`
}
const windowLabel = computed(() => {
  if (isRange.value) {
    return quarterLabel(rs.from.value as string) ?? `${rs.from.value} → ${rs.to.value}`
  }
  return monthLabel(effectiveMonth.value)
})
// Show the "defaults to last complete month" note only in that default state.
const isDefaultMonth = computed(() => !isRange.value && effectiveMonth.value === lastCompleteMonth())

// ONE consolidated settling chip: the honest whole-lane state is the LEAST settled of
// the month's provider states (never overclaim). estimated < settling < settled.
const RANK: Record<SettlingState, number> = { estimated: 0, settling: 1, settled: 2 }
const consolidatedState = computed(() => {
  const ps = report.value?.meta.providerStates ?? []
  const first = ps[0]
  if (!first) return null
  return ps.reduce((min, p) => (RANK[p.state] < RANK[min.state] ? p : min), first)
})

// Export (ledger CSV) is month-grained (D-Q8 grain cost-centre × provider × month) —
// anchor to the window's representative (start) month in range mode.
const exportMonth = computed(() =>
  isRange.value ? (rs.from.value as string).slice(0, 7) : effectiveMonth.value,
)
const exportParams = computed(() => {
  const p: Record<string, string> = { scope: 'finance', report: 'ledger', month: exportMonth.value }
  if (rs.region.value) p.region = rs.region.value
  return p
})
const exportFilename = computed(() => `tokenscope-finance-ledger-${exportMonth.value}.csv`)
</script>

<template>
  <div data-testid="scope-finance-container">
    <!-- ── Header (persists across index / drill and every fetch state) ──────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Chargeback &amp; reconciliation
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">Finance</h2>
        <div class="mt-2 flex items-center gap-3 flex-wrap">
          <span class="text-[12px] font-semibold text-carbon-2 tabular-nums" data-testid="finance-window-label">
            {{ windowLabel }}
          </span>
          <SettlingStateChip
            v-if="consolidatedState"
            :state="consolidatedState.state"
            :horizon-date="consolidatedState.settlesAt"
            data-testid="finance-settling"
          />
          <span
            v-if="isDefaultMonth"
            class="text-[11px] text-carbon-3 italic"
          >Finance defaults to the last complete month — an in-progress month can't be charged back.</span>
        </div>
      </div>

      <FinancePeriodControl class="shrink-0" />
    </header>

    <ScopeFinanceView
      :report="report ?? null"
      :drill="drill"
      :is-drill="Boolean(rs.cc.value)"
      :pending="pending"
      :error="error"
      :drill-pending="drillPending"
      :drill-error="drillError"
      :export-params="exportParams"
      :export-filename="exportFilename"
      :ledger-month-only="isRange"
      @drill="rs.patch({ cc: $event })"
      @clear-drill="rs.patch({ cc: null })"
    />
  </div>
</template>
