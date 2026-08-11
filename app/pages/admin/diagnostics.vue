<script setup lang="ts">
/*
 * Admin → Diagnostics (Wave VI). Operational health snapshot.
 *
 * MOSTLY read-only. The probes are all reads; the exceptions are the deliberate,
 * audited operator actions this page grew because the alternative was a shell
 * nobody has: worker enable/disable (mig 0090) and the widened-read telemetry
 * recovery (mig 0093). Anything mutating here is RBAC'd, reason-carrying and
 * audited server-side. (This header used to claim "read-only, no buttons"; that
 * stopped being true with the worker toggle and is corrected rather than kept.)
 * The Refresh button re-fetches the endpoint, giving the operator a
 * quick "is it back yet" loop without a full page reload.
 *
 * Cards are individually defensive: a Postgres miss doesn't break the
 * Redis card (the endpoint already wraps each probe in try/catch).
 */

import { computed, ref } from 'vue'
import type { AbDecompositionTermName } from '#shared/usage/ab-decomposition-terms'
import type { UnhomedCause } from '#shared/usage/unhomed-causes'
// The role vocabulary, shared with the report-visibility policy pane rather than
// re-typed here — see PERSONA_LABEL below.
import { REPORT_VISIBILITY_PERSONAS } from '#shared/auth/report-visibility'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface DiagResp {
  postgres: {
    reachable: boolean
    latencyMs: number
    activeMigration: string | null
    error?: string
  }
  redis: { unavailable: true; reason: string } | { reachable: boolean; latencyMs: number }
  queues:
    | { unavailable: true; reason: string }
    | Record<string, { depth: number }>
  pipeline: {
    lastUsageSeen: string | null
    lastLedgerWrite: string | null
    usageAgeMinutes: number | null
    ledgerAgeMinutes: number | null
    status: 'ok' | 'warn' | 'stale' | 'unknown'
  }
  // migs 0045/0091: our rate-card ESTIMATE vs the provider's own figure over the
  // last 7 days (v_cost_drift), across both cost vintages — pre-cutover rows
  // where cost_usd is the estimate, and provider-priced rows where the estimate
  // rides in metadata. spansCompared=0 until comparable emission accrues.
  costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    providerPricedSpans: number
    rateCardPricedSpans: number
    worstSpan: {
      spanKey: string
      model: string
      rateCardCostUsd: string
      lawCostUsd: string
      driftUsd: string
      pricedBy: string
    } | null
  }
  // Which rung of the costing ladder priced real spend
  // (docs/design/provider-cost-precedence.md). A healthy fleet is ENTIRELY
  // provider-priced — `rateCard > 0` is an ALERT, not a statistic.
  costingRungs: {
    windowDays: number
    spans: number
    provider: number
    rateCard: number
    other: number
    // provider + rateCard — the spans the ladder priced, and the denominator of
    // rateCardPct (backfill traffic must not dilute the fallback share).
    ladderSpans: number
    rateCardPct: number | null
    fallbackModels: { model: string; spans: number }[]
  }
  workers: {
    worker: string
    status: string
    finishedAt: string | null
    startedAt: string | null
    durationMs: number | null
    ageMinutes: number | null
    startedAgeMinutes: number | null
    consecutiveFailures: number
    rag: 'ok' | 'failing' | 'stale' | 'unknown'
    dispatchBudget: 'ok' | 'near' | 'over' | null
    dispatchBudgetReason: string | null
  }[]
  dispatchBudgetMs: number
  lastSync: { source: string; ts: string | null }[]
  nodeEnv: string
  containerInfo: { revision: string | null }
  // TCP reachability of each provisioned private endpoint — the same probe the
  // boot pre-flight runs (scripts/preflight.ts).
  services: {
    name: string
    critical: boolean
    status: 'ok' | 'unreachable' | 'skipped'
    target: string | null
    latencyMs: number | null
    errorClass?: string
    error?: string
    reason?: string
  }[]
  // Log Analytics query reachability (a trivial KQL via the configured reader).
  telemetryRead: { ok: boolean; kind: string; latencyMs: number | null; error?: string }
}

// Card A — Private Link / DNS validation (GET /api/v1/admin/diagnostics/network).
// Per provisioned host: does DNS resolve to a private address (zone linked) and
// is the TCP port reachable? itReport is the plain-text artefact for networking.
// Platform-admin only (region admins AND global-finops 403) — this returns
// infrastructure topology (private IPs, internal host:port pairs), the same
// class of exposure otel-logs.get.ts is gated on.
interface NetCheckReport {
  generatedNote: string
  vnetHint: string
  summary: { total: number; ok: number; zoneNotLinked: number; unreachable: number; dnsFail: number }
  itReport: string // multi-line plain text
  records: Array<{
    service: string
    category: 'data-plane' | 'azure-monitor' | 'reference'
    host: string
    port: number
    expectedZone: string
    expectPrivate: boolean
    addresses: string[]
    resolvesPrivate: boolean
    dnsError?: string
    reachable: boolean | null
    tcpLatencyMs: number | null
    tcpError?: string
    verdict: 'ok' | 'dns-public-zone-not-linked' | 'unreachable' | 'dns-fail' | 'public-ok'
  }>
}

// Card B — OTel telemetry read path (GET /api/v1/admin/diagnostics/otel-logs).
// Platform-admin only (region admins 403). Each KQL probe carries its raw Azure
// error packet on failure — operators need the un-truncated packet.
interface OtelDiag {
  config: { telemetryReader: string | null; workspaceIdSet: boolean; miClientId: string | null; logsEndpointHost: string | null }
  hours: number
  limit: number
  duration: string
  queryEndpointNote: string
  dns: Array<{ host: string; addresses?: string[]; resolvesPrivate?: boolean; error?: string }>
  queries: Array<{
    label: string
    kql: string
    ok: boolean
    status?: string
    latencyMs: number
    partialError?: Record<string, unknown>
    error?: Record<string, unknown>
    columns?: string[]
    rows?: Array<Record<string, unknown>>
  }>
  clientError?: Record<string, unknown>
  fatalError?: Record<string, unknown>
}

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})

/*
 * The §A/§B decomposition is estate-wide and its endpoint is gated to
 * global-finops (see server/api/v1/admin/diagnostics/ab-decomposition.get.ts).
 * A region admin passes `isAdmin` but would get a deterministic 403, so the card
 * must not fetch or render for them: an empty panel with no explanation reads as
 * a broken diagnostic, which is the opposite of what a diagnostics page is for.
 */
const canSeeEstateFinance = computed(() => {
  const r = session.value?.role
  return r === 'global-finops' || r === 'platform-admin'
})

const { data, refresh, pending } = await useFetch<DiagResp>(
  '/api/v1/admin/diagnostics',
  {
    default: () => null as unknown as DiagResp,
    immediate: isAdmin.value,
  },
)

const pgBadge = computed(() => {
  if (!data.value?.postgres) return { kind: 'neutral' as const, label: '—' }
  return data.value.postgres.reachable
    ? { kind: 'rag-green' as const, label: 'ok' }
    : { kind: 'rag-red' as const, label: 'down' }
})

// Overall RAG for the private-endpoint reachability card: red if a boot-critical
// PE is down, amber if a non-critical PE is down, green otherwise.
const servicesBadge = computed(() => {
  const svc = data.value?.services ?? []
  if (!svc.length) return { kind: 'neutral' as const, label: '—' }
  if (svc.some((s) => s.critical && s.status === 'unreachable')) return { kind: 'rag-red' as const, label: 'critical down' }
  if (svc.some((s) => s.status === 'unreachable')) return { kind: 'rag-amber' as const, label: 'degraded' }
  return { kind: 'rag-green' as const, label: 'ok' }
})
function svcDetail(s: DiagResp['services'][number]): string {
  if (s.status === 'ok') return `ok · ${s.latencyMs}ms`
  if (s.status === 'skipped') return 'skipped'
  return `unreachable [${s.errorClass ?? 'error'}]`
}

const redisUnavailable = computed(() =>
  data.value?.redis ? 'unavailable' in data.value.redis : true,
)

const queuesUnavailable = computed(() =>
  data.value?.queues ? 'unavailable' in data.value.queues : true,
)

function fmtTs(v: string | null): string {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

function fmtAge(min: number | null): string {
  if (min == null) return 'never'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} d ago`
}

const pipelineBadge = computed(() => {
  const s = data.value?.pipeline?.status
  if (s === 'ok') return { kind: 'rag-green' as const, label: 'flowing' }
  if (s === 'warn') return { kind: 'rag-amber' as const, label: 'slowing' }
  if (s === 'stale') return { kind: 'rag-red' as const, label: 'stalled' }
  return { kind: 'neutral' as const, label: 'no data' }
})

// Any worker with a trailing failure streak turns the whole Workers card
// red — this is the chip that would have shown the joiner failing while the
// freshness panel still read green.
const workersBadge = computed(() => {
  const ws = data.value?.workers ?? []
  if (!ws.length) return { kind: 'neutral' as const, label: 'no runs' }
  if (ws.some((w) => w.rag === 'failing')) return { kind: 'rag-red' as const, label: 'failing' }
  if (ws.some((w) => w.rag === 'stale')) return { kind: 'rag-amber' as const, label: 'stale' }
  return { kind: 'rag-green' as const, label: 'healthy' }
})

function workerChip(
  rag: string,
): { kind: 'rag-green' | 'rag-red' | 'rag-amber' | 'neutral'; label: string } {
  if (rag === 'ok') return { kind: 'rag-green', label: '✓ ok' }
  if (rag === 'failing') return { kind: 'rag-red', label: '✗ failing' }
  // Amber for stale — consistent with the card badge (LOW-4); the per-row chip
  // previously rendered stale as neutral/grey.
  if (rag === 'stale') return { kind: 'rag-amber', label: '— stale' }
  return { kind: 'neutral', label: '? unknown' }
}

function fmtWorkerRun(durationMs: number | null, ageMinutes: number | null): string {
  const age = ageMinutes == null ? 'no run yet' : `last run ${fmtAge(ageMinutes)}`
  return durationMs == null ? age : `${age} · ${durationMs}ms`
}

// Drift RAG: <1% green (rounding noise), <5% amber (check the card),
// >=5% red (rate card is stale / mispriced).
//
// Since the provider-cost cutover this is NOT a money-accuracy alarm: for a
// provider-priced span the booked total IS the provider's number regardless of
// how far the card has drifted. What drift still governs is the per-token-type
// SLICE (the card decides how a span total is divided, never how big it is) and
// the forecasting/validation uses of the card. Amber/red therefore means "the
// card needs a rate line", not "the bill is wrong".
const driftBadge = computed(() => {
  const d = data.value?.costDrift
  if (!d || d.spansCompared === 0) return { kind: 'neutral' as const, label: 'no data' }
  const pct = d.meanAbsDriftPct ?? 0
  if (pct < 1) return { kind: 'rag-green' as const, label: 'in line' }
  if (pct < 5) return { kind: 'rag-amber' as const, label: 'drifting' }
  return { kind: 'rag-red' as const, label: 'stale rates' }
})

// Costing-rung RAG. Deliberately NOT a proportional gauge: the design's bar is
// that a healthy fleet is ENTIRELY provider-priced, so ONE rate-card-priced span
// is already an anomaly and goes straight to red. Grading it (amber under 5%,
// say) would teach operators that a bit of fallback is normal, which is exactly
// the silent mispricing this whole change exists to stop — a new model priced at
// the wrong model's rates looks like a small percentage right up until it isn't.
const costingBadge = computed(() => {
  const c = data.value?.costingRungs
  if (!c || c.spans === 0) return { kind: 'neutral' as const, label: 'no spans' }
  // Guard on ladderSpans (provider + rateCard), NOT spans (which also counts
  // `other`, i.e. backfill/telemetry-only). A window holding ONLY backfill spans
  // has nothing on the costing ladder to judge, and going green there would
  // claim a clean bill of health from no evidence — the failure this card exists
  // to prevent, inverted.
  if (c.ladderSpans === 0) return { kind: 'neutral' as const, label: 'no priced spans' }
  if (c.rateCard > 0) return { kind: 'rag-red' as const, label: 'rate-card fallback' }
  return { kind: 'rag-green' as const, label: 'provider-priced' }
})

// --- Card A: Private Link / DNS validation -------------------------------
// Defensive: this fetch is independent of the main diagnostics fetch, so a
// failure here cannot blank the rest of the page (its own error ref is shown).
const {
  data: netData,
  refresh: refreshNet,
  pending: netPending,
  error: netError,
} = await useFetch<NetCheckReport>('/api/v1/admin/diagnostics/network', {
  default: () => null as unknown as NetCheckReport,
  immediate: isAdmin.value,
})

// Surface failures first: anything that is not a clean ok/public-ok floats up.
const netRecords = computed(() => {
  const recs = netData.value?.records ?? []
  const clean = (v: string) => (v === 'ok' || v === 'public-ok' ? 1 : 0)
  return [...recs].sort((a, b) => clean(a.verdict) - clean(b.verdict))
})

function verdictBadge(
  v: NetCheckReport['records'][number]['verdict'],
): { kind: 'rag-green' | 'rag-red'; label: string } {
  return v === 'ok' || v === 'public-ok'
    ? { kind: 'rag-green', label: v }
    : { kind: 'rag-red', label: v }
}

function privBadge(isPrivate: boolean | undefined): { kind: 'rag-green' | 'rag-red'; label: string } {
  return isPrivate ? { kind: 'rag-green', label: 'private' } : { kind: 'rag-red', label: 'public' }
}

function reachText(r: NetCheckReport['records'][number]): string {
  if (r.reachable === null) return '—'
  if (r.reachable) return `✓ ${r.tcpLatencyMs ?? '?'}ms`
  return '✗'
}

const itCopied = ref(false)
async function copyItReport() {
  const text = netData.value?.itReport
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    itCopied.value = true
    setTimeout(() => {
      itCopied.value = false
    }, 2000)
  } catch {
    itCopied.value = false
  }
}

// --- Card B: OTel telemetry (Log Analytics) ------------------------------
// Platform-admin only; a region admin gets a 403 which lands in otelError and
// is rendered as a status message rather than throwing.
const {
  data: otelData,
  refresh: refreshOtel,
  pending: otelPending,
  error: otelError,
} = await useFetch<OtelDiag>('/api/v1/admin/diagnostics/otel-logs', {
  query: { hours: 6 },
  default: () => null as unknown as OtelDiag,
  immediate: isAdmin.value,
})

// --- Card C: attribution gaps (devices emitting but not attributing) ------
// The operator surface for the silent-attribution outage class. Calls the SAME
// predicate the attribution-gap worker alerts on, so this list and the alert can
// never disagree — an operator uses this to judge whether an alert is real.
interface AttributionGapInstance {
  instanceId: string
  email: string | null
  lastBearerAt: string
  lastAttributedAt: string | null
  gapHours: number
}
interface AttributionGapsResp {
  reachable: boolean
  error?: string
  count: number
  instances: AttributionGapInstance[]
}
const {
  data: gapsData,
  refresh: refreshGaps,
  pending: gapsPending,
} = await useFetch<AttributionGapsResp>('/api/v1/admin/diagnostics/attribution-gaps', {
  default: () => null as unknown as AttributionGapsResp,
  immediate: isAdmin.value,
})

function gapDays(hours: number): string {
  const d = hours / 24
  return d >= 1 ? `${d.toFixed(1)}d` : `${hours.toFixed(1)}h`
}

// --- Card: §A/§B decomposition (the Workstream A gate) --------------------
// The gate has two halves. CORRECTNESS (does the delta decompose to a zero
// residual?) is settled by integration tests against synthesised data. MAGNITUDE
// (do non-Code surfaces actually dominate?) is a question about production
// numbers, and since nobody can run SQL against Dev the only way to answer it is
// to render it here. The endpoint computes the verdict rather than leaving an
// operator to eyeball a table of signed numbers and guess.
interface UnhomedCauseRow {
  cause: UnhomedCause
  usd: string
  countKind: 'teammates' | 'org-units' | 'provider-organisations'
  count: number
  secondaryCount: number | null
  secondaryKind: 'teammates' | 'regions' | null
  placementFailure: boolean
}
interface UnhomedWorklistRow {
  kind: 'teammate' | 'org-unit' | 'provider-organisation'
  label: string
  sublabel: string | null
  region: string | null
  usd: string
  headcount: number | null
}
interface UnhomedWorklist {
  cause: UnhomedCause
  rows: UnhomedWorklistRow[]
  shown: number
  total: number
  shownUsd: string
  bucketUsd: string
}
interface UnhomedMonthRow {
  month: string
  state: 'measured' | 'no-spend' | 'not-measured'
  unhomedUsd: string | null
  chargeableUsd: string | null
  sharePct: number | null
  /** null = this month's finance-period read failed. Renders "Unknown", never "Open". */
  periodState: 'open' | 'closed' | null
  selected: boolean
  partial: boolean
}
interface UnhomedProbe {
  unhomedUsd: string
  chargeableUsd: string
  /** Chargeable SOURCE ROWS in the window — what "empty month" is decided on. Both
   *  money figures are signed sums and cancel; a row count cannot. */
  sourceRows: number
  causes: UnhomedCauseRow[]
  residualUsd: string
  reconciles: boolean
  worklists: UnhomedWorklist[]
  placementConfig: {
    activeCostOwningUnits: number
    unitsWithCostCentreCode: number
    activeOwners: number
    unitsWithActiveOwner: number
    ownersWithDirectoryIdentity: number
  } | null
  history: UnhomedMonthRow[]
  estateFirstMonth: string | null
}

interface AbDecompositionResp {
  reachable: boolean
  error?: string
  window: { from: string; to: string }
  sectionA: string
  sectionB: string
  delta: string
  terms: Record<AbDecompositionTermName, string>
  termOrder: readonly AbDecompositionTermName[]
  residual: string
  diagnostics: {
    unhomedChargeUsd: string
    quarantinedOtelUsd: string
    codingAgentInSectionAUsd: string
  }
  verdict: 'residual-non-zero' | 'no-delta' | 'non-code-dominates' | 'non-code-does-not-dominate'
  nonCodeShareOfExplained: number | null
  // The cause split behind the unhomed figure. null = the sub-probe failed and
  // the section must say "No reading" rather than render a plausible zero.
  unhomed: UnhomedProbe | null
  unhomedError: string | null
  unhomedWorklistCap: number
  unhomedHistoryMonths: number
  visibility: {
    mode: string
    label: string
    description: string
    isDefault: boolean
    defaultMode: string
    personas: { key: string; label: string; scopes: string[] }[]
  }
}

/** Default to LAST month: the current month is always partial, and a partial
 *  month reads as a spurious gap because §B lands on a monthly billing cadence
 *  while §A accrues continuously. */
function lastMonthParam(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const abMonth = ref(lastMonthParam())

const {
  data: abData,
  error: abError,
  refresh: refreshAb,
  pending: abPending,
} = await useFetch<AbDecompositionResp>('/api/v1/admin/diagnostics/ab-decomposition', {
  query: { from: abMonth },
  default: () => null as unknown as AbDecompositionResp,
  immediate: canSeeEstateFinance.value,
})

/*
 * A zero non-Code term and a small-but-present one produce the SAME
 * 'non-code-does-not-dominate' verdict and the same 0%, but they mean opposite
 * things: the first is a null result (the gate's question has nothing to bite
 * on), the second is evidence against the design. The verdict cannot carry the
 * distinction because it is a share, so the card reads the term itself.
 */
const abNonCodeIsZero = computed(
  () => Number(abData.value?.terms?.nonCodeSurfaces ?? 0) === 0,
)

/*
 * Keyed by the term UNION, not by `string`. The module goes to some trouble to
 * make the term list undriftable (adding a term is a compile error in every
 * consumer); typing these as Record<string, string> left the one surface an
 * operator actually reads as the exception, where an eleventh term would have
 * rendered its raw key and a blank hint.
 */
const AB_TERM_LABELS: Record<AbDecompositionTermName, string> = {
  nonCodeSurfaces: 'Non-Code Claude surfaces',
  licenceLanes: 'Copilot licence lanes',
  copilotAgentUsage: 'Copilot coding-agent lane',
  copilotUsageGap: 'Copilot usage grain gap',
  quarantine: 'Quarantined sessions',
  floor: 'Reconciliation floor',
  chargebackExemptUsage: 'Chargeback-exempt usage',
  populationDifference: 'Population difference',
  homingLoss: 'Homing loss',
  unreconciledApiLag: 'Reconciliation lag',
  unreconciledApiStale: 'Stale reconciliation',
}
const AB_TERM_HINTS: Record<AbDecompositionTermName, string> = {
  nonCodeSurfaces: 'Billed by Anthropic, absent from both §A arms — the design expects this to dominate.',
  licenceLanes: 'Copilot seat SKUs. A pure sum: an idle licensed seat has no §A counterpart.',
  copilotAgentUsage:
    'Coding-agent spend, billed inside the pooled Copilot invoice but invisible to the usage rollups by design: it emits no telemetry and is never taggable. A genuine completeness hole rather than a measurement artefact, so it is named here instead of being folded into the line below.',
  copilotUsageGap:
    'What remains of the pooled enterprise invoice once the coding-agent lane above is named, measured against per-user usage. Mostly the pooled-vs-per-user grain difference, but not only that: a Copilot user with no teammate mapping is skipped before any usage row is written, so their spend is billed here and invisible to §A. That amount cannot be computed from stored data (it exists only in the live provider roster) — see Unresolved Copilot users for it.',
  quarantine:
    'Spend a developer disowned. Always zero here, but not by being absent from both sides: where the provider API corroborates the same day, reconciliation returns the amount to §A and §B bills it, so it cancels; where nothing corroborates it, it enters neither. The amount is shown below.',
  floor: 'Where OTel over-reads the API, the floor keeps §A high. Negative by construction.',
  chargebackExemptUsage:
    'Spend flagged chargeback-exempt. Every chargeable lane filters it out of §B, but nothing filters it out of §A, so it is genuine usage that is deliberately not billed. Negative by construction. Not a fault — governance working as configured.',
  populationDifference: 'Spend whose teammate no longer resolves. Structurally zero today.',
  homingLoss: 'Zero at estate level by construction — see the unhomed figure below, which is not.',
  unreconciledApiLag:
    'Billed spend the reconciliation worker has not folded into §A yet, so §B carries it and §A does not. Self-healing while the day is still inside the worker\'s trailing 35-day window; an older month needs a backfill before it clears.',
  unreconciledApiStale:
    'The opposite direction: §A already carries more than the API now reports, typically late telemetry arriving after a day was reconciled. Shown separately from the lag above because the two cancel if summed, and they call for different responses.',
}

function abUsd(v: string | undefined): string {
  if (v === undefined) return '—'
  const n = Number(v)
  const sign = n < 0 ? '−' : ''
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/*
 * --- The unhomed cause split -------------------------------------------------
 * Same voice as AB_TERM_HINTS above: every line says what the number IS and what
 * it MEANS. A labelled table of four dollar amounts would be a regression
 * against the surface it extends.
 */
const UNHOMED_LABELS: Record<UnhomedCause, string> = {
  'no-region': 'Teammate has no region',
  'region-no-unit': 'Teammate is in a region but not in a unit',
  'no-cost-owning-ancestor': 'Unit has no cost-owning ancestor',
  // NAMED FOR WHAT IT MEASURES. The bucket reads the Copilot pooled bill and its
  // overage allocation and nothing else; calling it "pooled provider" promised a
  // generality the query has never had (see shared/usage/unhomed-causes.ts).
  'pooled-copilot': 'Pooled Copilot spend with no cost-owning unit',
}
const UNHOMED_HINTS: Record<UnhomedCause, string> = {
  'no-region':
    'The platform could not place these people in any region at all: no directory match, no manager chain, no billing region. They sit in the system-wide holding region, so their spend reaches no region’s report and no cost centre.',
  'region-no-unit':
    'The region is known; the unit is not. They sit on their region’s holding node, which is deliberately not cost-owning, so their spend reaches the region and stops there.',
  'no-cost-owning-ancestor':
    'These people are in a real unit, but neither it nor anything above it at any depth is both cost-owning and active. The tree is fine; the ownership flag is missing, or the unit that carried it has been retired.',
  'pooled-copilot':
    'COPILOT invoice lines billed to the enterprise as a pool rather than to a person, whose provider organisation is not homed to a cost-owning unit. This is not a placement failure and placing people will not move it — the organisation is what needs homing. Copilot is the only pooled provider this bucket covers: another one would not appear here, it would land in the residual and suppress this whole breakdown.',
}
/*
 * ROLE NAMES COME FROM THE SHARED PERSONA LIST, never re-typed here. The scope
 * vocabulary was lifted to shared/auth/report-visibility.ts precisely so this
 * card and the policy pane cannot drift — and then the OWNER labels three lines
 * below were typed as free text ("Region admin", "Global finance"), which is a
 * second vocabulary for the same roles on the same card. Rename a persona there
 * and this panel follows.
 */
const PERSONA_LABEL = Object.fromEntries(
  REPORT_VISIBILITY_PERSONAS.map((p) => [p.key, p.label]),
) as Record<(typeof REPORT_VISIBILITY_PERSONAS)[number]['key'], string>

/** The role that owns a region-scoped fix — and cannot read this page. */
const REGION_ADMIN_LABEL = PERSONA_LABEL.admin
/** The role that owns an estate-wide fix, and is reading this page. */
const GLOBAL_FINANCE_LABEL = PERSONA_LABEL['global-finops']

/*
 * Each cause names its ACTION and its OWNER. Two of the four owners cannot read
 * this page (it is global-finops only, for a sound reason — see the endpoint),
 * so the panel says the work must be handed over rather than implying the reader
 * can fix everything.
 */
const UNHOMED_ACTIONS: Record<UnhomedCause, { action: string; owner: string; handover: boolean }> = {
  'no-region': {
    action:
      'Give the person a region, or add a directory region rule / region leader so the re-enrichment worker heals the whole population in bulk.',
    owner: GLOBAL_FINANCE_LABEL,
    handover: false,
  },
  'region-no-unit': {
    action: 'Place the person into a cost-owning unit in their own region.',
    owner: `${REGION_ADMIN_LABEL} for that region`,
    handover: true,
  },
  'no-cost-owning-ancestor': {
    action:
      'Mark a unit in that ancestry cost-owning, or un-retire the unit that carried it. (Setting a unit’s directory cost-centre code has no admin surface today — see the counters below.)',
    owner: `${REGION_ADMIN_LABEL} for that region`,
    handover: true,
  },
  'pooled-copilot': {
    action: 'Home the provider organisation to a cost-owning unit, on the reconciliation surface.',
    owner: `${REGION_ADMIN_LABEL}, escalating to ${GLOBAL_FINANCE_LABEL} for an organisation in no region`,
    handover: true,
  },
}
const UNHOMED_COUNT_NOUNS: Record<UnhomedCauseRow['countKind'], [string, string]> = {
  teammates: ['person', 'people'],
  'org-units': ['unit', 'units'],
  'provider-organisations': ['organisation', 'organisations'],
}
const UNHOMED_SECONDARY_NOUNS: Record<'teammates' | 'regions', [string, string]> = {
  teammates: ['person', 'people'],
  regions: ['region', 'regions'],
}

function plural(n: number, nouns: [string, string]): string {
  return `${n.toLocaleString()} ${n === 1 ? nouns[0] : nouns[1]}`
}

/** "$X, N people across R regions" — never a row count (PB-5). */
function unhomedCounts(c: UnhomedCauseRow): string {
  const primary = plural(c.count, UNHOMED_COUNT_NOUNS[c.countKind])
  if (c.secondaryKind === null || c.secondaryCount === null) return primary
  return `${primary}, ${plural(c.secondaryCount, UNHOMED_SECONDARY_NOUNS[c.secondaryKind])}`
}

const unhomedProbe = computed(() => abData.value?.unhomed ?? null)

/*
 * The one thing that makes the other five numbers trustworthy. A split that does
 * not add back to the figure it decomposes is worse than no split: it invites an
 * operator to size a remediation against a bucket that is quietly missing money.
 */
const unhomedReconciles = computed(() => unhomedProbe.value?.reconciles === true)

/*
 * A month with NOTHING TO SPLIT — "$0.00 unhomed (0%)" would be a lie.
 *
 * DECIDED ON SOURCE ROWS, NEVER ON THE SUMS. Both money figures are signed: a
 * credit note nets chargeable to $0.00 over homed money, and two unhomed rows of
 * opposite sign net BOTH figures to $0.00 with the split behind them full of
 * people. Requiring both sums to be zero caught only the first of those and still
 * printed "nothing to home" over the second — the exact money this panel exists
 * to show. A row count cannot cancel: 0 rows is the only thing that means empty.
 */
const unhomedNothingToSplit = computed(
  () => unhomedProbe.value != null && unhomedProbe.value.sourceRows === 0,
)

/*
 * Only the lists with something in them. An empty bucket has nothing to drill
 * into, and rendering its heading anyway would read as "we looked and found
 * nothing to fix" beside a bucket that is simply $0.00 — the cause table above
 * already says that, in words.
 */
const unhomedVisibleWorklists = computed<UnhomedWorklist[]>(() =>
  (unhomedProbe.value?.worklists ?? []).filter((w) => w.rows.length > 0),
)

function unhomedMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/*
 * WHAT CLOSING A PERIOD ACTUALLY FREEZES, which is narrower than this used to
 * say. `finance_period.closed` freezes the governance VERDICTS on that month's
 * rows — whether a row is chargeable at all. It does NOT freeze HOMING: the
 * per-teammate chargeback lane resolves the cost-owning unit live from the
 * teammate's CURRENT placement on every read, so placing someone today moves a
 * closed month's unhomed figure. Month-grain point-in-time homing (D-Homing) is
 * a RATIFIED FUTURE decision, not current behaviour, and this copy said "placing
 * someone now will not change this figure" as though it had already shipped.
 */
const financePeriodConsequence: Record<'open' | 'closed' | 'unknown', string> = {
  closed:
    'Closed — this month’s chargeability verdicts are frozen, and a correction to them needs the audited reopen or restate. Homing is NOT frozen: it is resolved live from where people sit today, so placing someone now still moves this figure for a closed month.',
  open: 'Open — this month still recomputes, so remediation you do today moves this figure.',
  unknown:
    'Unknown — the finance period for this month could not be read. This is not “open”: whether the verdicts behind this figure are frozen is unanswered.',
}

/** 'open' | 'closed' | 'unknown' — a failed read is its own state, never "Open". */
function financePeriodKey(s: 'open' | 'closed' | null): 'open' | 'closed' | 'unknown' {
  return s ?? 'unknown'
}
const FINANCE_PERIOD_WORD: Record<'open' | 'closed' | 'unknown', string> = {
  closed: 'Closed',
  open: 'Open',
  unknown: 'Unknown',
}


// "This device is N days behind" leaves the operator with one question and no
// way to ask it: is the telemetry in ingest at all? IN-but-unattributed is ours
// (the joiner); ABSENT is the client's. The workspace is NSP-locked to the app's
// managed identity, so this can only be asked from inside the product.
interface InstanceTelemetryResp {
  instanceId: string
  windowHours: number
  known: boolean
  instance: {
    teammateEmail: string | null
    lastBearerAt: string | null
    endedAt: string | null
    // CLIENT-ASSERTED (mig 0092) — a diagnostic hint, never a basis for a
    // decision. null = this device has never reported, i.e. it is running a
    // build older than the one that reports.
    clientPluginVersion: string | null
    clientCliVersion: string | null
    clientVersionAt: string | null
  } | null
  ingest:
    | { reachable: true; records: number; usageRecords: number; firstSeen: string | null; lastSeen: string | null }
    | { reachable: false; error: string | null }
  attribution: { records: number; firstTsEvent: string | null; lastTsEvent: string | null }
  verdict: string
  side: 'client' | 'server' | 'none' | null
  interpretation: string
}

const diagnosing = ref<string | null>(null)
const diagnosis = ref<Record<string, InstanceTelemetryResp | { failed: string }>>({})

async function diagnoseInstance(instanceId: string, gapHours: number) {
  diagnosing.value = instanceId
  try {
    // Window = the gap plus a day of headroom, so the probe covers the period the
    // detector is complaining about rather than a fixed guess that could miss it
    // entirely. Bounded to the 90-day retention ceiling the API enforces.
    const hours = Math.min(Math.max(Math.ceil(gapHours) + 24, 1), 24 * 90)
    diagnosis.value = {
      ...diagnosis.value,
      [instanceId]: await $fetch<InstanceTelemetryResp>('/api/v1/admin/diagnostics/instance-telemetry', {
        query: { instanceId, hours },
      }),
    }
  } catch (err) {
    // Show the failure rather than leaving the row silent — an unrun probe must
    // never look like a conclusive answer.
    diagnosis.value = {
      ...diagnosis.value,
      [instanceId]: { failed: err instanceof Error ? err.message : String(err) },
    }
  } finally {
    diagnosing.value = null
  }
}

function telemetryVerdictBadge(verdict: string): { kind: 'rag-green' | 'rag-amber' | 'rag-red' | 'neutral'; label: string } {
  switch (verdict) {
    case 'absent-from-ingest':
      return { kind: 'rag-red', label: 'Client side' }
    case 'ingested-without-usage':
      // Also the client: exporting, but not usage events. A re-read cannot help,
      // so it must NOT read as the joiner's amber.
      return { kind: 'rag-red', label: 'Client side (no usage events)' }
    case 'ingested-not-attributed':
      return { kind: 'rag-amber', label: 'Our side (joiner)' }
    case 'attributed':
      return { kind: 'rag-green', label: 'Healthy window' }
    case 'attributed-beyond-ingest-window':
      return { kind: 'neutral', label: 'Window too wide' }
    default:
      // Including 'unanswerable' — an unread probe is NOT a green light and must
      // never be styled as one.
      return { kind: 'neutral', label: 'Unanswerable' }
  }
}

// --- Card C(b): the widened-read recovery lever ---------------------------
// The reader accepts a lookback up to 90 days but nothing an admin could touch
// ever passed it, so a backlog older than a week was unrecoverable from the
// product. Enqueue-only: a 90-day read cannot be served inside the ~120s worker
// gateway, so the telemetry-recovery worker drains it in resumable slices.
interface RecoveryRequestRow {
  id: string
  status: string
  lookbackDays: number
  instanceCount: number
  instancesProcessed: number
  percentComplete: number
  rowsWritten: number
  errors: number
  reason: string | null
  error: string | null
  requestedByEmail: string | null
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
}
const {
  data: recoveryData,
  refresh: refreshRecovery,
  pending: recoveryPending,
} = await useFetch<{ requests: RecoveryRequestRow[]; inFlight: boolean }>(
  '/api/v1/admin/diagnostics/telemetry-recovery',
  { default: () => null as unknown as { requests: RecoveryRequestRow[]; inFlight: boolean }, immediate: isAdmin.value },
)

/*
 * Enqueueing is global-finops-only (it is not region-bounded and it spends Log
 * Analytics query budget); the Diagnose probe above is open to the wider admin
 * tier. Gate the control rather than letting a region admin press a button that
 * can only 403 — an operator mid-incident should not have to discover their own
 * permissions from an error.
 */
const canRecover = computed(() => {
  // MUST match the POST endpoint's requireRole exactly (global-finops only).
  // This previously also allowed platform-admin, which the endpoint rejects — so
  // the button rendered and deterministically 403'd, the precise thing the note
  // above says not to do. If platform-admin should be able to enqueue a
  // recovery, widen the ENDPOINT deliberately and change both together.
  return session.value?.role === 'global-finops'
})

const recoveryLookbackDays = ref(30)
const recoverySubmitting = ref(false)
const recoveryMessage = ref<string | null>(null)

async function requestRecovery() {
  const instanceIds = (gapsData.value?.instances ?? []).map((i) => i.instanceId)
  if (instanceIds.length === 0) return
  const reason = (
    globalThis.prompt(
      `Re-read ${instanceIds.length} device(s) at ${recoveryLookbackDays.value} days. Why? (recorded + audited):`,
    ) ?? ''
  ).trim()
  if (!reason) return
  recoverySubmitting.value = true
  recoveryMessage.value = null
  try {
    const res = await $fetch<{ id: string; instanceCount: number; note: string }>(
      '/api/v1/admin/diagnostics/telemetry-recovery',
      { method: 'POST', body: { instanceIds, lookbackDays: recoveryLookbackDays.value, reason } },
    )
    // Deliberately does NOT say "recovered". Acceptance is not completion — that
    // conflation is the bug class this whole panel exists to remove.
    recoveryMessage.value = `Queued ${res.instanceCount} device(s). ${res.note}`
    await refreshRecovery()
  } catch (err) {
    recoveryMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    recoverySubmitting.value = false
  }
}

/* --- Card D: Provider wire shape ------------------------------------------
 * What do the providers actually send? Every claim we had came from our own Zod
 * schemas, and two of the three are permissive enough to parse identically
 * whether a field arrives, arrives null, or never arrives — so they are not
 * evidence. This card reports the SHAPE of real payloads: paths, types, and how
 * often each key is present. It never renders a response body.
 *
 * NOT fetched on mount. The live mode issues real provider calls, so it is
 * button-triggered; the free stored scan is the default so a mis-click cannot
 * spend provider budget.
 */
interface WirePathStat {
  path: string
  types: string[]
  present: number
  total: number
  nulls: number
  distinctValues?: string[]
  valuesWithheld?: 'denylisted-key' | 'high-cardinality' | 'value-shape' | 'surfaced-elsewhere'
}
interface WireDrift {
  status: 'no-baseline' | 'no-data' | 'match' | 'drift' | 'inconclusive'
  note?: string
  baseline?: { provenance: 'schema-derived' | 'live-capture'; capturedAt: string | null; note: string }
  added?: string[]
  removed?: string[]
  absentOptional?: string[]
  notObserved?: string[]
  typeChanged?: { path: string; baseline: string[]; live: string[]; unexpected: string[] }[]
  presenceMoved?: { path: string; baselineRate: number; liveRate: number; present: number; total: number }[]
}
interface WireSurface {
  id: string
  label: string
  endpoint: string
  mode: 'live' | 'stored'
  status: 'not-configured' | 'errored' | 'ok'
  reason?: string
  target?: string | null
  request?: { method: string; path: string; params: [string, string][]; note: string } | null
  error?: { status: number; bodyText: string; truncated: boolean }
  summary?: { itemsPath: string; itemCount: number; paths: WirePathStat[] }
  drift?: WireDrift
  undeclared?: { kind: string; paths: string[]; note: string }
  freshness?: {
    dataRefreshedAt: string | null
    windowEndingAt: string
    coversWindow: boolean | null
    note: string
  } | null
  fetchBound?: {
    linksAvailable: number
    linksRead: number
    lineLimit: number
    linesRead: number
    linesCapped: boolean
    linesUnparseable: number
    note: string
  } | null
  scan?: {
    windowDays: number
    rowLimit: number
    rowsScanned: number
    capped: boolean
    source: string
    filter: string
    unfiltered?: {
      rowsForProvider: number
      rowsForEnterprise: number
      note: string
    }
  }
  defaultedPaths?: string[]
  unobservable?: { paths: string[]; note: string }
  durationMs?: number
}
interface WireShapeResp {
  generatedAt: string
  day: string
  mode: string
  note: string
  live: WireSurface[]
  stored: WireSurface[]
}

/*
 * MUST match the POST endpoint's requireRole exactly (platform-admin only). A
 * button that renders for a role the endpoint rejects can only 403 — the same
 * mismatch the recovery control's comment above records.
 */
const canProbeWireShape = computed(() => session.value?.role === 'platform-admin')

const wireData = ref<WireShapeResp | null>(null)
const wireRunning = ref<'stored' | 'both' | null>(null)
const wireError = ref<string | null>(null)
const wireCopied = ref(false)
const wireExpanded = ref<Record<string, boolean>>({})

async function runWireShape(mode: 'stored' | 'both') {
  if (wireRunning.value) return
  wireRunning.value = mode
  wireError.value = null
  try {
    wireData.value = await $fetch<WireShapeResp>('/api/v1/admin/diagnostics/provider-wire-shape', {
      method: 'POST',
      body: { mode },
    })
  } catch (err) {
    wireError.value = err instanceof Error ? err.message : String(err)
  } finally {
    wireRunning.value = null
  }
}

// Live surfaces first, then the stored scan of the same surfaces — the delta
// between the two is the point, so they read best adjacent.
const wireSurfaces = computed<WireSurface[]>(() => [
  ...(wireData.value?.live ?? []),
  ...(wireData.value?.stored ?? []),
])

/** Total undeclared paths across every surface — the headline number. */
const wireUndeclaredTotal = computed(() =>
  wireSurfaces.value.reduce((n, s) => n + (s.undeclared?.paths.length ?? 0), 0),
)

function wireStatusBadge(s: WireSurface): { kind: 'neutral' | 'rag-green' | 'rag-red'; label: string } {
  if (s.status === 'not-configured') return { kind: 'neutral', label: 'not configured' }
  if (s.status === 'errored') return { kind: 'rag-red', label: 'error' }
  return { kind: 'rag-green', label: 'ok' }
}

/*
 * The badge names WHAT the payload was compared against, and that is a property
 * of the baseline, not a constant: a 'schema-derived' baseline records what our
 * Zod assumes, a 'live-capture' one records what a previous run observed.
 * Hardcoding "schema" would mislabel every comparison against a capture.
 */
function wireDriftBadge(d?: WireDrift): { kind: 'neutral' | 'rag-green' | 'rag-amber' | 'rag-red'; label: string } {
  if (!d) return { kind: 'neutral', label: '—' }
  const ref = d.baseline?.provenance === 'live-capture' ? 'last capture' : 'schema'
  if (d.status === 'drift') return { kind: 'rag-red', label: `differs from ${ref}` }
  if (d.status === 'match') return { kind: 'rag-green', label: `matches ${ref}` }
  if (d.status === 'inconclusive') return { kind: 'rag-amber', label: 'inconclusive' }
  if (d.status === 'no-data') return { kind: 'neutral', label: 'no rows observed' }
  return { kind: 'neutral', label: 'no baseline' }
}

/** Presence as a percentage, or an em dash when the denominator is zero. */
function wirePct(present: number, total: number): string {
  if (total === 0) return '—'
  return `${Math.round((present / total) * 100)}%`
}

function wireWithheldLabel(reason: WirePathStat['valuesWithheld']): string {
  if (reason === 'denylisted-key') return 'values withheld (identity or money key)'
  if (reason === 'high-cardinality') return 'values withheld (>50 distinct)'
  if (reason === 'surfaced-elsewhere') return 'not collected here (reported under freshness)'
  return 'values withheld (value looked sensitive)'
}

function toggleWireSurface(key: string) {
  wireExpanded.value[key] = !wireExpanded.value[key]
}

/*
 * Copy the whole report as JSON. This is how a baseline gets refreshed: paste a
 * surface's `summary` into server/diagnostics/baselines/<id>.json, convert the
 * counts to rates and set provenance to 'live-capture'.
 */
async function copyWireReport() {
  if (!wireData.value) return
  try {
    await navigator.clipboard.writeText(JSON.stringify(wireData.value, null, 2))
    wireCopied.value = true
    setTimeout(() => {
      wireCopied.value = false
    }, 2000)
  } catch {
    wireCopied.value = false
  }
}

// --- Worker enable/disable (mig 0090) -------------------------------------
// Activation used to be infra-only: stopping a misbehaving scheduled worker meant
// editing bicep and redeploying. This makes it a runtime, audited admin decision.
const expandedQueries = ref<Record<string, boolean>>({})
function toggleQuery(label: string) {
  expandedQueries.value[label] = !expandedQueries.value[label]
}

function pretty(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-diagnostics">
    <UiPageHead
      eyebrow="Administration"
      title="Diagnostics"
      sub="Health probes, plus the audited operator actions that follow from them (worker on/off, telemetry recovery)."
    >
      <template #actions>
        <UiButton
          kind="secondary"
          size="sm"
          :disabled="pending"
          data-testid="admin-diagnostics-refresh"
          @click="refresh()"
        >
          {{ pending ? 'Refreshing…' : 'Refresh' }}
        </UiButton>
      </template>
    </UiPageHead>

    <div v-if="data" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <!-- Pipeline freshness (emit -> gather). The signal that flags a silent
           emission outage: 'last usage seen' going stale while the joiner runs. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-pipeline">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Attribution pipeline</UiEyebrow>
          <UiBadge :kind="pipelineBadge.kind" data-testid="admin-diag-pipeline-badge">{{ pipelineBadge.label }}</UiBadge>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <h2 class="text-lg font-bold text-carbon" data-testid="admin-diag-last-usage">
              {{ fmtAge(data.pipeline?.usageAgeMinutes ?? null) }}
            </h2>
            <p class="text-xs text-carbon-3 mt-1">
              Last <strong>usage seen</strong> (max ts_event) — {{ fmtTs(data.pipeline?.lastUsageSeen ?? null) }}.
              Stale here means clients stopped emitting or the ingest path is dropping.
            </p>
          </div>
          <div>
            <h2 class="text-lg font-bold text-carbon">{{ fmtAge(data.pipeline?.ledgerAgeMinutes ?? null) }}</h2>
            <p class="text-xs text-carbon-3 mt-1">
              Last <strong>ledger write</strong> (max ts_recorded) — {{ fmtTs(data.pipeline?.lastLedgerWrite ?? null) }}.
              When this keeps moving but usage is stale, the break is upstream in emit/ingest.
            </p>
          </div>
        </div>
        <p v-if="data.pipeline?.status === 'stale'" class="mt-3 text-xs text-brand-hunger">
          No usage seen in over 6 hours. If devs are active, check the client emit path
          (a 401 from /bearer silently drops telemetry).
        </p>
      </UiCard>

      <!-- Worker execution health. The card the freshness panel CANNOT be:
           a worker cron failing every run while ts_recorded still advances.
           This is the card that would have shown the joiner red. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-workers">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Worker execution health</UiEyebrow>
          <UiBadge :kind="workersBadge.kind" data-testid="admin-diag-workers-badge">{{ workersBadge.label }}</UiBadge>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Outcome of each scheduled worker dispatch. A worker can be
          <strong>failing every run</strong> while the pipeline above still
          reads green — a partial run advances data recency. This is the signal
          that catches a silently-failing cron.
        </p>
        <ul v-if="data.workers?.length" class="divide-y divide-carbon-6">
          <li
            v-for="w in data.workers"
            :key="w.worker"
            class="py-2"
            :data-testid="`admin-diag-worker-${w.worker}`"
          >
            <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <UiBadge :kind="workerChip(w.rag).kind">{{ workerChip(w.rag).label }}</UiBadge>
              <span class="font-mono text-sm text-carbon truncate">{{ w.worker }}</span>
              <!-- The ledger and the platform can disagree: a run that OVERRUNS the
                   dispatch budget finishes and records success here, while the cron
                   trigger gives up waiting and the platform reports a FAILED
                   execution and retries it. Without this chip that worker reads
                   'ok' on this card and red in Azure, and only someone holding both
                   views can tell. -->
              <UiBadge
                v-if="w.dispatchBudget === 'over' || w.dispatchBudget === 'near'"
                :kind="w.dispatchBudget === 'over' ? 'rag-red' : 'rag-amber'"
                :data-testid="`admin-diag-worker-${w.worker}-budget`"
              >
                {{ w.dispatchBudget === 'over' ? 'over dispatch budget' : 'near dispatch budget' }}
              </UiBadge>
            </div>
            <div class="text-right">
              <div class="text-xs text-carbon-3">{{ fmtWorkerRun(w.durationMs, w.ageMinutes) }}</div>
              <div
                v-if="w.consecutiveFailures > 0"
                class="text-[11px] font-bold text-brand-hunger"
                :data-testid="`admin-diag-worker-${w.worker}-fails`"
              >
                {{ w.consecutiveFailures }} consecutive failure{{ w.consecutiveFailures === 1 ? '' : 's' }}
              </div>
            </div>
            </div>
            <p
              v-if="w.dispatchBudgetReason"
              class="mt-1 text-[11px] text-brand-hunger max-w-3xl"
              :data-testid="`admin-diag-worker-${w.worker}-budget-reason`"
            >
              {{ w.dispatchBudgetReason }}
            </p>
          </li>
        </ul>
        <p v-else class="text-sm text-carbon-3 italic">
          No worker runs recorded yet. Runs appear once the scheduler dispatches a worker.
        </p>
      </UiCard>

      <!-- Turning a worker on/off is an ACTION and lives on its own Operations
           page; this page observes. The link stays because the two questions are
           adjacent: you disable a worker because its health here is bad. -->
      <p class="lg:col-span-2 text-xs text-carbon-3 -mt-1">
        To turn a worker off, go to
        <NuxtLink to="/admin/workers" class="text-brand-harmony underline" data-testid="link-worker-controls">
          Worker controls
        </NuxtLink>. A disabled worker keeps recording a
        <span class="font-mono">skipped</span> run above, so it never looks like a silent gap.
      </p>

      <!-- Costing rungs. The ladder is: 1) the provider's reported cost,
           2) the rate card, 3) skip the span. A healthy fleet is ENTIRELY
           provider-priced, so any rate-card-priced span is an ALERT state, not
           a statistic — a model the provider stopped pricing is billed from our
           own table and stays wrong until someone writes a rate line. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-costing-rungs">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Costing rungs (who priced the span)</UiEyebrow>
          <UiBadge :kind="costingBadge.kind" data-testid="admin-diag-costing-badge">{{ costingBadge.label }}</UiBadge>
        </div>

        <template v-if="data.costingRungs?.spans > 0">
          <!-- The alert state comes FIRST and loudest when it is live. -->
          <template v-if="data.costingRungs.rateCard > 0">
            <h2 class="text-lg font-bold text-brand-hunger" data-testid="admin-diag-costing-headline">
              {{ data.costingRungs.rateCard.toLocaleString() }}
              span{{ data.costingRungs.rateCard === 1 ? '' : 's' }} fell back to the rate card
              <!-- The share is OF THE LADDER-PRICED SPANS (provider + rate-card),
                   not of every span in the window: backfill traffic lands in
                   `other` and must not be able to dilute a real fallback rate. -->
              <span class="text-sm font-medium text-carbon-3">
                — {{ data.costingRungs.rateCardPct ?? 0 }}% of
                {{ data.costingRungs.ladderSpans.toLocaleString() }} priced
                ({{ data.costingRungs.windowDays }}d)
              </span>
            </h2>
            <p class="text-xs text-brand-hunger mt-2">
              The provider reported no cost for these spans, so they were priced from our own
              rate card. That is not a costing mechanism — it is the exception that raises this
              alert. Expect the figure to be wrong for any model without a current rate line.
            </p>
            <div
              v-if="data.costingRungs.fallbackModels.length"
              class="mt-3"
              data-testid="admin-diag-costing-fallback"
            >
              <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">
                Models falling back
              </div>
              <ul class="divide-y divide-carbon-6">
                <li
                  v-for="m in data.costingRungs.fallbackModels"
                  :key="m.model"
                  class="flex items-center justify-between py-1.5 text-sm"
                  :data-testid="`admin-diag-costing-fallback-${m.model}`"
                >
                  <span class="font-mono text-carbon truncate">{{ m.model }}</span>
                  <span class="text-xs text-brand-hunger font-bold">
                    {{ m.spans.toLocaleString() }} span{{ m.spans === 1 ? '' : 's' }}
                  </span>
                </li>
              </ul>
            </div>
          </template>
          <!-- Nothing on the ladder: say so rather than report a vacuous all-clear. -->
          <template v-else-if="data.costingRungs.ladderSpans === 0">
            <h2 class="text-lg font-bold text-carbon" data-testid="admin-diag-costing-headline">
              No spans were priced in the last {{ data.costingRungs.windowDays }} days
            </h2>
            <p class="text-xs text-carbon-3 mt-2">
              The window holds only backfill / telemetry-only spans, so there is nothing to
              judge. This is not a clean bill of health.
            </p>
          </template>
          <template v-else>
            <h2 class="text-lg font-bold text-carbon" data-testid="admin-diag-costing-headline">
              All {{ data.costingRungs.provider.toLocaleString() }} priced spans came from the provider
              <span class="text-sm font-medium text-carbon-3">
                (last {{ data.costingRungs.windowDays }} days)
              </span>
            </h2>
            <p class="text-xs text-carbon-3 mt-2">
              The provider states what each span cost and we record it. Nothing was re-derived from
              our rate card, so a newly-released model is priced correctly the day it appears.
            </p>
          </template>

          <!-- Every span in the window is accounted for, so the numbers add up
               and no bucket can hide. `other` is the backfill / telemetry-only
               provenance lane — neither rung, and not an alert. -->
          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="admin-diag-costing-counts">
            <UiBadge :kind="data.costingRungs.provider > 0 ? 'rag-green' : 'neutral'">
              provider {{ data.costingRungs.provider.toLocaleString() }}
            </UiBadge>
            <UiBadge :kind="data.costingRungs.rateCard > 0 ? 'rag-red' : 'neutral'">
              rate card {{ data.costingRungs.rateCard.toLocaleString() }}
            </UiBadge>
            <UiBadge kind="neutral">other {{ data.costingRungs.other.toLocaleString() }}</UiBadge>
          </div>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon-2">No Claude spans in the window</h2>
          <p class="text-xs text-carbon-3 mt-1">
            Nothing to rung. Spans appear here as usage lands in the last
            {{ data.costingRungs?.windowDays ?? 7 }} days. Copilot is excluded — it is priced from
            AI credits and never used a rate card.
          </p>
        </template>
      </UiCard>

      <!-- Cost drift (migs 0045/0091): our rate-card ESTIMATE vs the provider's
           own figure per span, last 7 days, across both cost vintages. Since the
           cutover this no longer governs the booked total (that IS the provider's
           number) — it governs the per-token-type SLICE and tells us when the
           card needs a rate line. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-cost-drift">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Cost drift (rate card vs provider)</UiEyebrow>
          <UiBadge :kind="driftBadge.kind" data-testid="admin-diag-drift-badge">{{ driftBadge.label }}</UiBadge>
        </div>
        <template v-if="data.costDrift?.spansCompared > 0">
          <h2 class="text-lg font-bold text-carbon">
            {{ data.costDrift.meanAbsDriftPct ?? 0 }}% mean drift
            <span class="text-sm font-medium text-carbon-3">across {{ data.costDrift.spansCompared.toLocaleString() }} spans (7d)</span>
          </h2>
          <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-drift-vintages">
            <span class="font-bold">{{ data.costDrift.providerPricedSpans.toLocaleString() }}</span>
            provider-priced ·
            <span class="font-bold">{{ data.costDrift.rateCardPricedSpans.toLocaleString() }}</span>
            rate-card-priced. Both vintages are compared the same way — our estimate against the
            provider's figure — so the number stays meaningful as history ages out.
          </p>
          <p v-if="data.costDrift.worstSpan" class="text-xs text-carbon-3 mt-2">
            Worst span: <span class="font-mono">{{ data.costDrift.worstSpan.model }}</span>
            (<span class="font-mono">{{ data.costDrift.worstSpan.pricedBy }}</span>) —
            rate-card ${{ data.costDrift.worstSpan.rateCardCostUsd }} vs provider ${{ data.costDrift.worstSpan.lawCostUsd }}
            (Δ ${{ data.costDrift.worstSpan.driftUsd }}).
          </p>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon-2">No comparable spans yet</h2>
          <p class="text-xs text-carbon-3 mt-1">
            A span is comparable once BOTH numbers exist for it: the provider's
            <span class="font-mono">law_cost_usd</span> and our rate-card estimate (which for a
            provider-priced span is persisted as
            <span class="font-mono">metadata.rate_card_cost_usd</span>). Spans missing either are
            left out rather than compared against themselves.
          </p>
        </template>
      </UiCard>

      <!-- Postgres -->
      <UiCard accent="harmony" data-testid="admin-diag-postgres">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Postgres</UiEyebrow>
          <UiBadge :kind="pgBadge.kind">{{ pgBadge.label }}</UiBadge>
        </div>
        <h2 class="text-lg font-bold text-carbon">{{ data.postgres.latencyMs }}ms</h2>
        <p class="text-xs text-carbon-3 mt-1">SELECT 1 round-trip via withRequestRls.</p>
        <dl class="mt-4 space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Active migration</dt>
            <dd class="font-mono text-[11px] text-carbon break-all max-w-[60%] text-right">
              {{ data.postgres.activeMigration ?? '—' }}
            </dd>
          </div>
        </dl>
        <p v-if="data.postgres.error" class="mt-3 text-xs text-brand-hunger font-mono">
          {{ data.postgres.error }}
        </p>
      </UiCard>

      <!-- Redis -->
      <UiCard accent="vision" data-testid="admin-diag-redis">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Redis</UiEyebrow>
          <UiBadge :kind="redisUnavailable ? 'neutral' : 'rag-green'">
            {{ redisUnavailable ? 'unavailable' : 'ok' }}
          </UiBadge>
        </div>
        <template v-if="redisUnavailable">
          <h2 class="text-lg font-bold text-carbon-2">Not wired</h2>
          <p class="text-xs text-carbon-3 mt-1">
            {{ ('unavailable' in (data.redis ?? {})) ? (data.redis as { reason: string }).reason : 'Redis client not yet installed in MVP-Final.' }}
          </p>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon">
            {{ (data.redis as { latencyMs: number }).latencyMs }}ms
          </h2>
        </template>
      </UiCard>

      <!-- Private-endpoint reachability (same TCP probe the boot pre-flight runs) -->
      <UiCard accent="harmony" data-testid="admin-diag-services">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Private endpoints</UiEyebrow>
          <UiBadge :kind="servicesBadge.kind">{{ servicesBadge.label }}</UiBadge>
        </div>
        <p class="text-xs text-carbon-3 mt-1">
          TCP reachability of each provisioned PE — the same probe run at boot. <span class="text-brand-hunger">*</span> = boot-critical.
        </p>
        <ul v-if="data.services?.length" class="mt-3 divide-y divide-carbon-6">
          <li
            v-for="s in data.services"
            :key="s.name"
            class="flex items-center justify-between py-2 text-sm"
            :data-testid="`admin-diag-service-${s.name}`"
          >
            <span class="text-carbon-2">
              {{ s.name }}<span v-if="s.critical" class="text-brand-hunger" title="boot-critical"> *</span>
            </span>
            <span
              class="font-mono text-[11px]"
              :class="s.status === 'unreachable' ? 'text-brand-hunger' : s.status === 'skipped' ? 'text-carbon-3' : 'text-carbon'"
            >
              {{ svcDetail(s) }}
            </span>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-carbon-2">No probes reported.</p>
      </UiCard>

      <!-- Telemetry read path (Log Analytics query, incl. the AMPLS private endpoint) -->
      <UiCard accent="vision" data-testid="admin-diag-telemetry-read">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Telemetry read (LAW)</UiEyebrow>
          <UiBadge :kind="data.telemetryRead?.ok ? 'rag-green' : 'rag-red'">
            {{ data.telemetryRead?.ok ? 'ok' : 'unreachable' }}
          </UiBadge>
        </div>
        <h2 v-if="data.telemetryRead?.ok" class="text-lg font-bold text-carbon">{{ data.telemetryRead.latencyMs }}ms</h2>
        <h2 v-else class="text-lg font-bold text-carbon-2">No read</h2>
        <p class="text-xs text-carbon-3 mt-1">
          Trivial KQL via the {{ data.telemetryRead?.kind ?? 'configured' }} reader — DNS → the (private) query endpoint + token.
        </p>
        <p
          v-if="data.telemetryRead && !data.telemetryRead.ok && data.telemetryRead.error"
          class="mt-3 text-xs text-brand-hunger font-mono break-all"
        >
          {{ data.telemetryRead.error }}
        </p>
      </UiCard>

      <!-- Queues -->
      <UiCard accent="zeal" data-testid="admin-diag-queues">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Queues</UiEyebrow>
          <UiBadge :kind="queuesUnavailable ? 'neutral' : 'rag-green'">
            {{ queuesUnavailable ? 'unavailable' : 'live' }}
          </UiBadge>
        </div>
        <template v-if="queuesUnavailable">
          <h2 class="text-lg font-bold text-carbon-2">Not wired</h2>
          <p class="text-xs text-carbon-3 mt-1">
            BullMQ workers land in a later slice. No queue surface to probe.
          </p>
        </template>
        <template v-else>
          <dl class="space-y-2 text-sm">
            <div
              v-for="(v, name) in (data.queues as Record<string, { depth: number }>)"
              :key="name"
              class="flex items-center justify-between"
            >
              <dt class="text-carbon-2 font-mono">{{ name }}</dt>
              <dd class="font-mono text-xs text-carbon">depth: {{ v.depth }}</dd>
            </div>
          </dl>
        </template>
      </UiCard>

      <!-- Last sync -->
      <UiCard accent="hunger" data-testid="admin-diag-last-sync">
        <UiEyebrow>Last sync</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-3">Per-source recency</h2>
        <dl v-if="data.lastSync.length" class="space-y-2 text-sm">
          <div v-for="s in data.lastSync" :key="s.source" class="flex items-center justify-between">
            <dt class="text-carbon-2 font-mono">{{ s.source }}</dt>
            <dd class="font-mono text-xs text-carbon">{{ fmtTs(s.ts) }}</dd>
          </div>
        </dl>
        <p v-else class="text-sm text-carbon-3 italic">No sync rows yet. Manual-mode region.</p>
      </UiCard>

      <!-- Environment -->
      <UiCard data-testid="admin-diag-env">
        <UiEyebrow>Environment</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-3">Runtime</h2>
        <dl class="space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">NODE_ENV</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.nodeEnv }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Container revision</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.containerInfo.revision ?? '—' }}</dd>
          </div>
        </dl>
      </UiCard>
    </div>
    <div v-else-if="pending" class="text-center text-sm text-carbon-3 py-8">Loading…</div>

    <!-- Dev-troubleshooting cards. Independent of the main /diagnostics fetch:
         each owns its own fetch + error state so one failing (or a 403) cannot
         blank the other card or the rest of the page. -->
    <div class="grid grid-cols-1 gap-5 mt-5">
      <!-- Card A — Private Link / DNS validation. Per provisioned host: does DNS
           resolve to a private address (zone linked) and is the port reachable?
           The "Copy IT report" button hands a plain-text artefact to networking. -->
      <UiCard accent="harmony" class="lg:col-span-2" data-testid="admin-diag-network">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Private Link / DNS validation</UiEyebrow>
          <div class="flex items-center gap-2">
            <UiButton
              kind="secondary"
              size="sm"
              :disabled="netPending"
              data-testid="admin-diag-network-refresh"
              @click="refreshNet()"
            >
              {{ netPending ? 'Refreshing…' : 'Refresh' }}
            </UiButton>
            <UiButton
              v-if="netData"
              kind="primary"
              size="sm"
              data-testid="admin-diag-network-copy-it"
              @click="copyItReport()"
            >
              {{ itCopied ? 'Copied ✓' : 'Copy IT report' }}
            </UiButton>
          </div>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>platform-admin</strong> — region admins and global-finops will see a 403
          here. Resolves and TCP-dials every private-link host the app depends on.
        </p>

        <!-- A 403 here is EXPECTED for a region admin / global-finops (this
             probe is now platform-admin-only, matching the OTel card) —
             render it as a calm scoped-out note, not an alarming error.
             Genuine failures (500 / network) keep the red treatment. -->
        <p v-if="netError && netError.statusCode === 403" class="text-sm text-carbon-3" data-testid="admin-diag-network-scoped">
          Scoped out — this probe is platform-admin only, so your role can't read private-link/DNS
          validation. Nothing is wrong; every other card above still applies to your region.
        </p>
        <p v-else-if="netError" class="text-sm text-brand-hunger font-mono" data-testid="admin-diag-network-error">
          Could not load network validation: {{ netError.statusCode ?? '' }} {{ netError.statusMessage ?? netError.message }}
        </p>
        <template v-else-if="netData">
          <p class="text-xs text-carbon-3">
            {{ netData.generatedNote }} <span class="font-mono">{{ netData.vnetHint }}</span>
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="admin-diag-network-summary">
            <UiBadge kind="neutral">total {{ netData.summary.total }}</UiBadge>
            <UiBadge :kind="netData.summary.ok > 0 ? 'rag-green' : 'neutral'">ok {{ netData.summary.ok }}</UiBadge>
            <UiBadge :kind="netData.summary.zoneNotLinked > 0 ? 'rag-red' : 'neutral'">zone-not-linked {{ netData.summary.zoneNotLinked }}</UiBadge>
            <UiBadge :kind="netData.summary.unreachable > 0 ? 'rag-red' : 'neutral'">unreachable {{ netData.summary.unreachable }}</UiBadge>
            <UiBadge :kind="netData.summary.dnsFail > 0 ? 'rag-red' : 'neutral'">dns-fail {{ netData.summary.dnsFail }}</UiBadge>
          </div>

          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Service</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Host</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Resolved IP(s)</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">DNS</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Reachable</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Expected zone</th>
                  <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr
                  v-for="r in netRecords"
                  :key="`${r.service}-${r.host}-${r.port}`"
                  class="hover:bg-brand-harmony-sheer/30 align-top"
                  :data-testid="`admin-diag-network-row-${r.service}`"
                >
                  <td class="px-3 py-2 text-carbon">
                    {{ r.service }}
                    <div class="text-[10px] uppercase tracking-[0.5px] text-carbon-3">{{ r.category }}</div>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">{{ r.host }}:{{ r.port }}</td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">
                    <span v-if="r.addresses.length">{{ r.addresses.join(', ') }}</span>
                    <span v-else class="text-carbon-3">—</span>
                    <div v-if="r.dnsError" class="text-[10px] text-brand-hunger break-all">{{ r.dnsError }}</div>
                  </td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="privBadge(r.resolvesPrivate).kind">{{ privBadge(r.resolvesPrivate).label }}</UiBadge>
                  </td>
                  <td
                    class="px-3 py-2 font-mono text-[11px]"
                    :class="r.reachable === false ? 'text-brand-hunger' : 'text-carbon'"
                  >
                    {{ reachText(r) }}
                    <div v-if="r.tcpError" class="text-[10px] text-brand-hunger break-all">{{ r.tcpError }}</div>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-carbon-2 break-all">{{ r.expectedZone }}</td>
                  <td class="px-3 py-2">
                    <UiBadge :kind="verdictBadge(r.verdict).kind">{{ verdictBadge(r.verdict).label }}</UiBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else-if="netPending" class="text-sm text-carbon-3 italic">Loading network validation…</p>
        <p v-else class="text-sm text-carbon-3 italic">No network validation reported.</p>
      </UiCard>

      <!-- Card B — OTel telemetry (Log Analytics). Platform-admin only; a region
           admin gets a 403 which renders as a status message. Failed KQL probes
           show the raw, un-truncated Azure error packet for the operator. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-otel">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>OTel telemetry (Log Analytics)</UiEyebrow>
          <UiButton
            kind="secondary"
            size="sm"
            :disabled="otelPending"
            data-testid="admin-diag-otel-refresh"
            @click="refreshOtel()"
          >
            {{ otelPending ? 'Refreshing…' : 'Refresh' }}
          </UiButton>
        </div>
        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>platform-admin</strong> — region admins will see a 403 here. Probes the
          Log Analytics query path the worker reads telemetry from.
        </p>

        <!-- A 403 here is EXPECTED for a region admin (platform-admin-only
             probe) — render it as a calm scoped-out note, not an alarming
             error. Genuine failures (500 / network) keep the red treatment. -->
        <p v-if="otelError && otelError.statusCode === 403" class="text-sm text-carbon-3" data-testid="admin-diag-otel-scoped">
          Scoped out — this probe is platform-admin only, so your role can't read the Log Analytics
          query path. Nothing is wrong; every other card above still applies to your region.
        </p>
        <p v-else-if="otelError" class="text-sm text-brand-hunger font-mono" data-testid="admin-diag-otel-error">
          Could not load OTel diagnostics: {{ otelError.statusCode ?? '' }} {{ otelError.statusMessage ?? otelError.message }}
        </p>
        <template v-else-if="otelData">
          <!-- config + queryEndpointNote key/value block -->
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Telemetry reader</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.config.telemetryReader ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Workspace id set</dt>
              <dd class="font-mono text-[11px] text-carbon">{{ otelData.config.workspaceIdSet ? 'yes' : 'no' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">MI client id</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.config.miClientId ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Logs endpoint host</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.config.logsEndpointHost ?? '—' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Window</dt>
              <dd class="font-mono text-[11px] text-carbon">{{ otelData.hours }}h · limit {{ otelData.limit }} · {{ otelData.duration }}</dd>
            </div>
          </dl>
          <p class="text-xs text-carbon-3 mt-2">{{ otelData.queryEndpointNote }}</p>

          <!-- DNS rows -->
          <div v-if="otelData.dns?.length" class="mt-4">
            <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">DNS</div>
            <ul class="divide-y divide-calm-2">
              <li v-for="d in otelData.dns" :key="d.host" class="flex items-center justify-between gap-3 py-2 text-sm">
                <span class="font-mono text-[11px] text-carbon break-all">{{ d.host }}</span>
                <span class="flex items-center gap-2 min-w-0">
                  <span class="font-mono text-[11px] text-carbon-2 break-all text-right">
                    {{ d.error ? d.error : (d.addresses?.join(', ') || '—') }}
                  </span>
                  <UiBadge v-if="!d.error" :kind="privBadge(d.resolvesPrivate).kind">{{ privBadge(d.resolvesPrivate).label }}</UiBadge>
                  <UiBadge v-else kind="rag-red">dns-fail</UiBadge>
                </span>
              </li>
            </ul>
          </div>

          <!-- Per-query collapsible rows -->
          <div class="mt-4">
            <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">Queries</div>
            <ul class="divide-y divide-calm-2">
              <li v-for="q in otelData.queries" :key="q.label" class="py-2" :data-testid="`admin-diag-otel-query-${q.label}`">
                <button
                  type="button"
                  class="w-full flex items-center justify-between gap-3 text-left"
                  @click="toggleQuery(q.label)"
                >
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="font-mono text-[10px] text-carbon-3">{{ expandedQueries[q.label] ? '▾' : '▸' }}</span>
                    <span class="text-sm text-carbon truncate">{{ q.label }}</span>
                  </span>
                  <span class="flex items-center gap-2 shrink-0">
                    <span class="text-[11px] text-carbon-3">{{ q.latencyMs }}ms</span>
                    <UiBadge :kind="q.ok ? 'rag-green' : 'rag-red'">{{ q.ok ? 'ok' : (q.status ?? 'error') }}</UiBadge>
                  </span>
                </button>
                <div v-if="expandedQueries[q.label]" class="mt-2">
                  <pre class="text-[10px] text-carbon-3 font-mono whitespace-pre-wrap break-all bg-calm-2/40 rounded-md p-2">{{ q.kql }}</pre>
                  <!-- success: compact table of rows -->
                  <div v-if="q.ok && q.columns?.length" class="mt-2 overflow-x-auto">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
                          <th
                            v-for="c in q.columns"
                            :key="c"
                            class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2"
                          >
                            {{ c }}
                          </th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-calm-2">
                        <tr v-for="(row, idx) in (q.rows ?? [])" :key="idx" class="hover:bg-brand-harmony-sheer/30">
                          <td
                            v-for="c in q.columns"
                            :key="c"
                            class="px-3 py-2 font-mono text-[11px] text-carbon break-all"
                          >
                            {{ row[c] ?? '—' }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p v-if="!(q.rows?.length)" class="text-xs text-carbon-3 italic mt-1">No rows in window.</p>
                  </div>
                  <!-- failure: raw Azure error packet, un-truncated -->
                  <div v-else-if="!q.ok && (q.error || q.partialError)" class="mt-2">
                    <p class="text-xs text-brand-hunger mb-1">
                      <span v-if="q.error?.code" class="font-mono">code: {{ q.error.code }}</span>
                      <span v-if="q.error?.statusCode" class="font-mono ml-2">status: {{ q.error.statusCode }}</span>
                    </p>
                    <pre class="text-[10px] text-brand-hunger font-mono whitespace-pre-wrap break-all bg-brand-hunger-lite/40 rounded-md p-2">{{ pretty(q.error ?? q.partialError) }}</pre>
                  </div>
                </div>
              </li>
            </ul>
          </div>

          <!-- top-level client / fatal error packets -->
          <div v-if="otelData.clientError || otelData.fatalError" class="mt-3">
            <pre class="text-[10px] text-brand-hunger font-mono whitespace-pre-wrap break-all bg-brand-hunger-lite/40 rounded-md p-2">{{ pretty(otelData.fatalError ?? otelData.clientError) }}</pre>
          </div>
        </template>
        <p v-else-if="otelPending" class="text-sm text-carbon-3 italic">Loading OTel diagnostics…</p>
        <p v-else class="text-sm text-carbon-3 italic">No OTel diagnostics reported.</p>
      </UiCard>

      <!--
        Attribution gaps — devices that ARE emitting while their spend is not
        being attributed. This is the outage class that hid for 19 days: emit
        auth green, Azure accepting exports (204), nothing landing. Same
        predicate the attribution-gap worker alerts on.
      -->
      <!--
        §A/§B decomposition — the Workstream A gate.

        A single "chargeable exceeds attributed by $X" number invites the wrong
        conclusion (money is leaking). It usually is not: most of the gap is
        surfaces Claude Code never emits for. The card's job is to show the gap
        already ACCOUNTED FOR, term by term, and to state whether the residual
        closes. A non-zero residual is the only figure here that means something
        is actually wrong.
      -->
      <UiCard
        v-if="canSeeEstateFinance"
        accent="vision"
        class="lg:col-span-2"
        data-testid="admin-diag-ab-decomposition"
      >
        <div class="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 class="text-sm font-bold text-carbon">Chargeable vs attributed (§B − §A)</h2>
            <p class="text-xs text-carbon-3 mt-0.5">
              Why billed spend does not equal attributed spend, decomposed into named terms. The
              residual is the part no term explains — it should be zero.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <input
              v-model="abMonth"
              type="month"
              class="text-xs border border-carbon-6 rounded px-2 py-1 bg-white"
              data-testid="admin-diag-ab-month"
            >
            <UiButton kind="secondary" size="sm" :disabled="abPending" @click="refreshAb()">
              {{ abPending ? 'Computing…' : 'Refresh' }}
            </UiButton>
          </div>
        </div>

        <p v-if="abError && !abPending" class="text-sm text-brand-hunger">
          Could not load the decomposition ({{ abError.statusCode ?? 'network error' }}). Use
          Refresh to retry.
        </p>
        <template v-else-if="abData">
          <p v-if="!abData.reachable" class="text-sm text-brand-hunger">
            Probe failed: {{ abData.error }}
          </p>
          <template v-else>
            <div class="flex flex-wrap gap-6 mb-3">
              <div>
                <p class="text-xs text-carbon-3">Attributed (§A)</p>
                <p class="text-sm font-bold text-carbon" data-testid="admin-diag-ab-section-a">
                  {{ abUsd(abData.sectionA) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-carbon-3">Chargeable (§B)</p>
                <p class="text-sm font-bold text-carbon" data-testid="admin-diag-ab-section-b">
                  {{ abUsd(abData.sectionB) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-carbon-3">Delta</p>
                <p class="text-sm font-bold text-carbon" data-testid="admin-diag-ab-delta">
                  {{ abUsd(abData.delta) }}
                </p>
              </div>
            </div>

            <table class="w-full text-xs mb-3">
              <thead>
                <tr class="text-carbon-3 text-left">
                  <th class="py-1 pr-3 font-medium">Term</th>
                  <th class="py-1 pr-3 font-medium text-right">Amount</th>
                  <th class="py-1 font-medium">What it is</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="term in abData.termOrder"
                  :key="term"
                  class="border-t border-carbon-6"
                  :data-testid="`admin-diag-ab-term-${term}`"
                >
                  <td class="py-1 pr-3">{{ AB_TERM_LABELS[term] ?? term }}</td>
                  <td class="py-1 pr-3 text-right font-mono">{{ abUsd(abData.terms[term]) }}</td>
                  <td class="py-1 text-carbon-3">{{ AB_TERM_HINTS[term] }}</td>
                </tr>
                <tr class="border-t-2 border-carbon-5 font-bold">
                  <td class="py-1 pr-3">Residual (unexplained)</td>
                  <td
                    class="py-1 pr-3 text-right font-mono"
                    :class="abData.verdict === 'residual-non-zero' ? 'text-brand-hunger' : 'text-brand-harmony'"
                    data-testid="admin-diag-ab-residual"
                  >
                    {{ abUsd(abData.residual) }}
                  </td>
                  <td class="py-1 text-carbon-3 font-normal">
                    Anything other than zero means a term is missing or wrong.
                  </td>
                </tr>
              </tbody>
            </table>

            <p
              v-if="abData.verdict === 'residual-non-zero'"
              class="text-sm text-brand-hunger"
              data-testid="admin-diag-ab-verdict"
            >
              <strong>Residual is not zero.</strong> The decomposition is no longer exhaustive
              against real data, so no claim about which term dominates can be trusted. Workstream A
              must not ship on this reading.
            </p>
            <p
              v-else-if="abData.verdict === 'no-delta'"
              class="text-sm text-carbon-3"
              data-testid="admin-diag-ab-verdict"
            >
              No gap in this period — chargeable and attributed agree.
            </p>
            <p
              v-else-if="abData.verdict === 'non-code-dominates'"
              class="text-sm text-brand-harmony"
              data-testid="admin-diag-ab-verdict"
            >
              <strong>Non-Code surfaces dominate</strong>
              ({{ Math.round((abData.nonCodeShareOfExplained ?? 0) * 100) }}% of the summed size of
              all terms, ignoring their signs — not a share of the net gap, which offsetting terms
              can make far smaller than the money moving through them). This is the design's premise
              holding: most of the money moving between the two sides is spend on surfaces Claude
              Code never emits for, not attribution failing.
            </p>
            <p
              v-else-if="abNonCodeIsZero"
              class="text-sm text-carbon-3"
              data-testid="admin-diag-ab-verdict"
            >
              <strong>No reading.</strong> This estate carries no non-Code spend at all, so the
              question the gate asks has nothing to bite on. The residual closes, which says the
              arithmetic is sound; the 0% share says nothing either way and is not evidence
              against the design. Run this against an estate with non-Code surfaces present
              before treating the gate as answered.
            </p>
            <p v-else class="text-sm text-brand-hunger" data-testid="admin-diag-ab-verdict">
              <strong>Non-Code surfaces do NOT dominate</strong>
              (only {{ Math.round((abData.nonCodeShareOfExplained ?? 0) * 100) }}% of the summed
              size of all terms, ignoring their signs — not a share of the net gap, which
              offsetting terms can make far smaller than the money moving through them). Non-Code
              spend is present but outweighed. The residual closes, so the arithmetic is sound —
              the design's central premise does not hold for this estate, and the largest term
              should be understood before Workstream A ships.
            </p>

            <!--
              Unconditional, for the same reason as the unhomed line below: the
              quarantine row above points here, and a pointer that disappears
              exactly when the value is zero is a dangling reference in the most
              common case.
            -->
            <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-ab-quarantined">
              <template v-if="Number(abData.diagnostics.quarantinedOtelUsd) !== 0">
                {{ abUsd(abData.diagnostics.quarantinedOtelUsd) }} of telemetry was quarantined as
                uncorroborated. It changes neither side of the gap: where the provider confirms
                the same day it returns to §A through reconciliation and §B bills it, and where
                nothing confirms it, it enters neither. But a large figure means devices are
                emitting spend the provider will not confirm.
              </template>
              <template v-else>
                No telemetry was quarantined in this window: nothing was disowned as
                uncorroborated, so no attributed spend was dropped from §A.
              </template>
            </p>

            <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-ab-coding-agent">
              <template v-if="Number(abData.diagnostics.codingAgentInSectionAUsd) !== 0">
                {{ abUsd(abData.diagnostics.codingAgentInSectionAUsd) }} of coding-agent spend is
                now visible to §A. The coding-agent term above is a pure sum of the provider
                figure and does not net this off, so that money is being counted twice. The
                residual will NOT show it: the usage grain gap below is computed as a remainder,
                so it falls by the same amount and the two offset. This line is the only signal
                that fires, and it needs a code change, not an operator action.
              </template>
              <template v-else>
                Coding-agent spend remains invisible to §A, as designed, so the coding-agent term
                above counts it once. This line turns into a warning if that ever changes.
              </template>
            </p>

            <!--
              Rendered UNCONDITIONALLY, including at zero. The homing-loss row above tells the
              operator its own $0.00 is uninformative and points here; hiding this line when it
              happens to be zero turns that pointer into a dangling reference in the exact case
              it is most likely to fire. A zero here is also a real answer: every chargeable
              dollar homes to a cost-owning unit.
            -->
            <p class="text-xs text-carbon-3 mt-2" data-testid="admin-diag-ab-unhomed">
              <template v-if="Number(abData.diagnostics.unhomedChargeUsd) !== 0">
                {{ abUsd(abData.diagnostics.unhomedChargeUsd) }} of chargeable spend has no
                cost-owning unit. It is inside the §B total above, so it does not affect the
                residual, but it disappears from every per-cost-centre view.
              </template>
              <template v-else>
                No chargeable spend is unhomed: every billed dollar resolves to a cost-owning unit,
                so the per-cost-centre views account for all of §B.
              </template>
            </p>

            <!--
              THE CAUSE SPLIT of the figure immediately above. Exactly ONE
              unhomed total is rendered on this card — the line above — and
              everything below decomposes it. Both come from ONE definition
              (unhomedByMonthSql), but they are TWO statements: the headline is
              computed with §B, the split with its own buckets. On a quiescent
              estate they are byte-identical and the suite pins that; a placement
              committed between the two reads moves one and not the other, and no
              residual on this card can see it. The copy below says so — an
              earlier version of this comment claimed there was "no second query
              that could disagree", which was not true.

              The split's own arithmetic is held to the same bar as the card's:
              it must add back to the total the split itself measured, and a
              non-zero residual suppresses the breakdown rather than presenting
              four plausible numbers that do not add up.
            -->
            <div class="mt-4 pt-3 border-t border-carbon-6" data-testid="admin-diag-unhomed-causes">
              <h3 class="text-sm font-bold text-carbon">Why this spend has no cost-owning unit</h3>
              <p class="text-xs text-carbon-3 mt-0.5 mb-2">
                The figure above, split by the reason the money could not reach a cost-owning unit.
                Every unhomed dollar is in exactly one cause. The causes must add back to the total
                the split itself measured; whatever they do not explain is the residual, and it
                should be zero. The line above is the same definition read a moment earlier, in a
                separate query — if placement changes while this page loads, the two can differ by
                that change and the residual will not show it.
              </p>

              <p
                v-if="!unhomedProbe"
                class="text-sm text-carbon-3"
                data-state="no-reading"
                data-testid="admin-diag-unhomed-state"
              >
                <strong>No reading.</strong> The cause split could not be computed<template
                  v-if="abData.unhomedError"
                > ({{ abData.unhomedError }})</template>. Nothing below should be read as “no spend
                reached this cause” — the question was not answered. The unhomed total above is
                unaffected.
              </p>

              <!--
                An EMPTY month is decided by COUNTING SOURCE ROWS, never by two
                sums netting to zero. Chargeable spend is signed, so a credit note
                can net a month to $0.00 with real billed rows inside it, and the
                sentence below would then hide the money the panel exists to show.
                A zero row count is the only thing that actually means "nothing
                arrived". Keep the predicate and this sentence saying the SAME
                thing — they drifted apart once already.
              -->
              <p
                v-else-if="unhomedNothingToSplit"
                class="text-sm text-carbon-3"
                data-state="not-applicable"
                data-testid="admin-diag-unhomed-state"
              >
                No billed rows reached this month at all, so there is nothing to home and
                nothing to split. This is not a clean bill of health — it is an empty month.
                A month that billed something and netted to zero is not this case, and is
                reported above with its figures.
              </p>

              <template v-else>
                <p
                  v-if="!unhomedReconciles"
                  class="text-sm text-brand-hunger mb-2"
                  data-state="unknown"
                  data-testid="admin-diag-unhomed-state"
                >
                  <strong>The split is incomplete.</strong>
                  {{ abUsd(unhomedProbe.residualUsd) }} of unhomed spend is there for a reason none
                  of the causes describes, so the breakdown is suppressed: it must not be used to
                  size any bucket. This is the same bar the residual above is held to — a split
                  that does not add back to the figure it decomposes is not evidence.
                </p>

                <template v-else>
                  <table class="w-full text-xs mb-2">
                    <thead>
                      <tr class="text-carbon-3 text-left">
                        <th class="py-1 pr-3 font-medium">Cause</th>
                        <th class="py-1 pr-3 font-medium text-right">Amount</th>
                        <th class="py-1 pr-3 font-medium">Behind it</th>
                        <th class="py-1 font-medium">What it is · who fixes it</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="c in unhomedProbe.causes.filter((x) => x.placementFailure)"
                        :key="c.cause"
                        class="border-t border-carbon-6"
                        :data-state="Number(c.usd) === 0 ? 'zero' : 'measured'"
                        :data-testid="`admin-diag-unhomed-cause-${c.cause}`"
                      >
                        <td class="py-1 pr-3">{{ UNHOMED_LABELS[c.cause] }}</td>
                        <td class="py-1 pr-3 text-right font-mono">{{ abUsd(c.usd) }}</td>
                        <td class="py-1 pr-3 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">none</template>
                          <template v-else>{{ unhomedCounts(c) }}</template>
                        </td>
                        <td class="py-1 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">
                            No spend reached this cause this month.
                          </template>
                          <template v-else>
                            {{ UNHOMED_HINTS[c.cause] }}
                            <span class="block mt-0.5 text-carbon-2">
                              Fix: {{ UNHOMED_ACTIONS[c.cause].action }}
                              <strong>Owner: {{ UNHOMED_ACTIONS[c.cause].owner }}.</strong>
                            </span>
                          </template>
                        </td>
                      </tr>
                    </tbody>
                    <!--
                      Separated on purpose (not a fifth row of the same list):
                      pooled money is a DESIGNED residual, not a placement
                      failure. Presented as a peer, a large percentage reads as
                      one problem with one fix, and an operator would size a
                      placement campaign against money no amount of placing can
                      move. It still counts toward the same reconciled total.
                    -->
                    <tbody class="border-t-2 border-carbon-5">
                      <tr
                        v-for="c in unhomedProbe.causes.filter((x) => !x.placementFailure)"
                        :key="c.cause"
                        :data-state="Number(c.usd) === 0 ? 'zero' : 'measured'"
                        :data-testid="`admin-diag-unhomed-cause-${c.cause}`"
                      >
                        <td class="py-1 pr-3">
                          {{ UNHOMED_LABELS[c.cause] }}
                          <span class="block text-[10px] text-carbon-3">not a placement failure</span>
                        </td>
                        <td class="py-1 pr-3 text-right font-mono">{{ abUsd(c.usd) }}</td>
                        <td class="py-1 pr-3 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">none</template>
                          <template v-else>{{ unhomedCounts(c) }}</template>
                        </td>
                        <td class="py-1 text-carbon-3">
                          <template v-if="Number(c.usd) === 0">
                            No spend reached this cause this month.
                          </template>
                          <template v-else>
                            {{ UNHOMED_HINTS[c.cause] }}
                            <span class="block mt-0.5 text-carbon-2">
                              <!--
                                NO REMEDIATION LINK. This card is a read-only
                                probe and says so; a "Fix org homing →" button
                                inside it was an action on a surface that states
                                it has none. The fix is NAMED above and lives on
                                the reconciliation surface, which is where it is
                                done.
                              -->
                              Fix: {{ UNHOMED_ACTIONS[c.cause].action }}
                              <strong>Owner: {{ UNHOMED_ACTIONS[c.cause].owner }}.</strong>
                            </span>
                          </template>
                        </td>
                      </tr>
                      <tr class="border-t-2 border-carbon-5 font-bold">
                        <td class="py-1 pr-3">Unexplained (residual)</td>
                        <td
                          class="py-1 pr-3 text-right font-mono text-brand-harmony"
                          data-state="zero"
                          data-testid="admin-diag-unhomed-residual"
                        >
                          {{ abUsd(unhomedProbe.residualUsd) }}
                        </td>
                        <td class="py-1 pr-3" />
                        <!--
                          SAYS EXACTLY WHAT THIS PROVES, and no more. The residual
                          is total − Σ(causes): it detects money that is in the
                          total and in NO cause. Two things it CANNOT detect, both
                          of which an earlier draft of this copy claimed it could:
                          money in the WRONG cause (moving a dollar between two
                          causes leaves the sum unchanged — the card's own
                          absorption sweep found four such moves with the residual
                          at zero throughout), and a dollar dropped from one cause
                          alongside a dollar double-counted in another, because
                          those cancel inside a single equation over signed sums.
                          Presenting $0.00 as proof the split is complete and
                          un-doubled would be an overstatement on a governance
                          surface. Say only that the causes sum.
                        -->
                        <td class="py-1 text-carbon-3 font-normal">
                          Should be $0.00. Anything else means a dollar is unhomed for a reason
                          none of the causes above describes. The split is then incomplete and must
                          not be used to size any of them.
                          <span class="block mt-0.5">
                            $0.00 means the causes SUM to the figure above, and nothing more than
                            that. It is one equation over signed sums, so it cannot see a dollar
                            dropped from one cause and a dollar double-counted in another — those
                            cancel and it still reads zero. It also does <strong>not</strong> mean
                            every dollar is in the right cause: moving money between two causes
                            leaves the sum unchanged. Read the counts and the worklist below to
                            judge whether a cause is the right one.
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <!--
                    THE WORKLIST. Row type follows the CAUSE, because the thing
                    you would actually fix differs per cause: the two
                    holding-node causes put every teammate on the same one or two
                    nodes, so a unit-keyed row there would name something no
                    admin surface can act on. Every list is capped and SAYS SO,
                    with the money shown against the money in the bucket — a
                    truncated list must never read as the whole bucket.
                  -->
                  <div
                    v-for="w in unhomedVisibleWorklists"
                    :key="`wl-${w.cause}`"
                    class="mb-3"
                    :data-testid="`admin-diag-unhomed-worklist-${w.cause}`"
                  >
                    <p class="text-[11px] font-medium text-carbon-3 mb-1">
                      {{ UNHOMED_LABELS[w.cause] }} —
                      <template v-if="w.shown < w.total">
                        top {{ w.shown }} of {{ w.total }} ·
                        {{ abUsd(w.shownUsd) }} of {{ abUsd(w.bucketUsd) }} shown
                      </template>
                      <template v-else>
                        all {{ w.total }} ·
                        {{ abUsd(w.shownUsd) }} of {{ abUsd(w.bucketUsd) }} shown
                      </template>
                    </p>
                    <table class="w-full text-[11px]">
                      <tbody>
                        <tr
                          v-for="(row, i) in w.rows"
                          :key="`${w.cause}-${i}`"
                          class="border-t border-carbon-6"
                        >
                          <td class="py-1 pr-3">
                            {{ row.label }}
                            <span v-if="row.sublabel" class="text-carbon-3"> · {{ row.sublabel }}</span>
                          </td>
                          <td class="py-1 pr-3 text-carbon-3">{{ row.region ?? '' }}</td>
                          <td class="py-1 pr-3 text-carbon-3">
                            <template v-if="row.headcount !== null">
                              {{ plural(row.headcount, ['person', 'people']) }}
                            </template>
                          </td>
                          <td class="py-1 text-right font-mono">{{ abUsd(row.usd) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>

                <!--
                  What is NOT in the figure. Stops an operator chasing a
                  discrepancy between this number and the unallocated dollars on
                  the reconciliation surface, and stops them concluding the split
                  is wrong when it is merely scoped.
                -->
                <p class="text-[11px] text-carbon-3 mb-3" data-testid="admin-diag-unhomed-scope">
                  This figure covers CHARGEABLE spend only. Unclassified provider bill lines and
                  chargeback-exempt spend can also carry no cost-owning unit; both are outside this
                  number by design and are reported elsewhere.
                </p>

                <!-- ── Can automatic placement work at all? ─────────────────── -->
                <div class="mb-3" data-testid="admin-diag-unhomed-config">
                  <h4 class="text-xs font-bold text-carbon mb-1">Can automatic placement work at all?</h4>
                  <template v-if="!unhomedProbe.placementConfig">
                    <p class="text-[11px] text-carbon-3" data-state="unknown">
                      <strong>Coverage unknown.</strong> The placement configuration could not be
                      read, so this says nothing about whether placement is configured — it is not
                      a zero.
                    </p>
                  </template>
                  <template v-else>
                    <p
                      class="text-[11px] text-carbon-3"
                      :data-state="unhomedProbe.placementConfig.activeCostOwningUnits === 0
                        ? 'not-applicable'
                        : unhomedProbe.placementConfig.unitsWithCostCentreCode === 0 ? 'zero' : 'measured'"
                      data-testid="admin-diag-unhomed-config-codes"
                    >
                      <template v-if="unhomedProbe.placementConfig.activeCostOwningUnits === 0">
                        <strong>No active cost-owning units exist at all.</strong> Nothing can be
                        placed, so no NEW spend can home. Existing rows are not necessarily
                        unhomed: a row keeps whichever cost-owning unit it was stamped with, and a
                        unit that has since been retired still counts as homed here. Read the
                        figure above rather than inferring it from this line.
                      </template>
                      <template v-else-if="unhomedProbe.placementConfig.unitsWithCostCentreCode === 0">
                        <strong>None of the
                          {{ unhomedProbe.placementConfig.activeCostOwningUnits }} active
                          cost-owning units carries a directory cost-centre code</strong>, so
                        the DIRECT cost-centre match can never fire. That is one of two automatic
                        routes: the manager-chain walk below needs no codes and may still place
                        people. If both are unavailable, every bill-driven person lands on a
                        holding node.
                      </template>
                      <template v-else>
                        <strong>{{ unhomedProbe.placementConfig.unitsWithCostCentreCode }} of
                          {{ unhomedProbe.placementConfig.activeCostOwningUnits }} active
                          cost-owning units carry a directory cost-centre code.</strong>
                        A person is placed automatically only when their directory cost centre
                        matches one of these codes — a unit without a code can never be matched,
                        however correct the rest of the tree is.
                      </template>
                    </p>
                    <p
                      class="text-[11px] text-carbon-3 mt-1"
                      :data-state="unhomedProbe.placementConfig.activeOwners === 0 ? 'zero' : 'measured'"
                      data-testid="admin-diag-unhomed-config-owners"
                    >
                      <strong>{{ unhomedProbe.placementConfig.activeOwners }} active cost-centre
                        owners across {{ unhomedProbe.placementConfig.unitsWithActiveOwner }}
                        units.</strong>
                      An owner is the person accountable for a unit’s spend, and ownership is also
                      the signal that places someone by their manager chain when their cost centre
                      does not match. With no owners, neither the accountability nor that placement
                      path exists.
                      <template v-if="unhomedProbe.placementConfig.activeOwners > 0">
                        {{ unhomedProbe.placementConfig.ownersWithDirectoryIdentity }} of them carry
                        a directory identity the manager chain can match on; the rest are counted
                        for accountability but cannot drive placement.
                      </template>
                    </p>
                  </template>
                </div>

                <!-- ── Who can see cost-centre reporting right now ──────────── -->
                <div class="mb-3" data-testid="admin-diag-unhomed-visibility">
                  <h4 class="text-xs font-bold text-carbon mb-1">Who can see cost-centre reporting right now</h4>
                  <p class="text-[11px] text-carbon-3 mb-1">
                    Report visibility is set to <strong>{{ abData.visibility.label }}</strong> —
                    {{ abData.visibility.description }} This is the <strong>capability matrix</strong>
                    for that mode — what each role WOULD be granted, computed from the policy, not
                    from this estate. It does not inspect who actually holds those roles, owns a
                    cost centre, or reads these reports, so it tells you which roles could notice
                    this spend going missing, never how many people that is or whether anyone
                    occupies them.
                    <strong v-if="!abData.visibility.isDefault" data-testid="admin-diag-unhomed-visibility-nondefault">
                      This is not the default mode.
                    </strong>
                    <NuxtLink
                      to="/admin/policies/report-visibility"
                      class="text-brand-harmony hover:underline"
                    >Compare the modes →</NuxtLink>
                  </p>
                  <table class="w-full text-[11px]">
                    <tbody>
                      <tr
                        v-for="p in abData.visibility.personas"
                        :key="p.key"
                        class="border-t border-carbon-6"
                      >
                        <td class="py-1 pr-3 w-40">{{ p.label }}</td>
                        <td class="py-1 text-carbon-3">
                          {{ p.scopes.length ? p.scopes.join(' · ') : 'No reporting scopes' }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- ── Is this getting worse? ───────────────────────────────── -->
                <div data-testid="admin-diag-unhomed-history">
                  <h4 class="text-xs font-bold text-carbon mb-1">Is this getting worse?</h4>
                  <!--
                    No "could not be read" branch: the trend's money comes out of
                    the SAME statement as the figure above it, so a history that
                    could not be read is a probe that could not be read, and the
                    section-level "No reading" above already says so. What CAN
                    fail on its own is a month's finance period, and that is a
                    per-month "Unknown" rather than a blanked trend.
                  -->
                  <p class="text-[11px] text-carbon-3 mb-1">
                    Unhomed chargeable spend by month, against total chargeable spend for the same
                    month. The series is <strong>half live, half snapshot</strong>. Per-teammate
                    spend is re-homed from today’s org tree on every read, so placing someone moves
                    their whole history at once, closed months included. Pooled provider spend is
                    not: each bill row carries the cost-owning unit it was stamped with when that
                    month was pulled, so re-pointing a provider organisation changes nothing here
                    until that month is re-pulled. A step in this trend can therefore be a
                    placement change, a re-pull, or a real event — the three are not
                    distinguishable from this chart alone.
                  </p>
                  <table class="w-full text-[11px]">
                    <tbody>
                      <tr
                        v-for="h in unhomedProbe.history"
                        :key="h.month"
                        class="border-t border-carbon-6"
                        :class="h.selected ? 'font-bold' : ''"
                        :data-state="h.state"
                        :data-testid="`admin-diag-unhomed-history-${h.month}`"
                      >
                        <td class="py-1 pr-3 w-40">
                          {{ unhomedMonthLabel(h.month) }}
                          <span v-if="h.selected" class="text-brand-harmony">· selected</span>
                        </td>
                        <td class="py-1 pr-3">
                          <template v-if="h.state === 'measured'">
                            {{ abUsd(h.unhomedUsd ?? undefined) }} unhomed of
                            {{ abUsd(h.chargeableUsd ?? undefined) }}
                            <!--
                              A month whose chargeable NETS to $0.00 (a credit
                              note, a negative reconciliation) still has real
                              unhomed dollars inside it, and its share is
                              UNDEFINED — not 0%, not Infinity%. Printing an
                              invented percentage here would replace one false
                              statement with another.
                            -->
                            <template v-if="h.sharePct !== null">({{ h.sharePct.toFixed(1) }}%)</template>
                            <template v-else>· share undefined: this month’s chargeable nets to $0.00</template>
                            <span v-if="h.partial" class="text-carbon-3">· month still in progress</span>
                          </template>
                          <template v-else-if="h.state === 'no-spend'">
                            No chargeable spend in this month, and none unhomed either
                          </template>
                          <template v-else>
                            Not measured — before this estate carried any billed data
                          </template>
                        </td>
                        <td
                          class="py-1 text-carbon-3"
                          :title="financePeriodConsequence[financePeriodKey(h.periodState)]"
                          :data-period-state="financePeriodKey(h.periodState)"
                        >
                          {{ FINANCE_PERIOD_WORD[financePeriodKey(h.periodState)] }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p class="text-[11px] text-carbon-3 mt-1" data-testid="admin-diag-unhomed-period-note">
                    {{ financePeriodConsequence.closed }}
                    {{ financePeriodConsequence.open }}
                    A month with no stored finance-period row is open — absence IS open.
                    {{ financePeriodConsequence.unknown }}
                  </p>
                </div>

                <!--
                  PB-1, said out loud rather than left for the reader to
                  discover: this is a whole-estate finance view, and two of the
                  four fixes belong to a Region admin who cannot open this page.
                  The endpoint is global-finops-only because a region filter would
                  drop the pooled lanes from §B and blow the residual for an
                  artefact reason — so the worklist is something to HAND OVER, not
                  a reason to widen who reads it.
                -->
                <p class="text-[11px] text-carbon-3 mt-3" data-testid="admin-diag-unhomed-handover">
                  This is a whole-estate finance view. Placing a person into a unit, and marking a
                  unit cost-owning, are region-scoped actions that belong to the
                  <strong>{{ REGION_ADMIN_LABEL }}</strong> for the region concerned — who cannot
                  see this page. Those rows are work to hand over, not work to do here.
                </p>
              </template>
            </div>
          </template>
        </template>
      </UiCard>

      <UiCard accent="hunger" class="lg:col-span-2" data-testid="admin-diag-attribution-gaps">
        <div class="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 class="text-sm font-bold text-carbon">Attribution gaps</h2>
            <p class="text-xs text-carbon-3 mt-0.5">
              Devices minting ingest credentials (so they are emitting) whose attributed spend has
              fallen days behind. Azure accepting an export does not mean it was attributed.
            </p>
          </div>
          <UiButton kind="secondary" size="sm" :disabled="gapsPending" @click="refreshGaps()">
            {{ gapsPending ? 'Checking…' : 'Re-check' }}
          </UiButton>
        </div>

        <template v-if="gapsData">
          <p v-if="!gapsData.reachable" class="text-sm text-brand-hunger">
            Probe failed: {{ gapsData.error }}
          </p>
          <p v-else-if="gapsData.count === 0" class="text-sm text-brand-harmony">
            No gaps — every live device has attributed spend within the window.
          </p>
          <div v-else>
            <p class="text-sm font-bold text-brand-hunger mb-2">
              {{ gapsData.count }} device{{ gapsData.count === 1 ? '' : 's' }} emitting without attribution
            </p>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-carbon-3 text-left">
                  <th class="py-1 pr-3 font-medium">Teammate</th>
                  <th class="py-1 pr-3 font-medium">Instance</th>
                  <th class="py-1 pr-3 font-medium">Last emitted</th>
                  <th class="py-1 pr-3 font-medium">Last attributed</th>
                  <th class="py-1 pr-3 font-medium">Behind by</th>
                  <th class="py-1 font-medium">Client vs server</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="i in gapsData.instances" :key="i.instanceId">
                  <tr class="border-t border-carbon-6">
                    <td class="py-1 pr-3">{{ i.email ?? '—' }}</td>
                    <td class="py-1 pr-3 font-mono">{{ i.instanceId.slice(0, 8) }}</td>
                    <td class="py-1 pr-3">{{ i.lastBearerAt?.slice(0, 16) }}</td>
                    <td class="py-1 pr-3">{{ i.lastAttributedAt?.slice(0, 16) ?? 'never' }}</td>
                    <td class="py-1 pr-3 font-bold text-brand-hunger">{{ gapDays(i.gapHours) }}</td>
                    <td class="py-1">
                      <UiButton
                        kind="secondary"
                        size="sm"
                        :disabled="diagnosing === i.instanceId"
                        :data-testid="`admin-diag-diagnose-${i.instanceId}`"
                        @click="diagnoseInstance(i.instanceId, i.gapHours)"
                      >
                        {{ diagnosing === i.instanceId ? 'Checking ingest…' : 'Diagnose' }}
                      </UiButton>
                    </td>
                  </tr>
                  <!--
                    The answer to the ONE question that splits the outage in half:
                    is this device's telemetry in ingest at all for the gap window?
                    Rendered under the row it belongs to so the evidence and the
                    verdict are never read apart.
                  -->
                  <tr v-if="diagnosis[i.instanceId]" class="border-t border-carbon-6 bg-calm-1/40">
                    <td colspan="6" class="py-2 px-2">
                      <template v-if="'failed' in diagnosis[i.instanceId]!">
                        <p class="text-xs text-brand-hunger">
                          Probe failed — this is NOT evidence about the device:
                          {{ (diagnosis[i.instanceId] as { failed: string }).failed }}
                        </p>
                      </template>
                      <template v-else>
                        <div class="flex items-center gap-2 mb-1">
                          <UiBadge :kind="telemetryVerdictBadge((diagnosis[i.instanceId] as InstanceTelemetryResp).verdict).kind">
                            {{ telemetryVerdictBadge((diagnosis[i.instanceId] as InstanceTelemetryResp).verdict).label }}
                          </UiBadge>
                          <span class="text-[11px] text-carbon-3">
                            window {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).windowHours }}h
                          </span>
                        </div>
                        <p class="text-xs text-carbon-2 mb-1">
                          {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).interpretation }}
                        </p>
                        <p class="text-[11px] text-carbon-3 font-mono">
                          ingest:
                          <template v-if="(diagnosis[i.instanceId] as InstanceTelemetryResp).ingest.reachable">
                            {{ ((diagnosis[i.instanceId] as InstanceTelemetryResp).ingest as { records: number }).records }} record(s),
                            {{ ((diagnosis[i.instanceId] as InstanceTelemetryResp).ingest as { usageRecords: number }).usageRecords }} usage
                          </template>
                          <template v-else>
                            unreadable ({{ ((diagnosis[i.instanceId] as InstanceTelemetryResp).ingest as { error: string | null }).error }})
                          </template>
                          &nbsp;·&nbsp; ledger: {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).attribution.records }} record(s)
                        </p>
                        <!--
                          Client-asserted (mig 0092). Shown because it is the first
                          thing you want once the verdict says "client side" — and
                          "not reported" is itself the answer: the device is on a
                          build older than the one that reports its version.
                        -->
                        <p class="text-[11px] text-carbon-3 mt-1">
                          client claims — plugin
                          <strong>{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientPluginVersion ?? 'not reported' }}</strong>,
                          CLI
                          <strong>{{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientCliVersion ?? 'not reported' }}</strong>
                          <template v-if="(diagnosis[i.instanceId] as InstanceTelemetryResp).instance?.clientVersionAt">
                            (as of {{ (diagnosis[i.instanceId] as InstanceTelemetryResp).instance!.clientVersionAt!.slice(0, 16) }})
                          </template>
                          — self-reported, not attested.
                        </p>
                      </template>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>

            <!--
              The recovery lever. The reader has always accepted a lookback up to
              90 days; nothing an admin could touch ever passed it, so a backlog
              older than a week was unrecoverable from the product. Enqueue-only:
              a 90-day read cannot be served inside the ~120s worker gateway.
            -->
            <div class="mt-4 pt-3 border-t border-carbon-6" data-testid="admin-diag-recovery">
              <div v-if="canRecover" class="flex flex-wrap items-center gap-3">
                <div>
                  <label class="text-xs text-carbon-3 mr-2" for="recovery-lookback">Re-read window (days)</label>
                  <input
                    id="recovery-lookback"
                    v-model.number="recoveryLookbackDays"
                    type="number"
                    min="1"
                    max="90"
                    class="w-20 text-xs border border-carbon-6 rounded px-2 py-1"
                  >
                </div>
                <UiButton
                  kind="primary"
                  size="sm"
                  :disabled="recoverySubmitting || recoveryData?.inFlight || gapsData.count === 0"
                  data-testid="admin-diag-recovery-submit"
                  @click="requestRecovery()"
                >
                  {{ recoverySubmitting ? 'Queueing…' : `Re-read these ${gapsData.count} device(s)` }}
                </UiButton>
                <p v-if="recoveryData?.inFlight" class="text-xs text-carbon-3">
                  A recovery is already in flight — widened reads run one at a time so they
                  cannot contend for Log Analytics query budget.
                </p>
              </div>
              <p v-else class="text-xs text-carbon-3">
                Requesting a re-read needs the global-finops role — it is not region-bounded and
                it spends Log Analytics query budget. Diagnose above is available to you; the
                progress below is read-only.
              </p>
              <p class="text-[11px] text-carbon-3 mt-2">
                Re-reads the listed devices at a wider ingest window with a full re-scan, so
                already-ingested spend older than the joiner's 7-day default can be joined.
                Queued and drained in slices — <strong>accepted is not recovered</strong>; the
                progress below is what says whether anything was actually written.
              </p>
              <p v-if="recoveryMessage" class="text-xs text-carbon-2 mt-2">{{ recoveryMessage }}</p>

              <div v-if="recoveryData?.requests?.length" class="mt-3">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs font-medium text-carbon-3">Recent recoveries</span>
                  <UiButton kind="secondary" size="sm" :disabled="recoveryPending" @click="refreshRecovery()">
                    {{ recoveryPending ? 'Refreshing…' : 'Refresh' }}
                  </UiButton>
                </div>
                <table class="w-full text-[11px]">
                  <thead>
                    <tr class="text-carbon-3 text-left">
                      <th class="py-1 pr-3 font-medium">Requested</th>
                      <th class="py-1 pr-3 font-medium">Window</th>
                      <th class="py-1 pr-3 font-medium">Status</th>
                      <th class="py-1 pr-3 font-medium">Progress</th>
                      <th class="py-1 pr-3 font-medium">Rows written</th>
                      <th class="py-1 font-medium">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in recoveryData.requests" :key="r.id" class="border-t border-carbon-6">
                      <td class="py-1 pr-3">{{ r.requestedAt?.slice(0, 16) }}</td>
                      <td class="py-1 pr-3">{{ r.lookbackDays }}d</td>
                      <td class="py-1 pr-3">{{ r.status }}<span v-if="r.error"> — {{ r.error }}</span></td>
                      <td class="py-1 pr-3">{{ r.instancesProcessed }}/{{ r.instanceCount }} ({{ r.percentComplete }}%)</td>
                      <!-- Kept visually distinct from progress: 100% processed with
                           zero rows is a real, informative outcome, not a failure. -->
                      <td class="py-1 pr-3 font-bold">{{ r.rowsWritten }}</td>
                      <td class="py-1">{{ r.errors }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </template>
        <p v-else-if="gapsPending" class="text-sm text-carbon-3 italic">Checking attribution gaps…</p>
      </UiCard>

      <!-- Card D — Provider wire shape. Platform-admin only; button-triggered
           because the live mode issues real provider calls. Shape only: a
           successful response body is never rendered. -->
      <UiCard accent="vision" class="lg:col-span-2" data-testid="admin-diag-wire-shape">
        <div class="flex items-center justify-between mb-3">
          <UiEyebrow>Provider wire shape</UiEyebrow>
          <div v-if="canProbeWireShape" class="flex items-center gap-2">
            <UiButton
              kind="secondary"
              size="sm"
              :disabled="wireRunning !== null"
              data-testid="admin-diag-wire-scan-stored"
              @click="runWireShape('stored')"
            >
              {{ wireRunning === 'stored' ? 'Scanning…' : 'Scan stored payloads' }}
            </UiButton>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="wireRunning !== null"
              data-testid="admin-diag-wire-run-live"
              @click="runWireShape('both')"
            >
              {{ wireRunning === 'both' ? 'Probing…' : 'Run live probe' }}
            </UiButton>
            <UiButton
              v-if="wireData"
              kind="secondary"
              size="sm"
              data-testid="admin-diag-wire-copy"
              @click="copyWireReport()"
            >
              {{ wireCopied ? 'Copied ✓' : 'Copy report JSON' }}
            </UiButton>
          </div>
        </div>

        <p class="text-xs text-carbon-3 mb-3">
          Requires <strong>platform-admin</strong>. Reports the <strong>shape</strong> of provider
          payloads — key paths, types and how often each key is present. A successful response body
          is never shown, stored or logged.
          <strong>Scan stored payloads</strong> reads what the pollers already saved: no provider
          call, no credential, no cost. <strong>Run live probe</strong> additionally issues one page
          of each configured provider call for a single recent day.
        </p>

        <p
          v-if="!canProbeWireShape"
          class="text-sm text-carbon-3"
          data-testid="admin-diag-wire-scoped"
        >
          Scoped out — this probe is platform-admin only. Nothing is wrong; every other card on this
          page still applies to your role.
        </p>

        <template v-else>
          <p v-if="wireError" class="text-sm text-brand-hunger font-mono" data-testid="admin-diag-wire-error">
            {{ wireError }}
          </p>

          <template v-if="wireData">
            <p class="text-xs text-carbon-3">
              {{ wireData.generatedAt.slice(0, 19) }}Z · mode <span class="font-mono">{{ wireData.mode }}</span>
              · live day <span class="font-mono">{{ wireData.day }}</span>
            </p>
            <p class="text-xs text-carbon-3 mt-1">{{ wireData.note }}</p>

            <!-- The headline result. These are key paths the payload carries and
                 our Zod schema does not declare — fields TokenScope receives and
                 ignores. This is the defect class the whole card exists for, so
                 it renders above the per-surface detail, never inside it. -->
            <div class="mt-4" data-testid="admin-diag-wire-undeclared">
              <div class="flex items-center gap-2 mb-2">
                <h2 class="text-sm font-bold text-carbon">Received but not declared by our schema</h2>
                <UiBadge :kind="wireUndeclaredTotal > 0 ? 'rag-red' : 'rag-green'">
                  {{ wireUndeclaredTotal }} path{{ wireUndeclaredTotal === 1 ? '' : 's' }}
                </UiBadge>
              </div>
              <p v-if="wireUndeclaredTotal === 0" class="text-xs text-carbon-3">
                No undeclared key paths were observed on any surface reported above. Surfaces that are
                not configured, errored, or returned no rows cannot contribute here — check their
                individual status before reading this as a clean result.
              </p>
              <div v-else class="space-y-2">
                <div
                  v-for="s in wireSurfaces.filter((x) => (x.undeclared?.paths.length ?? 0) > 0)"
                  :key="`undeclared-${s.mode}-${s.id}`"
                  class="border border-calm-2 rounded p-3"
                  :data-testid="`admin-diag-wire-undeclared-${s.mode}-${s.id}`"
                >
                  <div class="text-xs font-bold text-carbon">{{ s.label }} <span class="text-carbon-3">({{ s.mode }})</span></div>
                  <p class="text-[11px] text-carbon-3 mb-1">{{ s.undeclared?.note }}</p>
                  <div class="flex flex-wrap gap-1">
                    <code
                      v-for="p in s.undeclared?.paths"
                      :key="p"
                      class="text-[11px] font-mono bg-brand-hunger-sheer/40 text-carbon px-1.5 py-0.5 rounded"
                    >{{ p }}</code>
                  </div>
                </div>
              </div>
            </div>

            <!-- Per-surface detail. -->
            <div class="mt-5 space-y-3">
              <div
                v-for="s in wireSurfaces"
                :key="`${s.mode}-${s.id}`"
                class="border border-calm-2 rounded p-3"
                :data-testid="`admin-diag-wire-surface-${s.mode}-${s.id}`"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-bold text-carbon">{{ s.label }}</span>
                  <UiBadge kind="neutral">{{ s.mode }}</UiBadge>
                  <UiBadge :kind="wireStatusBadge(s).kind">{{ wireStatusBadge(s).label }}</UiBadge>
                  <UiBadge v-if="s.status === 'ok'" :kind="wireDriftBadge(s.drift).kind">
                    {{ wireDriftBadge(s.drift).label }}
                  </UiBadge>
                  <span v-if="s.status === 'ok'" class="text-xs text-carbon-3">
                    {{ s.summary?.itemCount }} row{{ s.summary?.itemCount === 1 ? '' : 's' }} observed
                  </span>
                </div>
                <div class="text-[11px] font-mono text-carbon-3 break-all mt-1">{{ s.endpoint }}</div>

                <!-- Not configured is a NEUTRAL expected state, not a failure:
                     an environment wired to one Anthropic variant legitimately
                     has no org for the other. -->
                <p v-if="s.status === 'not-configured'" class="text-xs text-carbon-2 mt-2">
                  {{ s.reason }}
                </p>

                <template v-else-if="s.status === 'errored'">
                  <p class="text-xs text-carbon-2 mt-2">
                    HTTP <span class="font-mono font-bold">{{ s.error?.status }}</span>
                    <span v-if="s.error?.status === 0"> — no response received (transport failure)</span>
                  </p>
                  <!-- Raw provider error text, deliberately: a classified reason
                       hides the cause. Credentials are removed; long bodies cut. -->
                  <pre class="mt-1 text-[11px] font-mono bg-calm-1 text-carbon p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">{{ s.error?.bodyText }}</pre>
                  <p v-if="s.error?.truncated" class="text-[11px] text-carbon-3">Body truncated.</p>
                </template>

                <template v-else-if="s.status === 'ok'">
                  <div v-if="s.request" class="mt-2 text-[11px] text-carbon-3">
                    <span class="font-mono">{{ s.request.method }} {{ s.request.path }}</span>
                    <div class="flex flex-wrap gap-1 mt-1">
                      <code
                        v-for="(pair, i) in s.request.params"
                        :key="`${pair[0]}-${i}`"
                        class="font-mono bg-calm-1 px-1.5 py-0.5 rounded"
                      >{{ pair[0] }}={{ pair[1] }}</code>
                    </div>
                    <div class="mt-1">{{ s.request.note }}</div>
                  </div>

                  <!-- Bound AND scope of the stored scan, stated rather than silently
                       applied: which rows were read is as load-bearing as how many. -->
                  <p v-if="s.scan" class="mt-2 text-[11px] text-carbon-3">
                    Scanned <strong>{{ s.scan.rowsScanned }}</strong> of at most {{ s.scan.rowLimit }}
                    <span class="font-mono">{{ s.scan.source }}</span> rows from the last
                    {{ s.scan.windowDays }} days, where <span class="font-mono">{{ s.scan.filter }}</span>.
                    <span v-if="s.scan.capped" class="text-brand-hunger font-bold">
                      More rows exist beyond the cap — this is a prefix of the window, not all of it.
                    </span>
                  </p>

                  <!-- Zero rows scanned is at least three different facts, and they
                       demand different actions. The unfiltered counts are what tells
                       "nothing was written" apart from "rows exist, none matched". -->
                  <p
                    v-if="s.scan?.unfiltered"
                    class="mt-1 text-[11px] text-carbon-2"
                    :data-testid="`admin-diag-wire-unfiltered-${s.mode}-${s.id}`"
                  >
                    Same window before these filters:
                    <strong>{{ s.scan.unfiltered.rowsForProvider }}</strong> row(s) for this provider,
                    <strong>{{ s.scan.unfiltered.rowsForEnterprise }}</strong> of them on the probed
                    enterprise.
                    <span class="block text-carbon-3">{{ s.scan.unfiltered.note }}</span>
                  </p>

                  <!-- A two-step read (report envelope + one signed NDJSON file).
                       The bound is stated for the same reason the stored scan states
                       its row cap: a silent cap reads as "we looked at everything". -->
                  <p
                    v-if="s.fetchBound"
                    class="mt-2 text-[11px] text-carbon-2"
                    :data-testid="`admin-diag-wire-fetch-bound-${s.mode}-${s.id}`"
                  >
                    Read <strong>{{ s.fetchBound.linksRead }}</strong> of
                    <strong>{{ s.fetchBound.linksAvailable }}</strong> download link(s), and
                    <strong>{{ s.fetchBound.linesRead }}</strong> line(s) of that file (cap
                    {{ s.fetchBound.lineLimit }}).
                    <span v-if="s.fetchBound.linesCapped" class="text-brand-hunger font-bold">
                      The file held more lines than the cap — these records are a prefix of it.
                    </span>
                    <span v-if="s.fetchBound.linesUnparseable > 0">
                      {{ s.fetchBound.linesUnparseable }} line(s) were not JSON and were skipped.
                    </span>
                    <span class="block text-carbon-3">{{ s.fetchBound.note }}</span>
                  </p>

                  <!-- The stored mode reads PARSED payloads, so a stripping Zod object
                       hides anything nested inside it. Say so, or "no undeclared
                       fields here" reads as evidence of absence. -->
                  <p
                    v-if="s.unobservable?.paths.length"
                    class="mt-2 text-[11px] text-carbon-2"
                    :data-testid="`admin-diag-wire-unobservable-${s.mode}-${s.id}`"
                  >
                    <strong class="text-brand-hunger">Not observable in this mode:</strong>
                    <span class="font-mono">{{ s.unobservable.paths.join(', ') }}</span>
                    — {{ s.unobservable.note }}
                  </p>

                  <!-- data_refreshed_at: we parse it on both Enterprise reports
                       and have never read it. Rows after it are an incomplete tail. -->
                  <p v-if="s.freshness" class="mt-2 text-[11px] text-carbon-2">
                    <strong>data_refreshed_at:</strong>
                    <span class="font-mono">{{ s.freshness.dataRefreshedAt ?? 'absent' }}</span>
                    · window ends <span class="font-mono">{{ s.freshness.windowEndingAt }}</span>
                    <UiBadge
                      class="ml-1"
                      :kind="s.freshness.coversWindow === true ? 'rag-green' : s.freshness.coversWindow === false ? 'rag-amber' : 'neutral'"
                    >
                      {{ s.freshness.coversWindow === true ? 'covers the window' : s.freshness.coversWindow === false ? 'window not yet refreshed' : 'unknown' }}
                    </UiBadge>
                    <span class="block text-carbon-3">{{ s.freshness.note }}</span>
                  </p>

                  <p v-if="s.defaultedPaths?.length" class="mt-2 text-[11px] text-carbon-3">
                    {{ s.defaultedPaths.length }} observed path(s) are supplied by a Zod
                    <span class="font-mono">.default()</span>, so their presence here is 100% by
                    construction and is <strong>not</strong> evidence the provider sent them:
                    <span class="font-mono">{{ s.defaultedPaths.join(', ') }}</span>
                  </p>

                  <p v-if="s.drift?.status === 'no-data'" class="mt-2 text-[11px] text-carbon-2">
                    {{ s.drift.note }}
                  </p>

                  <div v-if="s.drift?.status === 'drift' || s.drift?.status === 'inconclusive'" class="mt-2 text-[11px] space-y-1">
                    <div v-if="s.drift.removed?.length">
                      <span class="font-bold text-brand-hunger">Declared but absent:</span>
                      <span class="font-mono">{{ s.drift.removed.join(', ') }}</span>
                    </div>
                    <div v-if="s.drift.presenceMoved?.length">
                      <span class="font-bold text-brand-hunger">Presence moved:</span>
                      <span
                        v-for="m in s.drift.presenceMoved"
                        :key="m.path"
                        class="font-mono mr-2"
                      >{{ m.path }} {{ Math.round(m.baselineRate * 100) }}% → {{ Math.round(m.liveRate * 100) }}% ({{ m.present }}/{{ m.total }})</span>
                    </div>
                    <div v-if="s.drift.typeChanged?.length">
                      <span class="font-bold text-brand-hunger">Unexpected types:</span>
                      <span
                        v-for="t in s.drift.typeChanged"
                        :key="t.path"
                        class="font-mono mr-2"
                      >{{ t.path }} +{{ t.unexpected.join('|') }}</span>
                    </div>
                    <div v-if="s.drift.notObserved?.length" class="text-carbon-3">
                      <span class="font-bold">Container never appeared, nothing concluded:</span>
                      <span class="font-mono">{{ s.drift.notObserved.join(', ') }}</span>
                    </div>
                  </div>

                  <!-- Absent AND optional. Reported, but not as drift: our schema
                       makes no presence claim for these, so calling their absence
                       a change would put a red badge on every run. -->
                  <p
                    v-if="s.drift?.absentOptional?.length"
                    class="mt-2 text-[11px] text-carbon-3"
                    :data-testid="`admin-diag-wire-absent-optional-${s.mode}-${s.id}`"
                  >
                    <span class="font-bold">Optional in our schema and absent here:</span>
                    <span class="font-mono">{{ s.drift.absentOptional.join(', ') }}</span>
                    — our schema declares these optional, so their absence is not drift and does not
                    change the badge above.
                  </p>

                  <UiButton
                    kind="secondary"
                    size="sm"
                    class="mt-2"
                    :data-testid="`admin-diag-wire-paths-toggle-${s.mode}-${s.id}`"
                    @click="toggleWireSurface(`${s.mode}-${s.id}`)"
                  >
                    {{ wireExpanded[`${s.mode}-${s.id}`] ? 'Hide' : 'Show' }} {{ s.summary?.paths.length }} key paths
                  </UiButton>

                  <div v-if="wireExpanded[`${s.mode}-${s.id}`]" class="mt-2 overflow-x-auto">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="bg-brand-vision-sheer/40 border-b border-calm-2">
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Key path</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Types</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Present</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Null</th>
                          <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-3 py-2">Distinct values</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-calm-2">
                        <tr v-for="p in s.summary?.paths" :key="p.path" class="hover:bg-brand-vision-sheer/30 align-top">
                          <td class="px-3 py-2 font-mono text-[11px] text-carbon break-all">{{ p.path }}</td>
                          <td class="px-3 py-2 font-mono text-[11px] text-carbon-2">{{ p.types.join('|') }}</td>
                          <td class="px-3 py-2 font-mono text-[11px] text-carbon">
                            {{ p.present }}/{{ p.total }} ({{ wirePct(p.present, p.total) }})
                          </td>
                          <td class="px-3 py-2 font-mono text-[11px]" :class="p.nulls > 0 ? 'text-brand-hunger' : 'text-carbon-3'">{{ p.nulls }}</td>
                          <td class="px-3 py-2 text-[11px] text-carbon-2 break-all">
                            <span v-if="p.distinctValues" class="font-mono">{{ p.distinctValues.join(', ') }}</span>
                            <span v-else-if="p.valuesWithheld" class="text-carbon-3 italic">{{ wireWithheldLabel(p.valuesWithheld) }}</span>
                            <span v-else class="text-carbon-3">—</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </div>
            </div>
          </template>
          <p v-else-if="wireRunning" class="text-sm text-carbon-3 italic">Running…</p>
          <p v-else class="text-sm text-carbon-3 italic">
            Not run yet — this card never probes on page load.
          </p>
        </template>
      </UiCard>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
