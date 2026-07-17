<script setup lang="ts">
/*
 * Developer view (Journey 1 / design-notes §Screen 2).
 *
 * Six sections per the hi-fi: page-head greeting (Hello {firstName}.)
 * + PeriodSwitch + hero summary card + project buckets list +
 * untagged card with CLI snippet + inbox preview + recent sessions
 * table with Export CSV.
 *
 * Wired against:
 *   GET /api/v1/me/usage             (Epic 11 — extended)
 *   GET /api/v1/me/inbox?limit=3     (Epic 7)
 *   GET /api/v1/me/sessions/recent   (Epic 11 — new)
 */
import { computed, ref } from 'vue'
import type { ConnectClient } from '#shared/connect'
import { ragOf, ragLabel } from '../composables/useRagState'
import type { PeriodOption } from '../components/ui/PeriodSwitch.vue'

interface Bucket {
  project_code: string
  display_name: string
  cost_usd: string
  tokens: number
  allocation_total_usd: string
  is_active_now: boolean
  /*
   * Why this project appears in the bucket list:
   *   'assigned'    — user has a project_assignment row
   *   'contributed' — user emitted attribution_record this month (no assignment)
   *   'both'        — assignment AND attribution
   * The UI renders a chip for 'contributed' so the user understands
   * an unassigned project showing up isn't a glitch.
   */
  source: 'assigned' | 'contributed' | 'both'
  // D5: the project has ended. Its pre-end spend stays in the MTD total (kept
  // honest) but the row is collapsed into an "Ended" group in the UI.
  ended: boolean
  /** Distinct contributing clients this month (per-project brand marks). */
  tools: string[]
}

interface TaggedSpendRow {
  activity: string
  cost_usd: string
  tokens: number
  sessions: number
  /** Distinct contributing clients for this activity (brand marks). */
  tools: string[]
}
interface UnallocatedSummary {
  total_cost_usd: string
  total_tokens: number
  tagged_cost_usd: string
  untagged_cost_usd: string
  needs_tagging_count: number
  soft_cap_usd: string
  over_soft_cap: boolean
}
// §B (#142) — non-Code Claude surface spend (Chat / Cowork / Office / …):
// read-only chargeback lanes from the provider bill. No sessions, never
// taggable — rendered in the separate "Other Claude surfaces" panel.
interface SurfaceRow {
  tool: string
  label: string
  mtd_usd: string
  days: { day: string; usd: string }[]
}
interface UsageResponse {
  month_to_date: string
  total_cost_usd: string
  total_tokens: number
  total_allocation_usd: string
  base_allowance_usd: string
  total_quota_usd: string
  buckets: Bucket[]
  // Unallocated + tagged are now SERVER-computed (accurate, month-scoped, uncapped)
  // — the single source for the cards. /me/sessions/untagged is kept ONLY for the
  // needs-tagging ACTION list (its LIMIT-100/all-time list no longer skews totals).
  unallocated: UnallocatedSummary
  tagged_spend: TaggedSpendRow[]
  surfaces: SurfaceRow[]
  freshness_minutes_ago: number
  note: string
}


interface SessionRow {
  session_id: string
  instance_id: string | null
  project_id?: string | null
  project_code: string | null
  project_display_name: string | null
  // Orthogonal activity label (may be set with or without a project).
  activity?: string | null
  tool: string
  ts_start: string
  ts_last?: string
  ts_actual_end: string | null
  tokens: number
  cost_usd: string
  // false = unallocated (no project). Shown with an "unallocated" cue.
  attributed?: boolean
  // D2a: conversation spans a project-end boundary (some spend on the now-ended
  // project, some spilled to unallocated). Re-tag moves only the spilled portion.
  partly_ended?: boolean
  ended_project_code?: string | null
  // Granularity block (sprint design §3.1) — cost-share desc; [0] is dominant.
  models?: string[]
  by_model?: { model: string; tokens: number; cost_usd: string }[]
}

const { session, ensure } = useSession()
await ensure()

const period = ref<'mtd' | '7d' | '30d' | 'prior'>('mtd')

// Non-MTD windows land with the velocity worker in MVP-Final Epic 12 —
// disable here so a curious user gets a tooltip instead of a silent
// no-op re-fetch. Per the MVP-Lite "disabled-with-tooltip > silent
// placeholder" lesson.
const PERIOD_OPTIONS: PeriodOption[] = [
  { key: 'mtd', label: 'MTD' },
  { key: '7d', label: 'Last 7 days', disabledReason: 'Coming soon — only month-to-date is wired today.' },
  { key: '30d', label: 'Last 30 days', disabledReason: 'Coming soon — only month-to-date is wired today.' },
  { key: 'prior', label: 'Prior month', disabledReason: 'Coming soon — only month-to-date is wired today.' },
]

// FE-2/FE-10: usage is the page's headline figure — keep it awaited (SSR-
// rendered); every other fetch below is `lazy` (they all have zero-filled
// defaults and render progressively), so SSR no longer serialises six
// round-trips. Each fetch's `error` is surfaced as a visible retry banner —
// a failed fetch must never read as a confident "$0.00".
const { data: usage, refresh: refreshUsage, error: usageError } = await useFetch<UsageResponse>(
  '/api/v1/me/usage',
  {
    default: () => ({
      month_to_date: '',
      total_cost_usd: '0.00',
      total_tokens: 0,
      total_allocation_usd: '0.00',
      base_allowance_usd: '0.00',
      total_quota_usd: '0.00',
      buckets: [],
      unallocated: {
        total_cost_usd: '0.00',
        total_tokens: 0,
        tagged_cost_usd: '0.00',
        untagged_cost_usd: '0.00',
        needs_tagging_count: 0,
        soft_cap_usd: '0.00',
        over_soft_cap: false,
      },
      tagged_spend: [],
      surfaces: [],
      freshness_minutes_ago: 0,
      note: '',
    }),
  },
)

const { data: recent, refresh: refreshRecent, error: recentError } = useFetch<{ sessions: SessionRow[] }>(
  '/api/v1/me/sessions/recent?limit=10',
  { default: () => ({ sessions: [] }), lazy: true },
)

// Quarantined ("unverified") spend — sessions whose claimed instance has no
// covering /bearer heartbeat (the cross-instance-spoof signal, maintained by the
// heartbeat-coverage worker). INFORMATIONAL only: pending reconciliation, nothing
// is revoked or deleted. We build a (session|instance) key set so the recent table
// can flag matching rows with an "unverified" badge.
interface QuarantinedRow {
  session_id: string
  instance_id: string
  cost_usd: string
}
const { data: quarantined, refresh: refreshQuarantined, error: quarantinedError } = useFetch<{ sessions: QuarantinedRow[] }>(
  '/api/v1/me/quarantined-spend',
  { default: () => ({ sessions: [] }), lazy: true },
)
const quarantinedKeys = computed(
  () => new Set((quarantined.value?.sessions ?? []).map((q) => `${q.session_id}|${q.instance_id}`)),
)
function isQuarantined(s: SessionRow): boolean {
  return s.instance_id != null && quarantinedKeys.value.has(`${s.session_id}|${s.instance_id}`)
}

// Untagged OTel sessions (the retroactive-tagging worklist) + my assignable
// projects (the quick-assign picker). See client-attribution-auth-spec §4.
interface UntaggedSession {
  session_id: string
  instance_id: string | null
  first_event: string
  last_event: string
  tokens: number
  cost_usd: string
  models: string[]
  by_model?: { model: string; tokens: number; cost_usd: string }[]
  // Activity-only tag echoed back (mig 0020) — set but still project-untagged.
  activity: string | null
  // Which client emitted it (claude-code / copilot-cli) — tells the dev where to look.
  tool: string
}
// §A — per-day "unaccounted usage" records: provider-API truth OTel never captured
// (e.g. an un-enrolled container). One taggable item per (teammate, day, tool), returned
// alongside the untagged sessions. Tagged via /me/unaccounted/{id}/assign (same body as a
// session). See docs/design/provider-billing-attribution-model.md §A.
interface UnaccountedRow {
  id: string
  day: string
  tool: string
  cost_usd: string
  tokens: number
}
const { data: untagged, refresh: refreshUntagged, error: untaggedError } = useFetch<{ sessions: UntaggedSession[]; unaccounted: UnaccountedRow[] }>(
  '/api/v1/me/sessions/untagged',
  { default: () => ({ sessions: [], unaccounted: [] }), lazy: true },
)
const unaccounted = computed(() => untagged.value?.unaccounted ?? [])

// §A — OPEN over-emission flags: days where the caller's OTel-reported usage materially
// EXCEEDS the provider API truth (uncorroborated; possibly a forged/mis-tagged emission).
// Rare — the section only renders when flags exist. Each flag carries the day's sessions
// (cost desc) so the dev can flag the outlier, accept, or escalate via
// /me/over-emission/{id}/resolve.
interface OverEmissionSession {
  conversation_id: string
  cost_usd: string
  tokens: number
  first_event: string
  last_event: string
}
interface OverEmissionFlag {
  id: string
  day: string
  tool: string
  otel_usd: string
  api_usd: string
  over_usd: string
  sessions: OverEmissionSession[]
}
const { data: overEmission, refresh: refreshOverEmission, error: overEmissionError } = useFetch<{ flags: OverEmissionFlag[] }>(
  '/api/v1/me/over-emission',
  { default: () => ({ flags: [] }), lazy: true },
)
const overEmissionFlags = computed(() => overEmission.value?.flags ?? [])
const { data: myProjects, refresh: refreshMyProjects, error: myProjectsError } = useFetch<{ projects: { id: string; code: string; display_name: string; type: string }[] }>(
  '/api/v1/me/projects',
  { default: () => ({ projects: [] }), lazy: true },
)
const { data: activityTypes, refresh: refreshActivityTypes, error: activityTypesError } = useFetch<{ activity_types: { label: string; is_standard: boolean; is_mine: boolean }[] }>(
  '/api/v1/me/activity-types',
  { default: () => ({ activity_types: [] }), lazy: true },
)
// The universal tag/re-tag editor target (null = closed). Set from a needs-tagging
// "Tag" or a recent "Re-tag"; TagSessionDialog owns the form + the save call.
// Shape matches TagSessionDialog's prop (structurally typed).
interface TagTarget {
  session_id: string
  instance_id: string | null
  tool: string
  cost_usd: string | number
  tokens: number
  last_event: string
  project_id: string | null
  activity: string | null
  by_model?: { model: string; tokens: number; cost_usd: string }[]
  // §A — set for per-day "unaccounted usage" records so the SAME dialog POSTs to
  // /me/unaccounted/{id}/assign and renders a day (not a session) subject.
  assign_url?: string
  subject_kind?: 'session' | 'day'
  subject_label?: string
}
const tagSession = ref<TagTarget | null>(null)
// Which client's connect pop-up is open (null = closed). Opened by the
// "Connect Claude" / "Connect Copilot" buttons in the page head.
const connectClient = ref<ConnectClient | null>(null)
function openTag(t: TagTarget) {
  tagSession.value = t
}
async function onTagSaved() {
  tagSession.value = null
  await Promise.all([refreshUntagged(), refreshUsage(), refreshRecent()])
}

// §A — open the SAME tag dialog for a per-day unaccounted-usage record. Reuses the
// project/activity picker; only the POST target + subject display differ.
function openTagUnaccounted(u: UnaccountedRow) {
  tagSession.value = {
    session_id: u.id,
    instance_id: null,
    tool: u.tool,
    cost_usd: u.cost_usd,
    tokens: u.tokens,
    last_event: u.day,
    project_id: null,
    activity: null,
    assign_url: `/api/v1/me/unaccounted/${u.id}/assign`,
    subject_kind: 'day',
    subject_label: u.day,
  }
}

// §A — resolve an over-emission flag (quarantine the suspect session / accept / escalate).
// Quarantining changes the totals, so on success we refresh BOTH the over-emission list and
// the usage/untagged fetches. resolvingFlag guards against double-submits.
const resolvingFlag = ref<string | null>(null)
const overEmissionResolveError = ref<string | null>(null)
async function resolveOverEmission(
  id: string,
  action: 'quarantine' | 'accept' | 'escalate',
  conversationId?: string,
) {
  if (resolvingFlag.value) return
  resolvingFlag.value = id
  overEmissionResolveError.value = null
  try {
    await $fetch(`/api/v1/me/over-emission/${id}/resolve`, {
      method: 'POST',
      body: { action, ...(conversationId ? { conversation_id: conversationId } : {}) },
    })
    await Promise.all([refreshOverEmission(), refreshUsage(), refreshUntagged(), refreshRecent()])
  } catch (e: unknown) {
    overEmissionResolveError.value = apiErrorDetail(e, 'Could not resolve this flag')
  } finally {
    resolvingFlag.value = null
  }
}

const firstName = computed(() => {
  const dn = session.value?.displayName ?? ''
  return dn.split(/[\s]+/)[0] ?? 'there'
})

const monthLabel = computed(() => {
  if (!usage.value?.month_to_date) return ''
  const [y, m] = usage.value.month_to_date.split('-')
  if (!y || !m) return usage.value.month_to_date
  const d = new Date(Number(y), Number(m) - 1, 1)
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' })
})

const sortedBuckets = computed<Array<Bucket & { pct: number }>>(() => {
  const buckets = usage.value?.buckets ?? []
  return [...buckets]
    .map((b) => {
      const alloc = Number(b.allocation_total_usd)
      const used = Number(b.cost_usd)
      const pct = alloc > 0 ? used / alloc : 0
      return { ...b, pct }
    })
    // Ended projects sink to the bottom (D5 collapse) — still shown (their
    // pre-end spend is real MTD), just out of the active group.
    .sort(
      (a, b) =>
        Number(a.ended) - Number(b.ended) ||
        b.pct - a.pct ||
        Number(b.cost_usd) - Number(a.cost_usd),
    )
})

const totals = computed(() => {
  const u = usage.value
  // Budgeted lane only. Unallocated is now SERVER-composed (usage.unallocated;
  // see getUnallocatedSummary) — not the client-side ledger sum. Health = worst
  // lane (see heroWorstPct).
  const projectSpend = Number(u?.total_cost_usd ?? 0)
  const allocations = Number(u?.total_allocation_usd ?? 0)
  const base = Number(u?.base_allowance_usd ?? 0)
  const projectPct = allocations > 0 ? projectSpend / allocations : 0
  return { projectSpend, allocations, base, projectPct }
})

// Unallocated/tagged totals are now SERVER-computed (accurate, month-scoped,
// uncapped) — usage.unallocated / usage.tagged_spend. The /me/sessions/untagged
// list is kept ONLY for the needs-tagging ACTION list (the assignable cards), so
// a >100-session or prior-month tail no longer skews the headline totals.
const needsTaggingSessions = computed(() => (untagged.value?.sessions ?? []).filter((s) => !s.activity))
const unallocatedTotal = computed(() => Number(usage.value?.unallocated?.total_cost_usd ?? 0))
const spillTotal = computed(() => Number(usage.value?.unallocated?.tagged_cost_usd ?? 0))
const needsTaggingTotal = computed(() => Number(usage.value?.unallocated?.untagged_cost_usd ?? 0))
const needsTaggingCount = computed(() => usage.value?.unallocated?.needs_tagging_count ?? 0)
// Tagged (off-budget) spend rolled up BY activity (server-computed). `tools` is
// the distinct set of contributing clients for the activity (claude-code /
// copilot-cli), driving the per-activity brand marks.
const spillByActivity = computed(() =>
  (usage.value?.tagged_spend ?? []).map((t) => ({
    activity: t.activity,
    total: Number(t.cost_usd),
    count: t.sessions,
    tools: t.tools?.length ? t.tools : ['claude-code'],
  })),
)

// fmtUsd / fmtTokens / fmtTimeAgo / clientMeta are auto-imported from
// ~/composables/useFormat (shared with TagSessionDialog).
const unallocatedPct = computed(() => (totals.value.base > 0 ? unallocatedTotal.value / totals.value.base : 0))
// Overall health = worst of the two lanes (budgeted % vs unallocated-vs-base %).
const heroWorstPct = computed(() => Math.max(totals.value.projectPct, unallocatedPct.value))
const recentCollapsed = ref(false) // open by default — it was too easy to miss collapsed

function toolPillProp(tool: string): 'CC' | 'Cop' | 'Mixed' {
  if (tool === 'copilot-cli') return 'Cop'
  if (tool === 'mixed') return 'Mixed'
  return 'CC'
}

function exportCsv() {
  // Open the CSV export endpoint via direct navigation — browser
  // handles the Content-Disposition. No extra blob plumbing.
  if (import.meta.client) {
    window.location.href = '/api/v1/me/sessions/recent/export?limit=100'
  }
}

// Period switcher is wired but the server slice in MVP-Final returns
// MTD only — refresh on change as a no-op until Epic 12 brings the
// window-shifted variants online.
async function onPeriodChange(v: string) {
  period.value = v as typeof period.value
  await refreshUsage()
}
</script>

<template>
  <div class="max-w-[1440px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      :title="`Hello ${firstName}.`"
      :sub="`Here's your token spend for ${monthLabel}.`"
    >
      <template #actions>
        <div class="flex flex-col items-end gap-3">
          <!-- Connect tools — compact, brand-marked, top-right above the period
               switch. Both Claude Code and Copilot CLI are live; each opens a
               small pop-up with the same per-client setup instructions shown on
               /account (shared ConnectClientGuide → no drift). -->
          <div class="flex flex-wrap items-center gap-2 justify-end" data-testid="home-connect-tools">
            <button
              type="button"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#D97757]/40 bg-[#D97757]/5 hover:bg-[#D97757]/12 transition-colors text-sm font-semibold text-carbon cursor-pointer"
              data-testid="connect-claude"
              @click="connectClient = 'claude-code'"
            >
              <Icon name="logos:claude-icon" class="text-base" aria-hidden="true" />
              Connect Claude Code
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-carbon/15 bg-carbon/5 hover:bg-carbon/10 transition-colors text-sm font-semibold text-carbon cursor-pointer"
              data-testid="connect-copilot"
              @click="connectClient = 'copilot-cli'"
            >
              <Icon name="logos:github-copilot" class="text-base" aria-hidden="true" />
              Connect Copilot
            </button>
          </div>
          <UiPeriodSwitch
            :model-value="period"
            :options="PERIOD_OPTIONS"
            @update:model-value="onPeriodChange"
          />
        </div>
      </template>
    </UiPageHead>

    <!-- FE-2: fetch failures surface as retry banners — never a silent $0.00. -->
    <UiFetchErrorBanner :error="usageError" label="your usage summary" @retry="refreshUsage" />
    <UiFetchErrorBanner :error="untaggedError" label="your untagged sessions" @retry="refreshUntagged" />
    <UiFetchErrorBanner :error="overEmissionError" label="uncorroborated-usage flags" @retry="refreshOverEmission" />
    <UiFetchErrorBanner :error="recentError" label="your recent sessions" @retry="refreshRecent" />
    <UiFetchErrorBanner :error="quarantinedError" label="unverified-spend flags" @retry="refreshQuarantined" />
    <UiFetchErrorBanner :error="myProjectsError" label="your assignable projects" @retry="refreshMyProjects" />
    <UiFetchErrorBanner :error="activityTypesError" label="the activity-tag vocabulary" @retry="refreshActivityTypes" />

    <!-- Hero summary -->
    <UiCard accent="harmony" class="mb-6 brand-wash" data-testid="hero-summary">
      <div class="flex items-start justify-between gap-4 mb-4">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          This month · spend vs budget
        </div>
        <UiBadge :kind="`rag-${ragOf(heroWorstPct)}`" data-testid="hero-status">
          {{ ragLabel(heroWorstPct) }}
        </UiBadge>
      </div>

      <!-- Two measurement lines: budgeted (allocated, primary) and unallocated
           (spill + untagged, secondary). They are NOT one pooled bar — different
           denominators, different meaning. -->
      <div class="grid md:grid-cols-2 gap-6">
        <!-- PRIMARY: budgeted / allocated -->
        <div class="md:border-r md:border-brand-harmony/10 md:pr-6">
          <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Budgeted · {{ usage?.buckets.length ?? 0 }} {{ usage?.buckets.length === 1 ? 'budget' : 'budgets' }}</div>
          <div class="text-[40px] font-bold tracking-[-1.5px] text-carbon mt-1 leading-[1]" style="font-variant-numeric: tabular-nums">
            {{ fmtUsd(totals.projectSpend) }}
            <span v-if="totals.allocations > 0" class="text-xl text-carbon-3 font-medium">/ {{ fmtUsd(totals.allocations) }}</span>
            <span v-else class="text-base text-carbon-3 font-medium align-middle"> · no budget allocated</span>
          </div>
          <UiPbar v-if="totals.allocations > 0" :pct="totals.projectPct" size="lg" class="mt-3" />
          <div v-else class="h-2 mt-3 rounded-full bg-calm/40" title="No allocation on these projects yet" />
          <div class="text-[11px] text-carbon-3 mt-1.5" style="font-variant-numeric: tabular-nums">
            <template v-if="totals.allocations > 0">{{ Math.round(totals.projectPct * 100) }}% of allocated · </template>
            {{ fmtTokens(usage?.total_tokens ?? 0) }} tokens
          </div>
        </div>

        <!-- SECONDARY: unallocated (spill + untagged) -->
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Unallocated · soft cap {{ fmtUsd(totals.base) }}</div>
          <div class="text-[40px] font-bold tracking-[-1.5px] text-carbon mt-1 leading-[1]" style="font-variant-numeric: tabular-nums">
            {{ fmtUsd(unallocatedTotal) }}
          </div>
          <UiPbar :pct="unallocatedPct" size="lg" class="mt-3" />
          <div class="text-[12px] text-carbon-2 mt-1.5 flex flex-wrap gap-x-3" style="font-variant-numeric: tabular-nums">
            <span>tagged {{ fmtUsd(spillTotal) }}</span>
            <span :class="needsTaggingTotal > 0 ? 'text-brand-zeal font-semibold' : ''">untagged {{ fmtUsd(needsTaggingTotal) }}</span>
            <span v-if="needsTaggingCount" class="text-brand-zeal font-semibold">· {{ needsTaggingCount }} need tagging ↓</span>
          </div>
        </div>
      </div>
      <UiFreshness :minutes="usage?.freshness_minutes_ago ?? 0" class="mt-4" />
    </UiCard>

    <!-- Two columns: budgeted project spend (left) vs spill — tagged but not on a
         budget (right). Uses the page width and reads as the allocated/unallocated
         contrast the model is built on. -->
    <div class="grid lg:grid-cols-3 gap-5 mb-6">
      <!-- LEFT: budgeted project spend — the primary focus, gets 2/3 width. -->
      <UiCard flush class="lg:col-span-2">
        <div class="px-6 pt-6 pb-4 border-b border-calm-2 flex items-end justify-between gap-4">
          <div>
            <div class="text-lg font-bold text-carbon">Your budgeted spend</div>
            <div class="text-xs text-carbon-3 mt-1">Spend against allocated budgets, highest % first.</div>
          </div>
          <NuxtLink to="/inbox" class="text-xs text-brand-harmony font-bold hover:underline shrink-0">
            Alerts →
          </NuxtLink>
        </div>
        <UiEmptyState
          v-if="sortedBuckets.length === 0"
          headline="No project assignments yet"
          sub="Ask your admin to assign you to a project; it'll show here."
        />
        <ul v-else class="divide-y divide-calm-2" data-testid="project-bucket-list">
          <li
            v-for="bucket in sortedBuckets"
            :key="bucket.project_code"
            class="px-6 py-4"
            :data-active="bucket.is_active_now ? 'true' : 'false'"
            :data-ended="bucket.ended ? 'true' : 'false'"
            :class="bucket.ended ? 'opacity-70' : ''"
            :data-testid="`usage-bucket-${bucket.project_code}`"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-bold text-carbon truncate">{{ bucket.display_name }}</span>
                  <span
                    v-if="bucket.ended"
                    class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-calm-2 text-carbon-2"
                    title="This project has ended. Its pre-end spend is still counted; new spend spills to unallocated until re-tagged."
                    data-testid="ended-badge"
                  >
                    Ended
                  </span>
                  <!-- Contributing client(s) — one small brand mark per distinct
                       client that contributed this month (Claude Code / Copilot CLI),
                       from bucket.tools. Empty (assigned, no spend yet) → no mark. -->
                  <span
                    v-if="bucket.tools.length"
                    class="inline-flex items-center gap-1 shrink-0"
                    :aria-label="bucket.tools.map((t) => clientMeta(t).name).join(', ') + ' contributed'"
                    data-testid="bucket-clients"
                  >
                    <Icon
                      v-for="t in bucket.tools"
                      :key="t"
                      :name="clientMeta(t).icon"
                      class="text-sm"
                      :title="clientMeta(t).name"
                    />
                  </span>
                  <span
                    v-if="bucket.is_active_now"
                    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold bg-brand-zeal-lite text-[#0b7290]"
                    data-testid="active-now-badge"
                  >
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-brand-zeal animate-pulse" aria-hidden="true" />
                    Active
                  </span>
                  <span
                    v-if="bucket.source === 'contributed'"
                    class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-brand-hunger-lite text-brand-heart"
                    title="You contributed spend to this project this month but aren't formally assigned to it."
                    data-testid="contributed-badge"
                  >
                    Contributed
                  </span>
                </div>
                <div class="text-[11px] text-carbon-3 font-mono mt-0.5">{{ bucket.project_code }}</div>
              </div>
              <div class="text-right shrink-0" style="font-variant-numeric: tabular-nums">
                <div class="text-sm font-bold text-carbon">{{ fmtUsd(bucket.cost_usd) }}</div>
                <div class="text-[11px] text-carbon-3">{{ Number(bucket.allocation_total_usd) > 0 ? '/ ' + fmtUsd(bucket.allocation_total_usd) : 'no budget' }}</div>
              </div>
            </div>
            <div class="flex items-center gap-2 mt-2">
              <template v-if="Number(bucket.allocation_total_usd) > 0">
                <UiPbar :pct="bucket.pct" size="lg" class="flex-1" />
                <UiRagChip :pct="bucket.pct" />
              </template>
              <span v-else class="flex-1 text-right text-[11px] text-carbon-3">no budget set</span>
            </div>
          </li>
        </ul>
      </UiCard>

      <!-- RIGHT: tagged-but-unbudgeted spend (the canonical "spill" lane in
           finance terms — rolls to the practice Spill Bucket — but labelled plainly
           for the developer). Still re-assignable to a project. -->
      <UiCard flush data-testid="spill-card">
        <div class="px-6 pt-6 pb-4 border-b border-calm-2 flex items-end justify-between gap-4">
          <div>
            <div class="text-lg font-bold text-carbon">Tagged spend</div>
            <div class="text-xs text-carbon-3 mt-1">Categorised with an activity, not on a budget.</div>
          </div>
          <span class="text-lg font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(spillTotal) }}</span>
        </div>
        <ul v-if="spillByActivity.length" class="divide-y divide-calm-2">
          <li
            v-for="row in spillByActivity"
            :key="row.activity"
            class="px-6 py-3.5 flex items-center justify-between gap-3"
            :data-testid="`tagged-${row.activity}`"
          >
            <div class="min-w-0">
              <div class="text-sm font-semibold text-carbon capitalize truncate">{{ row.activity }}</div>
              <div class="flex items-center gap-1.5 mt-1">
                <Icon
                  v-for="t in row.tools"
                  :key="t"
                  :name="clientMeta(t).icon"
                  class="text-sm"
                  :title="clientMeta(t).name"
                />
                <span class="text-[11px] text-carbon-3">{{ row.count }} {{ row.count === 1 ? 'session' : 'sessions' }}</span>
              </div>
            </div>
            <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(row.total) }}</span>
          </li>
        </ul>
        <div v-else class="px-6 py-10 text-center text-xs text-carbon-2">
          Nothing tagged off-budget — your categorised spend is all on a budget.
        </div>
      </UiCard>
    </div>


    <!-- NEEDS TAGGING: genuinely untagged (no project, no activity) — the action
         list. Tagged-but-unbudgeted spend lives in the calm Spill card below. -->
    <UiCard accent="zeal" data-testid="untagged-card" class="mb-4">
      <!-- Headline COUNT + TOTAL are the authoritative server figures (this month,
           uncapped); the grid below shows the (capped) actionable session list, so
           the two come from different populations — surface "showing N most recent"
           when the month count exceeds the shown list (adversarial R: card/total
           source mismatch). -->
      <div class="flex items-baseline gap-3">
        <UiEyebrow>Needs tagging</UiEyebrow>
        <span v-if="needsTaggingCount" class="text-2xl font-bold text-brand-zeal" style="font-variant-numeric: tabular-nums">{{ fmtUsd(needsTaggingTotal) }}</span>
      </div>
      <p v-if="needsTaggingCount" class="text-xs text-carbon-2 mt-2">
        {{ needsTaggingCount }}
        {{ needsTaggingCount === 1 ? 'session' : 'sessions' }} this month with no project or activity — assign a project, tag an activity, or both.<span v-if="needsTaggingCount > needsTaggingSessions.length" class="text-carbon-3"> Showing the {{ needsTaggingSessions.length }} most recent.</span>
      </p>
      <p v-else-if="needsTaggingSessions.length" class="text-xs text-carbon-2 mt-2">
        Untagged sessions from earlier — still taggable below.
      </p>

      <!-- 2-column grid of compact cards — each half-width, so the Tag button sits
           right next to its session (no full-width ocean). The list just flows into
           a second column; "Tag" opens the focused dialog (below). -->
      <div v-if="needsTaggingSessions.length" class="mt-3 grid md:grid-cols-2 gap-2" data-testid="untagged-sessions">
        <div
          v-for="s in needsTaggingSessions"
          :key="s.session_id"
          class="flex items-center gap-3 rounded-lg border border-brand-zeal-lite/70 bg-white/70 px-3 py-2.5"
          :data-testid="`untagged-${s.session_id}`"
        >
          <Icon :name="clientMeta(s.tool).icon" class="text-base shrink-0" :title="clientMeta(s.tool).name" />
          <div class="min-w-0 flex-1">
            <div class="text-xs text-carbon truncate">
              <span class="font-semibold">{{ clientMeta(s.tool).name }}</span>
              <span class="text-carbon-3"> · {{ fmtTimeAgo(s.last_event) }} · {{ fmtTokens(s.tokens) }}</span>
              <UsageModelBadge :by-model="s.by_model" class="ml-1.5 align-middle" />
            </div>
            <div class="text-[11px] text-carbon-3 mt-0.5">
              Session <span class="font-mono text-carbon-2">{{ s.session_id.slice(0, 13) }}</span>
            </div>
          </div>
          <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(s.cost_usd) }}</span>
          <UiButton
            kind="primary"
            size="sm"
            :data-testid="`tag-${s.session_id}`"
            @click="openTag({ session_id: s.session_id, instance_id: s.instance_id, tool: s.tool, cost_usd: s.cost_usd, tokens: s.tokens, last_event: s.last_event, project_id: null, activity: s.activity, by_model: s.by_model })"
          >
            Tag
          </UiButton>
        </div>
      </div>
      <p v-else-if="!unaccounted.length" class="text-xs text-carbon-2 mt-3">
        Nothing needs tagging — all your spend is on a project or categorised. 🎉
      </p>

      <!-- §A — UNACCOUNTED USAGE: per-day records the provider's API counted but OTel
           didn't capture (e.g. an un-enrolled container). Part of the same needs-tagging
           worklist, but the unit is a DAY (no session id), so it's visually distinct from
           the session cards above. Tagged via the SAME dialog → /me/unaccounted/{id}/assign.
           Their cost is already in the server-computed hero total, so we render the items
           without re-summing into a client-side "needs tagging" figure (no double-count). -->
      <div v-if="unaccounted.length" class="mt-5 pt-4 border-t border-brand-zeal-lite/70" data-testid="unaccounted-section">
        <p class="text-xs text-carbon-2">
          Usage the provider's API counted that your OTel didn't — tag each day to a project, same as a session.
        </p>
        <div class="mt-3 grid md:grid-cols-2 gap-2">
          <div
            v-for="u in unaccounted"
            :key="u.id"
            class="flex items-center gap-3 rounded-lg border border-dashed border-brand-zeal-lite/90 bg-brand-zeal-lite/15 px-3 py-2.5"
            :data-testid="`unaccounted-row-${u.id}`"
          >
            <Icon :name="clientMeta(u.tool).icon" class="text-base shrink-0" :title="clientMeta(u.tool).name" />
            <div class="min-w-0 flex-1">
              <div class="text-xs text-carbon truncate">
                <span class="font-semibold">{{ u.day }}</span>
                <span class="text-carbon-3"> · {{ clientMeta(u.tool).name }} · {{ fmtTokens(u.tokens) }}</span>
              </div>
              <div class="text-[11px] text-carbon-3 mt-0.5">
                Usage the provider recorded but OTel didn't capture (e.g. an un-enrolled container).
              </div>
            </div>
            <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(u.cost_usd) }}</span>
            <UiButton
              kind="primary"
              size="sm"
              :data-testid="`unaccounted-tag-${u.id}`"
              @click="openTagUnaccounted(u)"
            >
              Tag
            </UiButton>
          </div>
        </div>
      </div>

    </UiCard>

    <!-- §A — NEEDS REVIEW: uncorroborated (over-emission) usage. Days where the caller's
         OTel-reported usage EXCEEDS the provider API truth — possibly a forged/mis-tagged
         emission. Rare: only rendered when there are open flags. The API has no session ids,
         so the system never auto-picks the outlier — the dev reviews the day's sessions and
         flags the wrong one, accepts the lot, or escalates. /me/over-emission/{id}/resolve. -->
    <UiCard v-if="overEmissionFlags.length" accent="harmony" data-testid="over-emission-section" class="mb-4">
      <UiEyebrow>Needs review · uncorroborated usage</UiEyebrow>
      <p class="text-xs text-carbon-2 mt-2">
        On these days your tools reported more than the provider's bill confirms. Review the sessions and either flag the one that's wrong, mark it correct, or escalate.
      </p>
      <p v-if="overEmissionResolveError" class="text-xs text-rag-red mt-2" role="alert" data-testid="over-emission-error">
        {{ overEmissionResolveError }}
      </p>

      <div class="mt-3 space-y-3">
        <div
          v-for="f in overEmissionFlags"
          :key="f.id"
          class="rounded-lg border border-rag-amber/30 bg-rag-amber/5 px-4 py-3"
          :data-testid="`over-emission-flag-${f.id}`"
        >
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="text-sm text-carbon">
              <Icon :name="clientMeta(f.tool).icon" class="text-base align-middle mr-1" :title="clientMeta(f.tool).name" />
              <span class="font-bold">{{ f.day }}</span>:
              your tools reported <span class="font-semibold">{{ fmtUsd(f.otel_usd) }}</span>,
              the provider bill is <span class="font-semibold">{{ fmtUsd(f.api_usd) }}</span> —
              <span class="font-bold text-rag-amber">{{ fmtUsd(f.over_usd) }}</span> is uncorroborated.
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="resolvingFlag === f.id"
                :data-testid="`over-emission-accept-${f.id}`"
                @click="resolveOverEmission(f.id, 'accept')"
              >
                It's all correct
              </UiButton>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="resolvingFlag === f.id"
                :data-testid="`over-emission-escalate-${f.id}`"
                @click="resolveOverEmission(f.id, 'escalate')"
              >
                Escalate
              </UiButton>
            </div>
          </div>

          <ul v-if="f.sessions.length" class="mt-3 divide-y divide-rag-amber/15 rounded-md border border-rag-amber/15 bg-white/60">
            <li
              v-for="s in f.sessions"
              :key="s.conversation_id"
              class="flex items-center gap-3 px-3 py-2.5"
            >
              <div class="min-w-0 flex-1">
                <div class="text-xs text-carbon truncate">
                  <span class="font-mono text-carbon-2">{{ s.conversation_id.slice(0, 13) }}</span>
                  <span class="text-carbon-3"> · {{ fmtTokens(s.tokens) }} tokens</span>
                </div>
                <div class="text-[11px] text-carbon-3 mt-0.5">
                  {{ fmtTimeAgo(s.first_event) }} → {{ fmtTimeAgo(s.last_event) }}
                </div>
              </div>
              <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(s.cost_usd) }}</span>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="resolvingFlag === f.id"
                :data-testid="`over-emission-quarantine-${s.conversation_id}`"
                @click="resolveOverEmission(f.id, 'quarantine', s.conversation_id)"
              >
                Flag as wrong
              </UiButton>
            </li>
          </ul>
          <p v-else class="text-[11px] text-carbon-3 mt-2">
            No sessions on record for this day — accept or escalate to resolve.
          </p>
        </div>
      </div>
    </UiCard>

    <!-- Recent sessions -->
    <UiCard flush data-testid="recent-sessions">
      <div class="px-6 pt-6 pb-4 border-b border-calm-2 flex items-center justify-between gap-4">
        <button class="flex items-center gap-2.5 text-left group" data-testid="recent-toggle" :aria-expanded="!recentCollapsed" @click="recentCollapsed = !recentCollapsed">
          <Icon
            name="tabler:chevron-down"
            class="text-lg text-carbon-3 transition-transform group-hover:text-carbon"
            :class="recentCollapsed ? '-rotate-90' : ''"
          />
          <div>
            <div class="text-lg font-bold text-carbon group-hover:text-brand-harmony transition-colors">Recent sessions</div>
            <div class="text-xs text-carbon-3 mt-0.5">Last 10 by most recent activity. Tokens summed from attribution_record.</div>
          </div>
        </button>
        <UiButton v-if="!recentCollapsed" kind="ghost" size="sm" data-testid="export-csv" @click="exportCsv">
          Export CSV
        </UiButton>
      </div>
      <UiEmptyState
        v-if="!recentCollapsed && !recent?.sessions?.length"
        headline="No sessions yet"
        sub="Run `claude` in a `.tokenscope`-bearing repo, then the `project` MCP prompt — the session will land here within a minute."
      />
      <div v-else-if="!recentCollapsed" class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-[11px] text-carbon-3 uppercase tracking-[1.2px]">
            <tr class="bg-brand-harmony-sheer/40">
              <th class="text-left font-bold px-6 py-3">Conversation</th>
              <th class="text-left font-bold px-6 py-3">Instance</th>
              <th class="text-left font-bold px-6 py-3">Project</th>
              <th class="text-left font-bold px-6 py-3">Tool</th>
              <th class="text-left font-bold px-6 py-3">When</th>
              <th class="text-right font-bold px-6 py-3">Tokens</th>
              <th class="text-right font-bold px-6 py-3">Cost</th>
              <th class="px-6 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-calm-2">
            <tr v-for="s in recent.sessions" :key="s.session_id + '|' + (s.project_code ?? '')">
              <td class="px-6 py-3 font-mono text-[12px] text-carbon">
                {{ s.session_id.slice(0, 12) }}
              </td>
              <td
                class="px-6 py-3 font-mono text-[11px] text-carbon-3"
                :title="s.instance_id ?? ''"
              >
                {{ s.instance_id ? s.instance_id.slice(0, 8) : '—' }}
              </td>
              <td class="px-6 py-3">
                <span class="font-semibold text-carbon">{{ s.project_code ?? '—' }}</span>
                <span
                  v-if="!s.attributed"
                  class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm/50 text-carbon-3"
                  title="No budget — unallocated spend. Re-tag to assign it."
                >unallocated</span>
                <!-- D2a split cue: spans a project-end boundary. Re-tag moves
                     only the spilled portion; the ended project keeps its pre-end rows. -->
                <span
                  v-if="s.partly_ended"
                  class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm-2 text-carbon-2"
                  :title="`Part of this conversation ran on ${s.ended_project_code ?? 'an ended project'} (now ended). Re-tagging moves only the spilled portion.`"
                  data-testid="partly-ended-badge"
                >partly on ended {{ s.ended_project_code ?? 'project' }}</span>
                <!-- Orthogonal activity label (mig 0020), if tagged. -->
                <span
                  v-if="s.activity"
                  class="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-zeal-lite/60 text-carbon-2"
                  :title="`Activity: ${s.activity}`"
                >{{ s.activity }}</span>
                <!-- Heartbeat-coverage cue: this session claims an instance with no
                     covering /bearer heartbeat → "unverified spend" (the cross-
                     instance-spoof signal). INFORMATIONAL — pending reconciliation,
                     which is what confirms or wipes it. Nothing is revoked here. -->
                <span
                  v-if="isQuarantined(s)"
                  class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rag-amber/10 text-rag-amber"
                  title="Unverified spend — this session claims an instance with no covering emit heartbeat. It's pending reconciliation (which confirms or removes it). Nothing is revoked or deleted; this is an early heads-up, not an enforcement action."
                  data-testid="quarantined-badge"
                >unverified</span>
              </td>
              <td class="px-6 py-3">
                <span class="inline-flex items-center gap-1.5">
                  <UiToolPill :tool="toolPillProp(s.tool)" />
                  <!-- Dominant-model chip (design §4): one badge, full mix in
                       the tooltip. Detail views land in My Consumption. -->
                  <UsageModelBadge :by-model="s.by_model" />
                </span>
              </td>
              <td class="px-6 py-3 text-carbon-2 text-[12px]">{{ fmtTimeAgo(s.ts_last ?? s.ts_start) }}</td>
              <td class="px-6 py-3 text-right text-carbon-2" style="font-variant-numeric: tabular-nums">
                {{ fmtTokens(s.tokens) }}
              </td>
              <td class="px-6 py-3 text-right font-bold text-carbon" style="font-variant-numeric: tabular-nums">
                {{ fmtUsd(s.cost_usd) }}
              </td>
              <td class="px-6 py-3 text-right">
                <UiButton
                  kind="ghost"
                  size="sm"
                  :data-testid="`retag-${s.session_id}`"
                  @click="openTag({ session_id: s.session_id, instance_id: s.instance_id, tool: s.tool, cost_usd: s.cost_usd, tokens: s.tokens, last_event: s.ts_last ?? s.ts_start, project_id: s.project_id ?? null, activity: s.activity ?? null, by_model: s.by_model })"
                >
                  Re-tag
                </UiButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- §B (#142) — OTHER CLAUDE SURFACES: read-only chargeback lanes (Chat /
         Cowork / Office / …) from the provider bill. Deliberately BELOW and
         separate from the taggable sessions/worklist area: these surfaces have
         no sessions and are never taggable — informational only, no actions. -->
    <HomeOtherSurfacesPanel
      v-if="usage?.surfaces?.length"
      :surfaces="usage.surfaces"
      :month-to-date="usage.month_to_date"
    />

    <!-- Universal tag / re-tag editor (extracted; focus-trapped, Escape, aria). -->
    <HomeTagSessionDialog
      :target="tagSession"
      :projects="myProjects?.projects ?? []"
      :activity-types="activityTypes?.activity_types ?? []"
      @close="tagSession = null"
      @saved="onTagSaved"
    />

    <!-- Connect-a-client pop-up — same ConnectClientGuide as /account. -->
    <ConnectClientDialog :client="connectClient" @close="connectClient = null" />
  </div>
</template>

<style scoped>
.brand-wash {
  background:
    radial-gradient(ellipse 60% 80% at 100% 0%, rgba(212, 14, 140, 0.08), transparent 60%),
    radial-gradient(ellipse 70% 90% at 0% 100%, rgba(89, 144, 240, 0.06), transparent 60%),
    var(--white);
}
</style>
