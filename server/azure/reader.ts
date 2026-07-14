/*
 * Telemetry reader — pulls a session's token usage from the telemetry
 * store and returns normalised UsageRecords for the read joiner.
 *
 * Claude Code emits token usage as OTel METRICS + LOG EVENTS (not spans);
 * the `api_request` event carries the four token counts + cost per API
 * call. Our injected OTEL_RESOURCE_ATTRIBUTES.tokenscope.instance_id rides
 * every record, so the join key is OURS (== instance_attestation.instance_id),
 * not Claude's internal session.id. See
 * docs/development/claude-code-telemetry-contract.md.
 *
 * Two implementations behind one interface:
 *   - LocalCollectorReader — local spike: queries the collector-fed
 *     telemetry store (tools/fake-azure-monitor), which has normalised
 *     Claude's OTLP into UsageRecords keyed on tokenscope.instance_id.
 *   - LogAnalyticsReader — sandbox (Path B): queries Log Analytics via
 *     @azure/monitor-query KQL. Implemented at the Epic-10 sandbox cut.
 * Selected by NUXT_TELEMETRY_READER (default 'local').
 */
import { z } from 'zod'
import { resilientFetch } from '../utils/resilient-fetch'

/*
 * KQL-injection guard (ING-10): instance ids are interpolated into KQL string
 * literals. Only DB-sourced UUIDs reach getSessionUsage today, but a future
 * caller passing user input would re-open the injection buildListSessionsKql
 * already needed a guard for. Charset-only check (hex + dashes) — quotes and
 * backslashes, the only KQL string-literal break-out chars, can never pass.
 */
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('getSessionUsage: session id must be a 36-char UUID-shaped string')
  }
}

const UsageRecordSchema = z.object({
  tokens: z.number().int().nonnegative(),
  // Normalised to rate_line.unit values: input | output | cache-read | cache-write.
  tokenType: z.string(),
  model: z.string(),
  tsEvent: z.string(),
  sourceRunId: z.string().optional(),
  // The Claude-stamped per-event organization.id — the joiner uses it to pick
  // the reconciliation lane via provider_org. Undefined for legacy/local data.
  organizationId: z.string().optional(),
  // The emitted per-event project.code_hash from the repo's committed
  // .tokenscope (ADR-0004 "B′": project is a per-record CLAIM, membership-gated
  // at join). Records under one DEVICE_SID may carry DIFFERENT hashes (one per
  // repo). Undefined when the repo emitted no .tokenscope → stays untagged.
  projectCodeHash: z.string().optional(),
  // Claude's own per-conversation session.id (Attributes['session.id']). Distinct
  // from our tokenscope.instance_id (the device). Subagents share their parent's
  // value, so grouping on this rolls subagent spend into the parent conversation.
  // Undefined for legacy/local data.
  claudeSessionId: z.string().optional(),
  // Provenance (ADR-0005 slice 3): set when the record was re-emitted by
  // /tokenscope:backfill (resource attr tokenscope.backfill=true). The joiner
  // marks the resulting attribution_record non-reconciled / advisory (tier-2,
  // telemetry-only, metadata.backfill) — dedup ≠ authenticity. Undefined = live.
  backfill: z.boolean().optional(),
  // GitHub AI credits (Copilot only). nano_aiu = credits × 1e9.
  // Used by the joiner for Copilot cost: cost_usd = nano_aiu × 1e-11.
  // Undefined for Claude records (those use token rate cards).
  nanoAiu: z.number().optional(),
  // Claude's per-event query_source attr (mig 0045): 'main' or an auxiliary
  // lane like 'generate_session_title'. Undefined for legacy/local data —
  // the joiner stores NULL, which consumers must treat as unknown.
  querySource: z.string().optional(),
  // Claude's own per-event cost_usd (informational, belt-and-braces). The KQL
  // mv-expand duplicates it onto every token-type row of the span; the joiner
  // carries it into metadata.law_cost_usd and v_cost_drift aggregates it MAX
  // per span against our SUMmed rate-card cost. Undefined for legacy data.
  lawCostUsd: z.number().optional(),
})
export type UsageRecord = z.infer<typeof UsageRecordSchema>

const SessionUsage = z.object({
  session_id: z.string(),
  usage: z.array(UsageRecordSchema),
})

/**
 * One behavioural usage-signal observation (the NON-billing lane). Flattened from
 * a usage_signal log record: one SignalRecord per (span, signal_name) so the
 * landing dedups on (instance, source span, signal_name). design:
 * docs/design/copilot-usage-signals.md
 */
export interface SignalRecord {
  signalName: string
  value: number
  tsEvent: string
  sourceRunId?: string
}

// The signal lane's WIRE contract: DB signal_name → the OTLP attribute the
// transcoder emits (otlp-logs.mjs::transcodeSignalSpans). The transcoder hardcodes
// the same `sig.*` strings across the .mjs/.ts boundary (no shared module possible);
// the copilot-transcoder contract test pins emit↔parse against THIS map so a rename
// on either side fails CI instead of silently emptying the lane. Adding a signal is
// one entry here + the transcoder emit + a detector — no migration.
export const SIGNAL_WIRE_COLUMNS = {
  tool_count: 'sig.tool_count',
  mcp_count: 'sig.mcp_count',
  ctx_pct: 'sig.ctx_pct',
  turn_count: 'sig.turn_count',
} as const

// Positional fallback for parseSignalRows when a result table carries no column
// descriptors — MUST match buildSignalUsageKql's project order (_ts, _req, signals).
const SIGNAL_KQL_PROJECTION = ['_ts', '_req', ...Object.keys(SIGNAL_WIRE_COLUMNS)] as const

const SessionSummaryListSchema = z.object({
  sessions: z.array(
    z.object({
      // Claude's per-conversation session.id (the conversation key — §13).
      sessionId: z.string(),
      // The tokenscope.instance_id (device/enrolment) the conversation ran on.
      // Optional: the local store may not carry it for legacy rows.
      instanceId: z.string().optional(),
      email: z.string(),
      firstEvent: z.string(),
      lastEvent: z.string(),
      tokens: z.number(),
      costUsd: z.number(),
      models: z.array(z.string()),
    }),
  ),
})

/**
 * One observed CONVERSATION, summarised from OTel — independent of attribution.
 * Powers the "untagged sessions" worklist (retroactive tagging). Keyed on
 * Claude's own per-conversation session.id (§13 — so sibling conversations on a
 * shared instance are listed separately), carrying the instance_id alongside so
 * the UI can show which device/enrolment the conversation ran on. The owner is
 * the per-event user.email Claude stamps; resolve it to a teammate via
 * teammate.email or teammate_identity_map.
 */
export interface SessionSummary {
  /** Claude's per-conversation session.id — the conversation key. */
  sessionId: string
  /** The tokenscope.instance_id (device/enrolment) the conversation ran on. */
  instanceId?: string
  email: string
  firstEvent: string
  lastEvent: string
  tokens: number
  costUsd: number
  models: string[]
}

/*
 * High-water-mark lookback (read-joiner scalability fix). When the joiner has a
 * per-instance watermark (MAX(attribution_record.ts_event) for already-attributed
 * rows), it asks the reader for only events strictly newer than
 * `watermark - WATERMARK_LOOKBACK_MS`. The small overlap re-reads near-boundary
 * events so a minor out-of-order ingestion can't be skipped; the joiner's
 * onConflictDoNothing dedup (the unique index) makes the re-read a harmless
 * idempotent no-op. Net: per-tick read is bounded by actual new emission, not
 * the instance's lifetime history.
 */
export const WATERMARK_LOOKBACK_MS = 5 * 60 * 1000 // 5 minutes

export interface ReaderHealth {
  ok: boolean
  kind: 'log-analytics' | 'local'
  latencyMs: number
  /** short error/status string when !ok — never a secret. */
  error?: string
}

export interface TelemetryReader {
  /**
   * Token usage for a session, keyed on the tokenscope.instance_id we minted at
   * attest. When `sinceTsEvent` is provided the reader returns ONLY records with
   * an event timestamp strictly newer than `sinceTsEvent - WATERMARK_LOOKBACK_MS`
   * (the high-water-mark incremental read); omit it for a full-window scan
   * (first-ever scan of an instance, no prior attribution).
   */
  getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]>
  /**
   * Behavioural usage signals for a session (the NON-billing lane — Copilot
   * tool/MCP/context/turn telemetry). Same high-water-mark semantics as
   * getSessionUsage. OPTIONAL: a reader/store that carries no signals simply omits
   * it (the worker guards with `typeof reader.getSignalUsage === 'function'`), so
   * the runtime guard is honest rather than laundering a missing required member.
   */
  getSignalUsage?(sessionId: string, sinceTsEvent?: Date): Promise<SignalRecord[]>
  /** Recent sessions emitted by any of `emails` (the user's Claude identities). */
  listSessions(emails: string[], opts?: { lookbackDays?: number; limit?: number }): Promise<SessionSummary[]>
  /**
   * Reachability probe of the telemetry READ path. For Log Analytics this runs a
   * trivial KQL (`print`) that touches no table — validating DNS → the
   * (AMPLS-private) query endpoint and that the MI token is accepted by the
   * workspace API. NOTE: `print` needs no table-read grant, so this does NOT
   * exercise the Log Analytics Reader role; it is a reachability probe, not an
   * RBAC check (a real read could still 403). Resolves (never throws).
   */
  healthCheck(): Promise<ReaderHealth>
}

export class LocalCollectorReader implements TelemetryReader {
  constructor(private readonly endpoint: string) {}

  async healthCheck(): Promise<ReaderHealth> {
    // Local collector (dev/test) — confirm the endpoint answers at all.
    const start = Date.now()
    try {
      const res = await resilientFetch(`${this.endpoint}/v1/health`)
      return { ok: res.ok, kind: 'local', latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, kind: 'local', latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    assertSafeSessionId(sessionId)
    const res = await resilientFetch(
      `${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/usage`,
    )
    if (!res.ok) {
      throw new Error(`telemetry store GET usage HTTP ${res.status}`)
    }
    const usage = SessionUsage.parse(await res.json()).usage
    // High-water-mark incremental read: the local store returns the full usage
    // set, so filter client-side to events strictly newer than the watermark
    // minus the lookback. Without a watermark this is the full set (unchanged).
    if (!sinceTsEvent) return usage
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return usage.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }

  async getSignalUsage(_sessionId: string, _sinceTsEvent?: Date): Promise<SignalRecord[]> {
    // The local collector store does not carry Copilot behavioural signals; the
    // signal lane is exercised only against Log Analytics (dev/sandbox). Returning
    // [] keeps the worker's per-instance signal read a harmless no-op locally.
    return []
  }

  async listSessions(
    emails: string[],
    opts: { lookbackDays?: number; limit?: number } = {},
  ): Promise<SessionSummary[]> {
    if (emails.length === 0) return []
    const params = new URLSearchParams()
    for (const e of emails) params.append('email', e)
    if (opts.lookbackDays) params.set('lookbackDays', String(opts.lookbackDays))
    if (opts.limit) params.set('limit', String(opts.limit))
    const res = await resilientFetch(`${this.endpoint}/v1/sessions?${params.toString()}`)
    if (!res.ok) throw new Error(`telemetry store GET sessions HTTP ${res.status}`)
    return SessionSummaryListSchema.parse(await res.json()).sessions
  }
}

/*
 * Sandbox (ADR-0003): Claude emits OTLP DIRECTLY to the Azure Monitor
 * OTLP-preview endpoint (DCE-fronted) — NO collector on the Claude path —
 * landing in Log Analytics; we query the workspace via @azure/monitor-query
 * KQL, authenticated by the container app's user-assigned MI (@azure/identity
 * DefaultAzureCredential). The SDK is dynamically imported so local dev /
 * tests never load the Azure SDK. (Only Copilot uses a tenant bridge;
 * collector-fronting is the ADR's documented fallback, not the Claude path.)
 *
 * The KQL below is VERIFIED against the live sandbox (2026-06-01; see the
 * "Verified OTLP → Azure Monitor ingestion recipe" in
 * docs/development/claude-code-telemetry-contract.md): Claude's OTLP
 * api_request log event lands in the OTelLogs table with our injected
 * resource attributes in the `ResourceAttributes` dynamic column and the
 * per-event token fields in the `Attributes` dynamic column. The stream
 * segment on the ingest URL is the service-managed `Microsoft-OTLP-Logs`.
 * The KQL projects a fixed column set (one row per token type), and
 * parseLogAnalyticsRows() maps that set to UsageRecords — that mapping is
 * pure + unit-tested independent of Azure.
 */
// SINGLE source of truth for the final `| project` columns: the KQL clause is
// GENERATED from this map (name → expression), and the key order doubles as
// the positional fallback when a result table carries no column descriptors.
// The two can no longer drift — the previous hand-mirrored list silently
// omitted ClaudeSessionId, misaligning Backfill/NanoAiu on the fallback path.
const KQL_PROJECTED_COLUMNS = {
  TokenscopeSessionId: '_sid',
  Model: '_model',
  TokenType: 'TokenType',
  Tokens: 'tolong(Tokens)',
  TsEvent: '_ts',
  SourceRunId: '_req',
  OrganizationId: '_org',
  ProjectCodeHash: '_proj',
  ClaudeSessionId: '_csid',
  Backfill: '_backfill',
  NanoAiu: '_nano_aiu',
  QuerySource: '_qsrc',
  LawCostUsd: '_law_cost',
} as const

const KQL_PROJECTION = Object.keys(KQL_PROJECTED_COLUMNS)

function kqlFinalProjectClause(): string {
  return Object.entries(KQL_PROJECTED_COLUMNS)
    .map(([name, expr]) => (name === expr ? name : `${name} = ${expr}`))
    .join(', ')
}

function buildSessionUsageKql(sessionId: string, sinceTsEvent?: Date): string {
  // VERIFIED landing shape (live sandbox, OTelLogs table):
  //   - our resource attrs (tokenscope.instance_id, project.code_hash, tool)
  //     → ResourceAttributes dynamic column
  //   - api_request event name → Attributes['event.name'] (Body also carries it)
  //   - the four token counts + model/request_id → Attributes
  // sessionId is our minted join key (== instance_attestation.instance_id).
  //
  // High-water-mark incremental read: when a watermark is supplied, bound on
  // TimeGenerated (the event timestamp we project as TsEvent) strictly newer
  // than watermark - WATERMARK_LOOKBACK_MS, so the per-tick scan is bounded by
  // new emission instead of the instance's lifetime history. The lookback +
  // the joiner's onConflictDoNothing dedup absorb minor out-of-order ingestion.
  // The cutoff is an ISO-8601 instant we control (not user input) — safe to
  // interpolate into datetime().
  const sinceClause = sinceTsEvent
    ? `| where TimeGenerated > datetime(${new Date(
        sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS,
      ).toISOString()})`
    : ''
  return `
    OTelLogs
    | where tostring(Attributes['event.name']) == 'api_request' or Body == 'api_request'
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${sessionId}'
    ${sinceClause}
    | extend _model = tostring(Attributes['model']),
             _req = tostring(Attributes['request_id']),
             _org = tostring(Attributes['organization.id']),
             _proj = tostring(ResourceAttributes['project.code_hash']),
             _csid = tostring(Attributes['session.id']),
             _backfill = tostring(ResourceAttributes['tokenscope.backfill']),
             _nano_aiu = todouble(Attributes['github.copilot.nano_aiu']),
             _qsrc = tostring(Attributes['query_source']),
             _law_cost = todouble(Attributes['cost_usd']),
             _ts = TimeGenerated
    | project _sid = tostring(ResourceAttributes['tokenscope.instance_id']), _model, _req, _org, _proj, _csid, _backfill, _ts, _nano_aiu, _qsrc, _law_cost,
              _input = tolong(Attributes['input_tokens']),
              _output = tolong(Attributes['output_tokens']),
              _cread = tolong(Attributes['cache_read_tokens']),
              _ccreate = tolong(Attributes['cache_creation_tokens'])
    | mv-expand TokenType = dynamic(['input','output','cache-read','cache-write']) to typeof(string),
                Tokens = pack_array(_input, _output, _cread, _ccreate) to typeof(long)
    | where Tokens > 0
    | project ${kqlFinalProjectClause()}
  `.trim()
}

/*
 * ── NATIVE GitHub Copilot OTel (GenAI semantic conventions) — read-side ──────
 *
 * GitHub shipped enterprise-managed OTLP export for Copilot Chat (VS Code) +
 * Copilot CLI (2026-07-08). It emits GenAI-semantic-convention telemetry
 * (gen_ai.usage.*, gen_ai.request.model) natively — no client forwarder,
 * transcoder, or bearer shim. The renewed design (docs/decisions/
 * 0009-...-addendum) is: native managed OTLP → Azure LAW ingestion DIRECTLY,
 * joined on OUR injected `tokenscope.instance_id` resource attribute (the SAME
 * key Claude uses), so one instance's Claude + Copilot usage unify through the
 * existing joiner + attribution_record — no new identity primitive.
 *
 * This is the READ-SIDE only, gated OFF by default (NUXT_COPILOT_NATIVE_OTEL).
 * It is DORMANT until the durable-auth + landing-shape spike (SPK-COPILOT-OTEL,
 * docs/build/copilot-native-otel-spike.md) confirms the two live-gated
 * assumptions marked SPIKE-CONFIRM below. Nothing here touches the live path.
 *
 * §A/§B: this is USAGE (§A) — tokens + model. Native GenAI carries NO AI
 * credits (nano_aiu) and no authoritative $, so cost stays §B (the pooled
 * bill). These rows carry tokens only; costing is deliberately unchanged.
 */

// The gen_ai.usage.* → rate_line unit mapping. SINGLE source of truth for both
// the KQL projection and the tests. `reasoning.output_tokens` is DELIBERATELY
// absent: per the GenAI convention it is a SUBSET of output_tokens (the
// "thinking" portion), so emitting it as a separate row would double-count.
// SPIKE-CONFIRM: whether cache_read is a subset of input_tokens (double-count
// risk) — modelled 1:1 here, mirroring Claude's proven 4-count api_request
// shape; confirm against live Copilot→LAW data before enabling.
export const GENAI_TOKEN_UNIT_MAP: ReadonlyArray<{ unit: string; attr: string }> = [
  { unit: 'input', attr: 'gen_ai.usage.input_tokens' },
  { unit: 'output', attr: 'gen_ai.usage.output_tokens' },
  { unit: 'cache-read', attr: 'gen_ai.usage.cache_read.input_tokens' },
  { unit: 'cache-write', attr: 'gen_ai.usage.cache_creation.input_tokens' },
]

// SPIKE-CONFIRM (SPK-COPILOT-OTEL): the LAW table native GenAI spans land in.
// Defaulted to OTelLogs (the verified Claude landing table) on the assumption
// Azure Monitor OTLP ingestion lands them there as log records; the live spike
// must confirm this vs a traces table. If it differs, ONLY this const + the
// attribute-column names change — the projected columns + parseLogAnalyticsRows
// + the whole downstream pipeline are unchanged.
const GENAI_LAW_TABLE = 'OTelLogs'
// SPIKE-CONFIRM: the operation carrying the authoritative token counts. We
// filter to the LLM `chat` call so agent/tool spans don't double-count the
// same turn's tokens (the guard the client transcoder needed for chat vs
// invoke_agent).
const GENAI_OPERATION = 'chat'

/** True when the native-Copilot GenAI read-side is enabled (default OFF). Read
 *  at call time so tests + a runtime flip don't need a restart. */
export function copilotNativeOtelEnabled(): boolean {
  return process.env.NUXT_COPILOT_NATIVE_OTEL === 'true'
}

/**
 * KQL for a session's native GenAI token usage, projected into the EXACT SAME
 * columns as buildSessionUsageKql so parseLogAnalyticsRows is reused unchanged.
 * Join key is our `tokenscope.instance_id` resource attribute (same as Claude).
 * GenAI-absent fields (org id, nano_aiu, cost, backfill, query_source) project
 * empty. sessionId is our minted join key; same charset guard + watermark.
 */
export function buildSessionUsageKqlGenAI(sessionId: string, sinceTsEvent?: Date): string {
  // Defense-in-depth (ING-10): self-guard the interpolated id even though the
  // sole caller pre-validates — this builder is exported, so a future direct
  // caller must not be able to reopen the KQL-injection hole.
  assertSafeSessionId(sessionId)
  const sinceClause = sinceTsEvent
    ? `| where TimeGenerated > datetime(${new Date(
        sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS,
      ).toISOString()})`
    : ''
  // Build the mv-expand token-type + value arrays FROM the single-source map,
  // so the mapping can't drift from the tests.
  const tokenTypes = GENAI_TOKEN_UNIT_MAP.map((m) => `'${m.unit}'`).join(',')
  const tokenExtracts = GENAI_TOKEN_UNIT_MAP.map((m, i) => `_t${i} = tolong(Attributes['${m.attr}'])`).join(',\n             ')
  const tokenArray = GENAI_TOKEN_UNIT_MAP.map((_, i) => `_t${i}`).join(', ')
  return `
    ${GENAI_LAW_TABLE}
    | where tostring(Attributes['gen_ai.operation.name']) == '${GENAI_OPERATION}'
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${sessionId}'
    ${sinceClause}
    | extend _model = coalesce(tostring(Attributes['gen_ai.response.model']), tostring(Attributes['gen_ai.request.model'])),
             _req = tostring(Attributes['gen_ai.response.id']),
             _org = '',
             _proj = tostring(ResourceAttributes['project.code_hash']),
             _csid = tostring(Attributes['gen_ai.conversation.id']),
             _backfill = '',
             _nano_aiu = todouble(''),
             _qsrc = '',
             _law_cost = todouble(''),
             _ts = TimeGenerated,
             ${tokenExtracts}
    | project _sid = tostring(ResourceAttributes['tokenscope.instance_id']), _model, _req, _org, _proj, _csid, _backfill, _ts, _nano_aiu, _qsrc, _law_cost, ${tokenArray}
    | mv-expand TokenType = dynamic([${tokenTypes}]) to typeof(string),
                Tokens = pack_array(${tokenArray}) to typeof(long)
    | where Tokens > 0
    | project ${kqlFinalProjectClause()}
  `.trim()
}

/**
 * Pure mapper: a Log Analytics result table (column names + rows) →
 * UsageRecords. Column-name keyed so projection order doesn't matter.
 * Skips rows missing a token type or with non-positive tokens.
 *
 * Rows with a missing/unparseable TsEvent are SKIPPED and counted into
 * `counters.skippedNoTimestamp` (ING-9). Fabricating `now()` here gave such a
 * row a DIFFERENT synthetic timestamp every tick, so the dedup index
 * (instance_id, claude_session_id, ts_event, token_type, model, source_run_id)
 * never matched and the same event was re-attributed every read.
 */
export function parseLogAnalyticsRows(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  counters?: { skippedNoTimestamp: number },
): UsageRecord[] {
  const idx = (name: string) => columnNames.indexOf(name)
  const iType = idx('TokenType')
  const iTokens = idx('Tokens')
  const iModel = idx('Model')
  const iTs = idx('TsEvent')
  const iRun = idx('SourceRunId')
  const iOrg = idx('OrganizationId')
  const iProj = idx('ProjectCodeHash')
  const iCsid = idx('ClaudeSessionId')
  const iBackfill = idx('Backfill')
  const iNanoAiu = idx('NanoAiu')
  const iQuerySource = idx('QuerySource')
  const iLawCost = idx('LawCostUsd')
  const out: UsageRecord[] = []
  for (const row of rows) {
    const tokenType = iType >= 0 ? String(row[iType] ?? '') : ''
    const tokens = iTokens >= 0 ? Number(row[iTokens] ?? 0) : 0
    if (!tokenType || !Number.isFinite(tokens) || tokens <= 0) continue
    const tsRaw = iTs >= 0 ? row[iTs] : null
    let tsEvent: string
    if (tsRaw instanceof Date && Number.isFinite(tsRaw.getTime())) {
      tsEvent = tsRaw.toISOString()
    } else if (tsRaw != null && String(tsRaw) && Number.isFinite(new Date(String(tsRaw)).getTime())) {
      tsEvent = String(tsRaw)
    } else {
      // No parseable event timestamp → skip + count, never fabricate one (ING-9).
      if (counters) counters.skippedNoTimestamp += 1
      continue
    }
    const rec: UsageRecord = {
      tokens: Math.trunc(tokens),
      tokenType,
      model: iModel >= 0 ? String(row[iModel] ?? 'unknown') : 'unknown',
      tsEvent,
    }
    const run = iRun >= 0 ? row[iRun] : null
    if (run != null && String(run)) rec.sourceRunId = String(run)
    const org = iOrg >= 0 ? row[iOrg] : null
    if (org != null && String(org)) rec.organizationId = String(org)
    const proj = iProj >= 0 ? row[iProj] : null
    if (proj != null && String(proj)) rec.projectCodeHash = String(proj)
    const csid = iCsid >= 0 ? row[iCsid] : null
    if (csid != null && String(csid)) rec.claudeSessionId = String(csid)
    const backfill = iBackfill >= 0 ? row[iBackfill] : null
    if (backfill != null && String(backfill).toLowerCase() === 'true') rec.backfill = true
    const nanoAiu = iNanoAiu >= 0 ? row[iNanoAiu] : null
    if (nanoAiu != null && nanoAiu !== '' && Number.isFinite(Number(nanoAiu))) {
      rec.nanoAiu = Number(nanoAiu)
    }
    const qsrc = iQuerySource >= 0 ? row[iQuerySource] : null
    if (qsrc != null && String(qsrc)) rec.querySource = String(qsrc)
    const lawCost = iLawCost >= 0 ? row[iLawCost] : null
    if (lawCost != null && lawCost !== '' && Number.isFinite(Number(lawCost))) {
      rec.lawCostUsd = Number(lawCost)
    }
    out.push(rec)
  }
  return out
}

/**
 * KQL: a session's behavioural usage-signal records (event.name='usage_signal').
 * DISJOINT from the token query (which filters api_request + Tokens>0) — a signal
 * record carries NO token attrs, so the two streams never overlap. Projects one
 * row per usage_signal span with the sig.* columns; parseSignalRows flattens each
 * to one SignalRecord per present signal. sessionId == tokenscope.instance_id;
 * same charset guard + watermark-lookback as buildSessionUsageKql.
 */
function buildSignalUsageKql(sessionId: string, sinceTsEvent?: Date): string {
  const sinceClause = sinceTsEvent
    ? `| where TimeGenerated > datetime(${new Date(
        sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS,
      ).toISOString()})`
    : ''
  const sigProject = Object.entries(SIGNAL_WIRE_COLUMNS)
    .map(([name, wire]) => `${name} = todouble(Attributes['${wire}'])`)
    .join(',\n             ')
  return `
    OTelLogs
    | where tostring(Attributes['event.name']) == 'usage_signal' or Body == 'usage_signal'
    | where tostring(ResourceAttributes['tokenscope.instance_id']) == '${sessionId}'
    ${sinceClause}
    | project _ts = TimeGenerated,
             _req = tostring(Attributes['request_id']),
             ${sigProject}
  `.trim()
}

/**
 * Pure mapper: a Log Analytics usage_signal table → SignalRecord[]. Column-keyed,
 * so projection order doesn't matter. Each row (one span) yields one SignalRecord
 * per PRESENT signal — a null/NaN/absent sig column is simply skipped (a chat span
 * has no mcp_count, an invoke_agent span no ctx_pct). Rows with no parseable
 * timestamp are skipped + counted (ING-9 parity with parseLogAnalyticsRows).
 */
export function parseSignalRows(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  counters?: { skippedNoTimestamp: number },
): SignalRecord[] {
  const idx = (n: string) => columnNames.indexOf(n)
  const iTs = idx('_ts')
  const iReq = idx('_req')
  const signalIdx = Object.keys(SIGNAL_WIRE_COLUMNS).map((name) => [name, idx(name)] as const)
  const out: SignalRecord[] = []
  for (const row of rows) {
    const tsRaw = iTs >= 0 ? row[iTs] : null
    let tsEvent: string
    if (tsRaw instanceof Date && Number.isFinite(tsRaw.getTime())) {
      tsEvent = tsRaw.toISOString()
    } else if (tsRaw != null && String(tsRaw) && Number.isFinite(new Date(String(tsRaw)).getTime())) {
      tsEvent = String(tsRaw)
    } else {
      if (counters) counters.skippedNoTimestamp += 1
      continue
    }
    const runRaw = iReq >= 0 ? row[iReq] : null
    const sourceRunId = runRaw != null && String(runRaw) ? String(runRaw) : undefined
    for (const [name, ci] of signalIdx) {
      if (ci < 0) continue
      const raw = row[ci]
      if (raw == null || raw === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) continue
      out.push({ signalName: name, value, tsEvent, ...(sourceRunId ? { sourceRunId } : {}) })
    }
  }
  return out
}

/** KQL: summarise OTel sessions emitted by any of `emails` (per-event user.email). */
function buildListSessionsKql(emails: string[], lookbackDays: number, limit: number): string {
  // R3 (defense-in-depth): drop any email carrying a quote or backslash — those
  // can't be a valid email and are the only KQL string-literal break-out chars.
  // Identities are charset-constrained at write time; this guards the remaining
  // teammate.email (Entra-asserted) path too.
  const inList = emails
    .filter((e) => !/['\\]/.test(e))
    .map((e) => `'${e}'`)
    .join(', ')
  // §13: group by Claude's own per-conversation session.id (Attributes), NOT the
  // tokenscope.instance_id (ResourceAttributes), so sibling conversations on one
  // shared instance are summarised SEPARATELY. The instance id is carried
  // alongside (take_any — a conversation belongs to one instance) so the worklist
  // can show which device the conversation ran on. Fall back to the instance id
  // when the conversation id is absent (legacy emissions pre-claude_session_id).
  return `
    OTelLogs
    | where TimeGenerated > ago(${lookbackDays}d)
    | where tostring(Attributes['event.name']) == 'api_request'
    | where tostring(Attributes['user.email']) in~ (${inList})
    | extend _inst = tostring(ResourceAttributes['tokenscope.instance_id']),
             _csid = tostring(Attributes['session.id']),
             _email = tostring(Attributes['user.email'])
    | where isnotempty(_inst)
    | extend _conv = iff(isnotempty(_csid), _csid, _inst)
    | summarize FirstEvent = min(TimeGenerated), LastEvent = max(TimeGenerated),
                Tokens = sum(tolong(Attributes['input_tokens']) + tolong(Attributes['output_tokens'])
                           + tolong(Attributes['cache_read_tokens']) + tolong(Attributes['cache_creation_tokens'])),
                CostUsd = sum(todouble(Attributes['cost_usd'])),
                Models = make_set(tostring(Attributes['model'])),
                InstanceId = take_any(_inst)
      by SessionId = _conv, Email = _email
    | top ${limit} by LastEvent desc
  `.trim()
}

/** Pure mapper: a Log Analytics session-summary table → SessionSummary[]. Column-keyed. */
export function parseSessionSummaryRows(
  columnNames: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): SessionSummary[] {
  const idx = (n: string) => columnNames.indexOf(n)
  const iSid = idx('SessionId'), iEmail = idx('Email'), iFirst = idx('FirstEvent')
  const iLast = idx('LastEvent'), iTok = idx('Tokens'), iCost = idx('CostUsd'), iModels = idx('Models')
  const iInst = idx('InstanceId')
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''))
  const out: SessionSummary[] = []
  for (const row of rows) {
    const sessionId = iSid >= 0 ? String(row[iSid] ?? '') : ''
    if (!sessionId) continue
    let models: string[] = []
    const raw = iModels >= 0 ? row[iModels] : null
    if (Array.isArray(raw)) models = raw.map(String)
    else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) models = p.map(String) } catch { /* ignore */ } }
    const instRaw = iInst >= 0 ? row[iInst] : null
    out.push({
      sessionId,
      ...(instRaw != null && String(instRaw) ? { instanceId: String(instRaw) } : {}),
      email: iEmail >= 0 ? String(row[iEmail] ?? '') : '',
      firstEvent: iso(iFirst >= 0 ? row[iFirst] : null),
      lastEvent: iso(iLast >= 0 ? row[iLast] : null),
      tokens: iTok >= 0 ? Math.trunc(Number(row[iTok] ?? 0)) : 0,
      costUsd: iCost >= 0 ? Number(row[iCost] ?? 0) : 0,
      models,
    })
  }
  return out
}

export class LogAnalyticsReader implements TelemetryReader {
  // Memoized SDK handle (ING-11): `new DefaultAzureCredential()` per call threw
  // away the SDK token cache, re-running the managed-identity chain for up to
  // ~500 instance reads per tick. Built once per reader instance instead.
  private clientPromise: Promise<{
    client: import('@azure/monitor-query').LogsQueryClient
    LogsQueryResultStatus: typeof import('@azure/monitor-query').LogsQueryResultStatus
    Durations: typeof import('@azure/monitor-query').Durations
  }> | null = null

  constructor(
    private readonly workspaceId: string,
    private readonly opts: { miClientId?: string; lookbackDays?: number; queryEndpoint?: string } = {},
  ) {}

  private getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // Dynamic import keeps the Azure SDK out of local dev / the test bundle.
        const { LogsQueryClient, LogsQueryResultStatus, Durations } = await import('@azure/monitor-query')
        const { DefaultAzureCredential } = await import('@azure/identity')
        const credential = new DefaultAzureCredential(
          this.opts.miClientId ? { managedIdentityClientId: this.opts.miClientId } : {},
        )
        // Log Analytics QUERY endpoint. The SDK default is `api.loganalytics.io`.
        // VERIFIED on dev (2026-07-01): on the AMPLS/private-query workspace that
        // hostname resolves to the SAME private-endpoint IP as api.monitor.azure.com
        // (10.0.0.55), so the SDK DEFAULT already reaches the private query path
        // (all Diagnostics probes green). Do NOT override to
        // `https://api.monitor.azure.com`: that host does NOT serve the LA query API
        // path and returns 404 PathNotFoundError (even for `print`). queryEndpoint
        // stays an escape hatch but MUST be left empty on dev/sandbox — the earlier
        // "use api.monitor.azure.com" guidance was wrong (it 404s). See
        // docs/design/telemetry-query-network-posture.md.
        const client = this.opts.queryEndpoint
          ? new LogsQueryClient(credential, { endpoint: this.opts.queryEndpoint })
          : new LogsQueryClient(credential)
        return { client, LogsQueryResultStatus, Durations }
      })()
      // A failed build must not be cached forever (a transient MI hiccup would
      // otherwise poison every subsequent read on this instance).
      this.clientPromise.catch(() => {
        this.clientPromise = null
      })
    }
    return this.clientPromise
  }

  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    assertSafeSessionId(sessionId)
    const { client, LogsQueryResultStatus, Durations } = await this.getClient()
    const lookbackDays = this.opts.lookbackDays === 1 ? 1 : 7
    if (!sinceTsEvent) {
      // ING-12: a first-ever scan (no watermark) is silently capped by the outer
      // query duration — events older than the cap are never read. Surface it.
      console.warn(
        `[log-analytics-reader] no-watermark scan for ${sessionId} capped at ${lookbackDays}d — older events are not read`,
      )
    }
    const result = await client.queryWorkspace(
      this.workspaceId,
      buildSessionUsageKql(sessionId, sinceTsEvent),
      {
        // The query-level duration is the OUTER bound (caps the scan range).
        // The KQL TimeGenerated filter (from the watermark) narrows WITHIN it.
        duration: lookbackDays === 1 ? Durations.oneDay : Durations.sevenDays,
      },
    )
    if (result.status !== LogsQueryResultStatus.Success) {
      throw new Error(`Log Analytics query did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    if (!table) return []
    const names = table.columnDescriptors.map((c) => c.name ?? '')
    const counters = { skippedNoTimestamp: 0 }
    const records = parseLogAnalyticsRows(
      names.length ? names : [...KQL_PROJECTION],
      table.rows as ReadonlyArray<ReadonlyArray<unknown>>,
      counters,
    )
    if (counters.skippedNoTimestamp > 0) {
      console.warn(
        `[log-analytics-reader] ${counters.skippedNoTimestamp} row(s) with no parseable TsEvent skipped for ${sessionId} (ING-9)`,
      )
    }
    // Native Copilot GenAI usage (default OFF; DORMANT until SPK-COPILOT-OTEL).
    // A second query on the SAME instance_id unions native-Copilot token rows
    // into this instance's usage — one device's Claude + Copilot usage converge
    // through the existing joiner. Projected columns are identical, so
    // parseLogAnalyticsRows is reused. Isolated try/catch: a GenAI-shape query
    // failure (e.g. the table doesn't exist pre-spike) must NEVER break the
    // proven Claude read.
    if (copilotNativeOtelEnabled()) {
      try {
        const genai = await client.queryWorkspace(this.workspaceId, buildSessionUsageKqlGenAI(sessionId, sinceTsEvent), {
          duration: lookbackDays === 1 ? Durations.oneDay : Durations.sevenDays,
        })
        if (genai.status !== LogsQueryResultStatus.Success) {
          // Fail-open (isolation) but NOT silent — a partial/failed GenAI query
          // must surface, or a persistent native-side outage looks like "no
          // Copilot usage" indistinguishably from a genuine zero.
          console.warn(`[log-analytics-reader] native-GenAI query non-success (status=${genai.status}) for ${sessionId}; Claude read unaffected`)
        } else if (genai.tables[0]) {
          const gnames = genai.tables[0].columnDescriptors.map((c) => c.name ?? '')
          // Own counters — sharing the Claude counter would let GenAI ING-9
          // skips increment a total that was ALREADY logged above, silently
          // defeating the skip diagnostic for the new path.
          const gCounters = { skippedNoTimestamp: 0 }
          records.push(
            ...parseLogAnalyticsRows(
              gnames.length ? gnames : [...KQL_PROJECTION],
              genai.tables[0].rows as ReadonlyArray<ReadonlyArray<unknown>>,
              gCounters,
            ),
          )
          if (gCounters.skippedNoTimestamp > 0) {
            console.warn(`[log-analytics-reader] ${gCounters.skippedNoTimestamp} native-GenAI row(s) with no parseable TsEvent skipped for ${sessionId} (ING-9)`)
          }
        }
      } catch (err) {
        console.warn(
          `[log-analytics-reader] native-GenAI query failed for ${sessionId}; Claude read unaffected: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return records
  }

  async getSignalUsage(sessionId: string, sinceTsEvent?: Date): Promise<SignalRecord[]> {
    assertSafeSessionId(sessionId)
    const { client, LogsQueryResultStatus, Durations } = await this.getClient()
    const lookbackDays = this.opts.lookbackDays === 1 ? 1 : 7
    const result = await client.queryWorkspace(
      this.workspaceId,
      buildSignalUsageKql(sessionId, sinceTsEvent),
      { duration: lookbackDays === 1 ? Durations.oneDay : Durations.sevenDays },
    )
    if (result.status !== LogsQueryResultStatus.Success) {
      throw new Error(`Log Analytics signal query did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    if (!table) return []
    const names = table.columnDescriptors.map((c) => c.name ?? '')
    const counters = { skippedNoTimestamp: 0 }
    const records = parseSignalRows(
      names.length ? names : [...SIGNAL_KQL_PROJECTION],
      table.rows as ReadonlyArray<ReadonlyArray<unknown>>,
      counters,
    )
    if (counters.skippedNoTimestamp > 0) {
      console.warn(
        `[log-analytics-reader] ${counters.skippedNoTimestamp} signal row(s) with no parseable TsEvent skipped for ${sessionId} (ING-9)`,
      )
    }
    return records
  }

  async listSessions(
    emails: string[],
    opts: { lookbackDays?: number; limit?: number } = {},
  ): Promise<SessionSummary[]> {
    if (emails.length === 0) return []
    const { client, LogsQueryResultStatus } = await this.getClient()
    const lookback = opts.lookbackDays ?? 30
    const kql = buildListSessionsKql(emails, lookback, opts.limit ?? 100)
    const result = await client.queryWorkspace(this.workspaceId, kql, { duration: `P${lookback}D` })
    if (result.status !== LogsQueryResultStatus.Success) {
      throw new Error(`Log Analytics listSessions did not succeed (status=${result.status})`)
    }
    const table = result.tables[0]
    if (!table) return []
    const names = table.columnDescriptors.map((c) => c.name ?? '')
    return parseSessionSummaryRows(names, table.rows as ReadonlyArray<ReadonlyArray<unknown>>)
  }

  async healthCheck(): Promise<ReaderHealth> {
    const start = Date.now()
    try {
      const { client, LogsQueryResultStatus } = await this.getClient()
      // `print` touches no table — exercises DNS → the (AMPLS-private) query
      // endpoint and workspace-API token acceptance. It does NOT exercise
      // table-read RBAC (a real read could still 403); reachability only.
      const result = await client.queryWorkspace(this.workspaceId, 'print probe=1', { duration: 'PT5M' })
      const ok = result.status === LogsQueryResultStatus.Success
      return {
        ok,
        kind: 'log-analytics',
        latencyMs: Date.now() - start,
        error: ok ? undefined : `query status=${result.status}`,
      }
    } catch (err) {
      return {
        ok: false,
        kind: 'log-analytics',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Admin diagnostic — runs a fixed battery of read-only OTelLogs queries and
   * returns the RAW result/error packets per query. The dev workspace is
   * NSP-locked (in-VNet only), so the app MI is the ONLY identity that can query
   * it; laptops, Cloud Shell, and CI runners all hit the NSP deny. This surfaces
   * "is telemetry actually landing?" — and, crucially, the EXACT failure (Azure
   * error code, the inner NspValidationFailedError, partial errors, status) —
   * to a platform-admin without opening the perimeter.
   *
   * FIXED queries parameterised ONLY by clamped integers (no caller-supplied KQL
   * → no injection surface). Never throws: each query is captured independently
   * so one failure still returns the others' raw packets.
   */
  async diagnosticOtelLogs(opts: { hours?: number; limit?: number } = {}): Promise<DiagnosticOtelLogs> {
    const hours = Math.min(Math.max(Math.floor(opts.hours ?? 24), 1), 168)
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 100)
    const duration = `PT${hours}H`
    const queries: Array<{ label: string; kql: string }> = [
      { label: 'reachability', kql: 'print probe=1' },
      { label: 'all-tables', kql: `union withsource=T * | where TimeGenerated > ago(${hours}h) | summarize n=count() by T | order by n desc` },
      {
        label: 'by-instance',
        // `last` is a KQL reserved word — using it as a bare summarize alias is a
        // SYN0002 parse error (400 BadArgumentError), so this probe failed on
        // syntax regardless of whether data was present. Use `lastSeen`.
        kql:
          `OTelLogs | where TimeGenerated > ago(${hours}h) ` +
          `| summarize records=count(), lastSeen=max(TimeGenerated) ` +
          `by instance=tostring(ResourceAttributes['tokenscope.instance_id']), tool=tostring(ResourceAttributes['tool']) ` +
          `| order by records desc`,
      },
      {
        label: 'recent-rows',
        kql:
          `OTelLogs | where TimeGenerated > ago(${hours}h) ` +
          `| project TimeGenerated, instance=tostring(ResourceAttributes['tokenscope.instance_id']), ` +
          `body=substring(tostring(Body), 0, 200) ` +
          `| order by TimeGenerated desc | take ${limit}`,
      },
    ]

    // DNS PROOF — resolve the query endpoints FROM INSIDE the app. The SDK's
    // LogsQueryClient default endpoint is https://api.loganalytics.io. If that
    // resolves to a PUBLIC ip while the AMPLS-covered hosts (api.monitor.azure.com,
    // <wsid>.oms.opinsights.azure.com) resolve PRIVATE (10.x), the query egresses
    // public and the workspace denies it — the gap is the endpoint we query, not
    // the private DNS. This is evidence, not an assertion.
    const dnsPromises = (await import('node:dns')).promises
    const isPrivateIp = (ip: string) =>
      /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    // Every FQDN from the AMPLS DNS request, so we can see per-record which
    // privatelink zone is actually linked (resolves to a 10.0.0.x PE ip) vs
    // missing (resolves public). api.loganalytics.io is the SDK default and has
    // NO private-link path — expected public.
    const dnsTargets = [
      'api.loganalytics.io',
      `${this.workspaceId}.oms.opinsights.azure.com`,
      `${this.workspaceId}.ods.opinsights.azure.com`,
      `${this.workspaceId}.agentsvc.azure-automation.net`,
      'api.monitor.azure.com',
      'global.in.ai.monitor.azure.com',
      'profiler.monitor.azure.com',
      'live.monitor.azure.com',
      'diagservices-query.monitor.azure.com',
      'snapshot.monitor.azure.com',
      'scadvisorcontentpl.blob.core.windows.net',
      'global.handler.control.monitor.azure.com',
    ]
    const dns: Array<{ host: string; addresses?: string[]; resolvesPrivate?: boolean; error?: string }> = []
    for (const host of dnsTargets) {
      try {
        const addrs = await dnsPromises.lookup(host, { all: true })
        const ips = addrs.map((a) => a.address)
        dns.push({ host, addresses: ips, resolvesPrivate: ips.some(isPrivateIp) })
      } catch (err) {
        dns.push({ host, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const base = {
      hours,
      limit,
      workspaceId: this.workspaceId,
      duration,
      queryEndpointNote: this.opts.queryEndpoint
        ? `LogsQueryClient endpoint override = ${this.opts.queryEndpoint}`
        : 'LogsQueryClient uses its default endpoint https://api.loganalytics.io (no override configured)',
      dns,
    }
    let handle: Awaited<ReturnType<LogAnalyticsReader['getClient']>>
    try {
      handle = await this.getClient()
    } catch (err) {
      // Couldn't even build the credential/client — return that raw.
      return { ...base, clientError: serializeQueryError(err), queries: [] }
    }
    const { client, LogsQueryResultStatus } = handle

    const results: DiagnosticQueryResult[] = []
    for (const q of queries) {
      const started = Date.now()
      try {
        const res = await client.queryWorkspace(this.workspaceId, q.kql, { duration })
        // `LogsQueryResult` is a union — `.tables` exists only on the Success
        // variant; PartialFailure carries `partialTables` + `partialError`.
        let columns: string[] = []
        let rows: Array<Record<string, unknown>> = []
        if (res.status === LogsQueryResultStatus.Success) {
          const table = res.tables[0]
          if (table) {
            columns = table.columnDescriptors.map((c) => c.name ?? '')
            const tableRows = table.rows as ReadonlyArray<ReadonlyArray<unknown>>
            rows = tableRows.map((row) => {
              const obj: Record<string, unknown> = {}
              columns.forEach((n, i) => {
                obj[n] = row[i]
              })
              return obj
            })
          }
        }
        const partialError = (res as { partialError?: unknown }).partialError
        results.push({
          label: q.label,
          kql: q.kql,
          ok: res.status === LogsQueryResultStatus.Success,
          status: String(res.status),
          latencyMs: Date.now() - started,
          partialError: partialError ? serializeQueryError(partialError) : undefined,
          columns,
          rows,
        })
      } catch (err) {
        results.push({
          label: q.label,
          kql: q.kql,
          ok: false,
          latencyMs: Date.now() - started,
          error: serializeQueryError(err),
        })
      }
    }
    return { ...base, queries: results }
  }
}

export interface DiagnosticQueryResult {
  label: string
  kql: string
  ok: boolean
  status?: string
  latencyMs: number
  partialError?: Record<string, unknown>
  error?: Record<string, unknown>
  columns?: string[]
  rows?: Array<Record<string, unknown>>
}

export interface DiagnosticOtelLogs {
  hours: number
  limit: number
  workspaceId: string
  duration: string
  queryEndpointNote: string
  dns: Array<{ host: string; addresses?: string[]; resolvesPrivate?: boolean; error?: string }>
  clientError?: Record<string, unknown>
  queries: DiagnosticQueryResult[]
}

/**
 * Serialize an Azure SDK / generic error into a RAW but SAFE shape for the
 * platform-admin diagnostic. Includes the Azure error code/status + the inner
 * structured error (e.g. NspValidationFailedError) so the operator sees the
 * exact failure — but deliberately EXCLUDES `request`/`response` objects, which
 * carry the `Authorization: Bearer …` header. Stack is capped to a few frames.
 */
export function serializeQueryError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) }
  const e = err as Error & {
    code?: unknown
    statusCode?: unknown
    details?: unknown
    innererror?: unknown
  }
  const out: Record<string, unknown> = { name: e.name, message: e.message }
  if (e.code !== undefined) out.code = e.code
  if (e.statusCode !== undefined) out.statusCode = e.statusCode
  for (const k of ['details', 'innererror'] as const) {
    if (e[k] !== undefined) {
      try {
        out[k] = JSON.parse(JSON.stringify(e[k]))
      } catch {
        out[k] = String(e[k])
      }
    }
  }
  if (e.stack) out.stack = e.stack.split('\n').slice(0, 6).join('\n')
  return out
}

export function getTelemetryReader(): TelemetryReader {
  if (process.env.NUXT_TELEMETRY_READER === 'log-analytics') {
    const workspaceId = process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID
    if (!workspaceId) {
      throw new Error('NUXT_LOG_ANALYTICS_WORKSPACE_ID not set — LogAnalyticsReader has no workspace')
    }
    return new LogAnalyticsReader(workspaceId, {
      miClientId: process.env.NUXT_AZURE_MI_CLIENT_ID,
      // Private-link envs set this to https://api.monitor.azure.com (the LA query
      // endpoint over AMPLS). Empty = SDK default api.loganalytics.io.
      queryEndpoint: process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT,
    })
  }
  const endpoint = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!endpoint) {
    throw new Error('NUXT_AZURE_MONITOR_ENDPOINT not set — local telemetry reader has no source')
  }
  return new LocalCollectorReader(endpoint)
}
