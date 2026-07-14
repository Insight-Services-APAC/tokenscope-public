<script setup lang="ts">
/*
 * /reporting — the reporting-consolidation SHELL (build-design §1/§3).
 *
 * ONE page, scope-tabbed via UiTabs (`?scope=` URL-synced). `useReportState()`
 * is the sole owner of scope/month/region/ou ⇄ URL; the shell bootstraps from
 * `GET /reports/meta` (granted scopes + best-default) and renders the active
 * scope component. Wave 2 wires the `regional` scope; the other GRANTED tabs
 * render a "coming soon" panel (they land wave-by-wave). Client gating is UX
 * only — every endpoint re-enforces its own gate.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ReportScope } from '#shared/reports/types'

interface ReportMetaResp {
  scopes: ReportScope[]
  defaultScope: ReportScope | null
  defaultRegionId: string | null
  monthFloors: { usage: string | null; bill: string | null; reconciliation: string | null; overall: string }
  copilotMode: 'pool-utilisation' | 'chargeback'
}

const SCOPE_LABEL: Record<ReportScope, string> = {
  across: 'Across regions',
  regional: 'Regional',
  'cost-centre': 'Cost centres',
  finance: 'Finance',
}

const { data: meta, error: metaError } = await useFetch<ReportMetaResp>('/api/v1/reports/meta', {
  key: 'reports-meta',
})

const granted = computed<ReportScope[]>(() => meta.value?.scopes ?? [])
const hasScopes = computed<boolean>(() => granted.value.length > 0)
const bestScope = computed<ReportScope>(() => meta.value?.defaultScope ?? granted.value[0] ?? 'regional')

// useReportState owns the URL query. Only `scope` is shell-defaulted (best-granted)
// so a bare /reporting lands on a sensible, granted view. `region` is deliberately
// NOT defaulted here: it is a per-scope key, not a global one. Regional home-defaults
// its region server-side (resolveRegionalScope) and reflects the effective region back
// through the report; the global scopes (Finance/Across) mean whole-company and MUST
// default to region=null. A shell-wide home-region default was silently materialised
// into the URL by patch() and then inherited by Finance, narrowing its per-CoU table to
// the home region while the Σ=bill headline stayed whole-company (they stopped footing).
const rs = useReportState({
  scope: bestScope.value,
})

// The active scope must be GRANTED; an ungranted `?scope=` falls back to best +
// a one-shot notice (build-design §1). Clamp the URL on mount + on change.
const ungrantedNotice = ref<string | null>(null)
function clampScope() {
  if (granted.value.length === 0) return
  if (!granted.value.includes(rs.scope.value)) {
    ungrantedNotice.value = `You don't have access to the "${SCOPE_LABEL[rs.scope.value] ?? rs.scope.value}" report — showing ${SCOPE_LABEL[bestScope.value]}.`
    // Drop the sub-scope keys AND the period on a clamp too (mirrors the tab-switch) so a
    // region/ou/cc or an in-progress range picked under the ungranted scope can't leak into
    // the fallback scope.
    rs.patch({ scope: bestScope.value, region: null, ou: null, cc: null, month: null, from: null, to: null })
  } else {
    ungrantedNotice.value = null
  }
}
onMounted(clampScope)
watch(() => rs.scope.value, clampScope)

const activeScope = computed<ReportScope>(() =>
  granted.value.includes(rs.scope.value) ? rs.scope.value : bestScope.value,
)

const tabs = computed(() => granted.value.map((s) => ({ key: s, label: SCOPE_LABEL[s] })))
const tabModel = computed<string>({
  get: () => activeScope.value,
  set: (v) => {
    // Switching scope drops the sub-scope keys (region/ou/cc) AND the period (month +
    // from/to range) so we never carry a foreign scope's drill OR its window into a new
    // tab — e.g. a region picked in Regional must not leak into Finance/Across (both
    // whole-company), and an in-progress "This quarter" range must not leak into Finance
    // (which is retrospective) and desync its FinancePeriodControl. Each scope starts at
    // its own default period.
    rs.patch({ scope: v as ReportScope, region: null, ou: null, cc: null, month: null, from: null, to: null })
  },
})
</script>

<template>
  <div class="max-w-[1400px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Reporting"
      title="Reporting"
      sub="Usage and spend across the org — one place, scoped to what you can see."
    />

    <UiFetchErrorBanner v-if="metaError" :error="metaError" class="mb-4" />

    <template v-else-if="meta">
      <!-- Zero granted scopes (L3): render a proper empty-state, NOT the 'regional' fallback —
           an ungranted Regional view would only 403-banner. `activeScope` defaults to 'regional'
           when granted=[], so the empty-state gate must sit ahead of the scope render. -->
      <template v-if="hasScopes">
        <UiTabs v-if="tabs.length" v-model="tabModel" :tabs="tabs" data-testid="reporting-scope-tabs" />

        <div
          v-if="ungrantedNotice"
          class="mb-4 text-[12px] text-brand-heart bg-brand-hunger-lite rounded-md px-3 py-2"
          data-testid="reporting-scope-notice"
          role="status"
        >
          {{ ungrantedNotice }}
        </div>

        <!-- Scopes wired: Regional (Wave 2), Across-Regions (Wave 4), Cost-Centre
             (Wave 3), Finance (Wave 5). All four scopes now live in the reporting area. -->
        <ReportingScopeAcrossRegions v-if="activeScope === 'across'" />
        <ReportingScopeRegional v-else-if="activeScope === 'regional'" />
        <ReportingScopeCostCentre v-else-if="activeScope === 'cost-centre'" />
        <ReportingScopeFinance v-else-if="activeScope === 'finance'" />
      </template>

      <UiEmptyState
        v-else
        data-testid="reporting-no-scopes"
        headline="You don't have access to any reports"
        sub="Reports are granted by role. If you think you should have access, ask your workspace admin."
      />
    </template>
  </div>
</template>
