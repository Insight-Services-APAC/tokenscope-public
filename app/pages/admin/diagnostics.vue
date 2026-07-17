<script setup lang="ts">
/*
 * Admin → Diagnostics (Wave VI). Operational health snapshot.
 *
 * Read-only — no "restart worker", no "drain queue" buttons per scope.
 * The Refresh button re-fetches the endpoint, giving the operator a
 * quick "is it back yet" loop without a full page reload.
 *
 * Cards are individually defensive: a Postgres miss doesn't break the
 * Redis card (the endpoint already wraps each probe in try/catch).
 */

import { computed, ref } from 'vue'
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
  // mig 0045: rate-card vs Claude's own cost_usd over the last 7 days
  // (v_cost_drift). spansCompared=0 until post-0045 emission accrues.
  costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    worstSpan: {
      spanKey: string
      model: string
      rateCardCostUsd: string
      lawCostUsd: string
      driftUsd: string
    } | null
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
  }[]
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
  workspaceId: string
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
const driftBadge = computed(() => {
  const d = data.value?.costDrift
  if (!d || d.spansCompared === 0) return { kind: 'neutral' as const, label: 'no data' }
  const pct = d.meanAbsDriftPct ?? 0
  if (pct < 1) return { kind: 'rag-green' as const, label: 'in line' }
  if (pct < 5) return { kind: 'rag-amber' as const, label: 'drifting' }
  return { kind: 'rag-red' as const, label: 'stale rates' }
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
      sub="Health probes — read-only. No mutations from this page."
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
            class="flex items-center justify-between py-2"
            :data-testid="`admin-diag-worker-${w.worker}`"
          >
            <div class="flex items-center gap-3 min-w-0">
              <UiBadge :kind="workerChip(w.rag).kind">{{ workerChip(w.rag).label }}</UiBadge>
              <span class="font-mono text-sm text-carbon truncate">{{ w.worker }}</span>
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
          </li>
        </ul>
        <p v-else class="text-sm text-carbon-3 italic">
          No worker runs recorded yet. Runs appear once the scheduler dispatches a worker.
        </p>
      </UiCard>

      <!-- Cost drift (mig 0045): our rate-card cost vs Claude's own cost_usd
           per span, last 7 days. Creeping mean drift = stale rate card —
           caught here before reconciliation books the gap. -->
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
          <p v-if="data.costDrift.worstSpan" class="text-xs text-carbon-3 mt-2">
            Worst span: <span class="font-mono">{{ data.costDrift.worstSpan.model }}</span> —
            rate-card ${{ data.costDrift.worstSpan.rateCardCostUsd }} vs provider ${{ data.costDrift.worstSpan.lawCostUsd }}
            (Δ ${{ data.costDrift.worstSpan.driftUsd }}).
          </p>
        </template>
        <template v-else>
          <h2 class="text-lg font-bold text-carbon-2">No comparable spans yet</h2>
          <p class="text-xs text-carbon-3 mt-1">
            Provider cost capture starts with mig 0045 emission — spans appear here as
            new usage lands with <span class="font-mono">law_cost_usd</span>.
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

        <p v-if="netError" class="text-sm text-brand-hunger font-mono" data-testid="admin-diag-network-error">
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
            <div class="flex items-center justify-between gap-2">
              <dt class="text-carbon-2">Workspace</dt>
              <dd class="font-mono text-[11px] text-carbon break-all text-right">{{ otelData.workspaceId }}</dd>
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
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
