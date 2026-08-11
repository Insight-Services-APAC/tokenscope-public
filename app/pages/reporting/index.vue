<script setup lang="ts">
/*
 * /reporting — the reporting-consolidation SHELL (build-design §1/§3).
 *
 * ONE page, scope-tabbed via UiTabs (`?scope=` URL-synced). `useReportState()`
 * is the sole owner of scope/month/region/ou ⇄ URL; the shell bootstraps from
 * `GET /reports/meta` (granted scopes + best-default) and renders the active
 * scope component. Client gating is UX only — every endpoint re-enforces its own gate.
 *
 * THREE TABS: Region · Cost centre · Finance. Across-Regions was a fourth and is
 * now the "All regions" first option of the Region scope's region selector
 * (04-prototype-delta.md §6) — the whole-company answer is a WIDTH of Region, not a
 * scope beside it.
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ReportScope } from '#shared/reports/types'
import { BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

interface ReportMetaResp {
  scopes: ReportScope[]
  defaultScope: ReportScope | null
  monthFloors: { usage: string | null; bill: string | null; reconciliation: string | null; overall: string }
  copilotMode: 'pool-utilisation' | 'chargeback'
  // Report-visibility policy (#19). Optional: present once meta.get.ts threads
  // the active mode through (the core agent's change). When absent or 'standard'
  // the chip is not shown — this stays non-blocking until that field lands.
  mode?: string
}

// Short labels for the non-standard visibility modes — a subtle chip on the
// reports header makes an admin-loosened policy visible rather than silent.
// Kept local (not imported from shared/auth) so this page has no hard dependency
// on the policy module; the values mirror REPORT_VISIBILITY_MODE_LABELS.
const VISIBILITY_MODE_LABEL: Record<string, string> = {
  'region-admins-see-all': 'Region admins see all',
  'all-admins-see-all': 'All admins see all',
}

const SCOPE_LABEL: Record<ReportScope, string> = {
  region: 'Region',
  'cost-centre': BU_LABEL_PLURAL,
  finance: 'Finance',
}

const { data: meta, error: metaError } = await useFetch<ReportMetaResp>('/api/v1/reports/meta', {
  key: 'reports-meta',
  retry: false,
})

const granted = computed<ReportScope[]>(() => meta.value?.scopes ?? [])
const hasScopes = computed<boolean>(() => granted.value.length > 0)
const bestScope = computed<ReportScope>(() => meta.value?.defaultScope ?? granted.value[0] ?? 'region')

// useReportState owns the URL query. Only `scope` is shell-defaulted (best-granted)
// so a bare /reporting lands on a sensible, granted view. `region` is deliberately
// NOT defaulted here: it is a per-scope key, not a global one. Regional defaults its
// region server-side (resolveRegionalScope) and reflects the effective region back
// through the report; the global scopes (Finance/Across) mean whole-company and MUST
// default to region=null. A shell-wide home-region default was silently materialised
// into the URL by patch() and then inherited by Finance, narrowing its per-CoU table to
// the home region while the Σ=bill headline stayed whole-company (they stopped footing).
// `/reports/meta` no longer even offers a region default, for the same reason.
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
/*
 * CANONICALISE a retired `?scope=`, once, on mount. `parseReportQuery` already
 * resolved `across`/`regional` to `region` (+ `region=all` for `across`), so the
 * page renders correctly either way — but until the URL itself is rewritten the
 * address bar still reads the retired value, and the link the user copies and
 * re-shares is the stale one. Writing the mapped state back is what actually
 * retires the value; without it the compatibility window never closes.
 *
 * Ordered BEFORE clampScope in the same hook: the mapped scope is what the grant
 * check must run against.
 */
function canonicaliseLegacyScope() {
  if (!rs.isLegacyScope?.value) return
  // `rs.scope` / `rs.region` are ALREADY the mapped values (parseReportQuery did the
  // mapping); writing them back is what replaces the retired value in the URL.
  rs.patch({ scope: rs.scope.value, region: rs.region.value })
}
onMounted(() => {
  canonicaliseLegacyScope()
  clampScope()
})
watch(() => rs.scope.value, clampScope)

const activeScope = computed<ReportScope>(() =>
  granted.value.includes(rs.scope.value) ? rs.scope.value : bestScope.value,
)

// Visibility-mode chip: shown only when an admin has loosened the org-wide
// policy beyond 'standard' (and meta actually carries the mode). Read-only.
const visibilityChip = computed<string | null>(() => {
  const mode = meta.value?.mode
  if (!mode || mode === 'standard') return null
  return `Visibility: ${VISIBILITY_MODE_LABEL[mode] ?? mode} · admin-configured`
})

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
      sub="Across the org — scoped to what you can see."
    />

    <div
      v-if="visibilityChip"
      class="-mt-2 mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-vision bg-brand-vision-sheer border border-brand-vision/30 rounded-full px-3 py-1"
      data-testid="reporting-visibility-chip"
    >
      {{ visibilityChip }}
    </div>

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

        <!-- Three scopes. Region owns BOTH widths behind its own region selector
             ("All regions" or one), so no view here is reachable from two tabs. -->
        <ReportingScopeRegion v-if="activeScope === 'region'" />
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
