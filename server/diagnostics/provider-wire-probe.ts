/*
 * Provider wire shape — the probe engine behind
 * POST /api/v1/admin/diagnostics/provider-wire-shape.
 *
 * THE PROBLEM. We ask both providers to break usage down BY MODEL and then drop
 * the model at ingest, so that spend renders under a label the codebase defines
 * as naming a collection failure. Every claim we had about what the providers
 * send came from our own Zod schemas, which are assumptions. Two of the three
 * schemas are permissive enough to parse identically whether the field arrives,
 * arrives null, or never arrives at all — so they are not evidence of anything.
 * This engine collects the evidence.
 *
 * TWO MODES, ONE SUMMARISER (server/diagnostics/wire-shape.ts):
 *   - LIVE: issue one page of a real provider call and summarise the UNPARSED
 *     body. Answers "what does the provider send today". Costs a provider call.
 *   - STORED: summarise `actual_spend.raw_payload` / `reconciliation_record.raw`.
 *     Answers "what have we been receiving and silently dropping". Costs nothing,
 *     touches no credential, and is safe on any environment. The delta between the
 *     two is itself a signal.
 *
 * WHAT "STORED" IS AND IS NOT. The pollers store the PARSED object, not the wire
 * bytes (analytics-poller.ts:527 stores the Zod output rows). That is faithful
 * where the schema is `.passthrough()` — every Enterprise ROW schema and the
 * Admin `UsageRecord`/`Actor` are, so top-level row fields, `model` among them,
 * genuinely survive and an undeclared one genuinely shows up. It is NOT faithful
 * inside a STRIPPING object: `ModelBreakdown`, its `tokens` and its
 * `estimated_cost` (client.ts:51-67) and the Enterprise `cache_creation`
 * (enterprise-client.ts:51-57) are plain `z.object(...)`, so any unknown field
 * nested in those subtrees is discarded BEFORE storage. The stored scan is
 * structurally blind there, and "no unknown fields under model_breakdown[]" is
 * evidence of the parser, not of the provider. Each surface therefore declares
 * its stripping subtrees (SurfaceMeta.strippingSubtrees) and the stored report
 * carries them as `unobservable` so the gap is stated, not inferred. Only the
 * LIVE mode can see into them. (Making persistence verbatim is separate tracked
 * work; this module states the limit rather than papering over it.)
 *
 * WHICH SURFACES ARE PROBED IS DRIVEN BY CONFIGURATION, never assumed.
 * provider_org.api_kind (mig 0063) selects which Anthropic client a given org
 * reconciles through — 'enterprise-analytics' or 'claude-code-admin' — exactly as
 * server/workers/analytics-poller.ts:710 branches on it. A surface with no
 * matching provider_org is reported 'not-configured', which is a NEUTRAL
 * expected state: an environment wired only to Enterprise Analytics is not
 * unhealthy for having no Admin org, and showing it as an error would be a false
 * alarm about a variant the operator deliberately does not use.
 *
 * GITHUB HAS THE SAME TWO-VARIANT SHAPE, driven by the CREDENTIAL KIND rather
 * than by api_kind. github.ts:305-308 splits the Copilot read surface in two and
 * the adapter branches on `scope.credential.kind === 'github-app'`:
 *   - PAT mode reads per-user ai_credit/usage  -> 'github-ai-credit-usage'
 *   - App mode reads the users-1-day metrics report -> 'github-user-daily-credits'
 * Both are legitimate deployments, so both surfaces exist and the one the
 * enterprise does not use reports 'not-configured' — the SAME neutral state the
 * unused Anthropic variant reports, for the same reason. Neither is an error and
 * neither earns a red badge.
 *
 * THE STORED SCAN DETECTS THE SHAPE, IT DOES NOT INFER IT FROM THE CREDENTIAL.
 * The two modes write different `reconciliation_record.raw` payloads (an
 * `items` array vs a single `record` object), and an estate that migrated
 * PAT -> App has BOTH in its history — a 30-day window can straddle the switch.
 * Each stored reader therefore selects on the PAYLOAD, so today's credential kind
 * cannot hide yesterday's rows.
 *
 * SAFETY:
 *   - Never returns a response body. Only shapes (see wire-shape.ts's privacy
 *     contract), plus a provider's own ERROR text, which is returned raw and
 *     credential-scrubbed because a classified reason hides the cause.
 *   - `download_links` on the GitHub metrics report are SIGNED URLS — holding one
 *     IS access to the per-user data. The client accessor never returns them, and
 *     wire-shape.ts's key denylist (CAPABILITY_KEY_SUBSTRINGS) withholds their
 *     values if they reach the summariser anyway.
 *   - Every surface is isolated: one erroring surface reports itself and the
 *     others still return.
 *   - Read-only throughout. Nothing here writes, backfills or mutates.
 *   - Every live call is bounded and SAYS SO: one page, no cursor following; and
 *     for the two-step GitHub App surface, one report envelope, one of its signed
 *     NDJSON files, and a stated line cap on that file.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { AnthropicEnterpriseClient, oneBucketAfter } from '../anthropic/enterprise-client'
import { AnthropicAnalyticsClient } from '../anthropic/client'
import { GithubCopilotClient, type RawUserDailyCreditsPage } from '../reconciliation/adapters/github-client'
import { GithubAppAuth } from '../reconciliation/adapters/github-app-auth'
import { resolveOrgCredential, resolveEnterpriseCredential } from '../reconciliation/credentials'
import type { ResilientFetchOptions } from '../utils/resilient-fetch'
import type { RawPage } from '../utils/raw-page'
import {
  summariseShape,
  compareToBaseline,
  redactRequestParams,
  type ShapeSummary,
  type DriftReport,
  type WireShapeBaseline,
  type ParamPairs,
} from './wire-shape'
import anthropicEnterpriseUsageBaseline from './baselines/anthropic-enterprise-user-usage.json'
import anthropicEnterpriseCostBaseline from './baselines/anthropic-enterprise-user-cost.json'
import anthropicAdminBaseline from './baselines/anthropic-admin-claude-code.json'
import githubAiCreditBaseline from './baselines/github-ai-credit-usage.json'
import githubUserDailyCreditsBaseline from './baselines/github-user-daily-credits.json'

// The resolvers below use only db.execute(sql`…`), so this works on the
// RLS-bound request transaction as well as a schema-typed handle.
type Db = PostgresJsDatabase<Record<string, unknown>>

/*
 * How this engine reaches the database: a RUNNER, never a handle.
 *
 * Every DB read here is short and front-loaded — resolve a credential, resolve a
 * target, read stored payloads — and is then followed by network work that can
 * take up to PROBE_FETCH_OPTS.timeoutMs. Handing the engine one handle wrapped in
 * an RLS transaction would hold that transaction open across as many as four
 * external provider calls: idle-in-transaction, a pooled connection hostage to a
 * slow provider, and pool starvation under two concurrent operators.
 *
 * A runner inverts it. Each leaf read is `await runDb((tx) => …)` — its own SHORT
 * transaction, opened and closed before any fetch starts — so the RLS session
 * GUCs are set for every query AND no transaction is ever open while an HTTP call
 * is in flight. The route passes `(fn) => withRequestRls(event, fn)`; a test
 * passes `(fn) => fn(db)`.
 */
export type DbRunner = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

export type SurfaceId =
  | 'anthropic-enterprise-user-usage'
  | 'anthropic-enterprise-user-cost'
  | 'anthropic-admin-claude-code'
  | 'github-ai-credit-usage'
  | 'github-user-daily-credits'

export const SURFACE_ORDER: SurfaceId[] = [
  'anthropic-enterprise-user-usage',
  'anthropic-enterprise-user-cost',
  'anthropic-admin-claude-code',
  'github-ai-credit-usage',
  'github-user-daily-credits',
]

/**
 * The probe's OWN key for the lines of the downloaded NDJSON file on the GitHub
 * App surface. They arrive as a SEPARATE HTTP response, so there is no envelope
 * key to reuse; naming it distinctly keeps "GitHub sent this" and "the probe
 * assembled this" apart in the path list. Both the baseline and the surface's own
 * bound note say so.
 */
const NDJSON_RECORDS_KEY = 'ndjson_records'

interface SurfaceMeta {
  label: string
  /** The provider path, for display. */
  endpoint: string
  /** The path one provider row sits at in the summarised value. */
  itemsPath: string
  baseline: WireShapeBaseline
  /**
   * Path prefixes whose contents the poller's Zod parse STRIPS before storage —
   * a plain `z.object(...)` with no `.passthrough()`. The STORED scan cannot see
   * an unknown field inside these, so an empty `added` list under one of them is
   * evidence about our parser and about nothing else. Empty means every schema
   * on this surface's row path is passthrough and the stored scan is faithful.
   */
  strippingSubtrees: string[]
}

const SURFACES: Record<SurfaceId, SurfaceMeta> = {
  'anthropic-enterprise-user-usage': {
    label: 'Anthropic Enterprise — user_usage_report',
    endpoint: '/v1/organizations/analytics/user_usage_report',
    itemsPath: 'data[]',
    baseline: anthropicEnterpriseUsageBaseline as WireShapeBaseline,
    // UsageRow and Actor are .passthrough(); the nested cache_creation object is not.
    strippingSubtrees: ['data[].cache_creation'],
  },
  'anthropic-enterprise-user-cost': {
    label: 'Anthropic Enterprise — user_cost_report',
    endpoint: '/v1/organizations/analytics/user_cost_report',
    itemsPath: 'data[]',
    baseline: anthropicEnterpriseCostBaseline as WireShapeBaseline,
    // CostRow and Actor are both .passthrough() and neither nests a plain object.
    strippingSubtrees: [],
  },
  'anthropic-admin-claude-code': {
    label: 'Anthropic Admin — claude_code usage report',
    endpoint: '/v1/organizations/usage_report/claude_code',
    itemsPath: 'data[]',
    baseline: anthropicAdminBaseline as WireShapeBaseline,
    // client.ts:51-67 — the breakdown element and both of its nested objects strip.
    strippingSubtrees: [
      'data[].model_breakdown[]',
      'data[].model_breakdown[].tokens',
      'data[].model_breakdown[].estimated_cost',
    ],
  },
  'github-ai-credit-usage': {
    label: 'GitHub Copilot — ai_credit/usage (PAT mode)',
    endpoint: '/enterprises/{enterprise}/settings/billing/ai_credit/usage',
    itemsPath: 'usageItems[]',
    baseline: githubAiCreditBaseline as WireShapeBaseline,
    // UsageItemSchema is .passthrough() and its items nest no plain objects.
    strippingSubtrees: [],
  },
  'github-user-daily-credits': {
    label: 'GitHub Copilot — users-1-day metrics report (App mode)',
    endpoint: '/enterprises/{enterprise}/copilot/metrics/reports/users-1-day',
    itemsPath: `${NDJSON_RECORDS_KEY}[]`,
    baseline: githubUserDailyCreditsBaseline as WireShapeBaseline,
    // UserMetricsRecordSchema is .passthrough() and one NDJSON record nests no
    // plain objects, so the stored `raw.record` is a faithful copy of the line.
    strippingSubtrees: [],
  },
}

/*
 * Tight budget for the live calls: a probe an operator is watching should fail
 * fast and show the real status. retries:0 in particular means a 429 is surfaced
 * as a 429 instead of being slept through — the operator wants to SEE the rate
 * limit, not wait it out.
 */
const PROBE_FETCH_OPTS: ResilientFetchOptions = { timeoutMs: 20_000, retries: 0 }

/** Matches the page size the pollers request, so the probe issues production's request. */
const PROBE_PAGE_LIMIT = 1000

/**
 * How many NDJSON lines the GitHub App surface parses from the ONE signed file it
 * downloads. A few hundred records is a large enough sample to answer "which keys
 * does a per-user record carry", and the cap is REPORTED (FetchBoundInfo) for the
 * same reason the stored scan reports its row cap: a silent cap reads as "we looked
 * at everything".
 */
export const PROBE_NDJSON_LINE_LIMIT = 300

export interface WireShapeRequestInfo {
  method: 'GET'
  path: string
  /** Query parameters as sent, with identifying values replaced by a placeholder. */
  params: ParamPairs
  note: string
}

export interface ProviderErrorInfo {
  /** HTTP status. 0 means no response was received (DNS / TLS / timeout). */
  status: number
  /** The provider's own error text, verbatim apart from truncation + credential scrubbing. */
  bodyText: string
  truncated: boolean
}

/**
 * Paths present in the data and absent from the baseline. Against a
 * schema-derived baseline these are fields we RECEIVE AND NEVER DECLARED — the
 * exact defect class this feature exists to surface — so the meaning is carried
 * explicitly rather than left for a reader to infer from the path list.
 */
export interface UndeclaredReport {
  kind: 'undeclared-by-schema' | 'new-since-capture' | 'not-determined'
  paths: string[]
  note: string
}

/**
 * `data_refreshed_at` from the report envelope. We already parse this field on
 * both Enterprise reports and have never read it. Anthropic's published contract
 * states that rows after this timestamp are an INCOMPLETE TAIL and that figures
 * are revised for up to 30 days, so a number read without it may be provisional.
 *
 * THIS IS THE ONE FIELD VALUE THE REPORT RETURNS, and it is deliberate. It is an
 * ORG-LEVEL export watermark: it names no person, carries no figure, and is the
 * only honest answer to "is this number settled or still moving". Because it is
 * surfaced by DECISION here, the generic summariser must not also emit it as a
 * distinct value — wire-shape.ts's DELIBERATELY_SURFACED_KEYS stops it, so the
 * exception stays one considered exception instead of becoming a general rule.
 */
export interface FreshnessInfo {
  dataRefreshedAt: string | null
  /** The end of the window this probe asked for. */
  windowEndingAt: string
  /** dataRefreshedAt >= windowEndingAt. null when the field was absent or unparseable. */
  coversWindow: boolean | null
  note: string
}

/**
 * What a TWO-STEP live read actually fetched. Only the GitHub App surface has one:
 * a report envelope, then ONE of the signed NDJSON files it links to.
 *
 * Every field is a bound the probe APPLIED, reported rather than left implicit —
 * `itemCount` alone would read as a census of the enterprise-day when it is a
 * sample of one file's first `lineLimit` lines.
 */
export interface FetchBoundInfo {
  /** Entries `download_links` carried. Their VALUES are never reported — see `note`. */
  linksAvailable: number
  /** How many were downloaded. The probe follows the first link only. */
  linksRead: number
  /** The line cap applied to that file. */
  lineLimit: number
  /** Non-blank lines consumed from it, unparseable ones included. */
  linesRead: number
  /** True when the file held more non-blank lines than the cap — a PREFIX, not the file. */
  linesCapped: boolean
  /** Lines that were not JSON and were skipped. */
  linesUnparseable: number
  note: string
}

interface SurfaceBase {
  id: SurfaceId
  label: string
  endpoint: string
}

export type LiveSurfaceReport = SurfaceBase &
  (
    | { mode: 'live'; status: 'not-configured'; reason: string }
    | {
        mode: 'live'
        status: 'errored'
        target: string | null
        request: WireShapeRequestInfo | null
        error: ProviderErrorInfo
        durationMs: number
      }
    | {
        mode: 'live'
        status: 'ok'
        target: string | null
        request: WireShapeRequestInfo
        summary: ShapeSummary
        drift: DriftReport
        undeclared: UndeclaredReport
        freshness: FreshnessInfo | null
        /** Set only for a surface whose live read is bounded beyond "one page". */
        fetchBound: FetchBoundInfo | null
        durationMs: number
      }
  )

export interface StoredScanInfo {
  /** How far back the scan looked. */
  windowDays: number
  /** The row cap applied. */
  rowLimit: number
  /** Database rows read (each row's payload holds many provider rows). */
  rowsScanned: number
  /**
   * True only when a row BEYOND the cap exists — the scan is a PREFIX, not the
   * whole window. Determined by asking the database for rowLimit + 1 and
   * discarding the extra, so a window holding exactly rowLimit rows is reported
   * as what it is: exhaustive.
   */
  capped: boolean
  /** The table/column the rows came from. */
  source: string
  /**
   * How the rows were narrowed to THIS surface. Reported because a scan that
   * silently mixes lanes or tenants produces a shape report attributed to the
   * wrong one, and the operator has no other way to see which rows were read.
   */
  filter: string
  /**
   * The same window WITHOUT this surface's filters. Absent on surfaces that do
   * not compute one. See UnfilteredCounts for why it exists.
   */
  unfiltered?: UnfilteredCounts
}

/**
 * Row counts for the scan's window before its filters, so `rowsScanned: 0` can be
 * READ instead of guessed at.
 *
 * A live run reported zero rows for the GitHub stored scan, and zero is at least
 * three different facts: the window holds no Copilot data at all; it holds data
 * under a different enterprise_ref than the one probed; or it holds data for this
 * enterprise in the OTHER credential mode's payload shape. Those demand different
 * actions and looked identical to the operator, which is the defect this closes.
 */
export interface UnfilteredCounts {
  /** Rows the window holds for this provider, before enterprise, lane and shape filtering. */
  rowsForProvider: number
  /** Of those, how many carry the exact enterprise_ref this scan probed. */
  rowsForEnterprise: number
  note: string
}

/** How to read UnfilteredCounts against rowsScanned. */
const UNFILTERED_NOTE =
  'Read these against "rows scanned". All three zero: the window genuinely holds no rows for this ' +
  'provider. Provider rows above zero and enterprise rows zero: rows exist, but under a different ' +
  'enterprise_ref than the one probed — the probe picks the lowest-sorting registered enterprise. ' +
  'Enterprise rows above zero and rows scanned zero: this enterprise has rows, but none in this ' +
  "surface's lane and payload shape, which is the expected reading when the estate reconciles " +
  'through the other credential mode. The enterprise comparison uses the same exact-match ' +
  'predicate the scan does, so a casing difference shows up here as a mismatch rather than hiding.'

/**
 * Subtrees the STORED scan is structurally unable to describe, because the
 * poller's Zod parse strips unknown fields inside them before the payload is
 * written. Carried on the report so "nothing undeclared here" is never read as
 * evidence of absence. See this module's header.
 */
export interface UnobservableReport {
  paths: string[]
  note: string
}

export type StoredSurfaceReport = SurfaceBase &
  (
    | { mode: 'stored'; status: 'not-configured'; reason: string }
    | { mode: 'stored'; status: 'errored'; error: ProviderErrorInfo }
    | {
        mode: 'stored'
        status: 'ok'
        scan: StoredScanInfo
        summary: ShapeSummary
        drift: DriftReport
        undeclared: UndeclaredReport
        /**
         * Observed paths our Zod schema supplies a `.default(...)` for. Their
         * presence here is 100% by construction and is NOT evidence the provider
         * sent them — the poller stored a PARSED row, so a default is
         * indistinguishable from a real value at this layer.
         */
        defaultedPaths: string[]
        /** Subtrees this mode cannot see into. Empty means the stored rows are faithful. */
        unobservable: UnobservableReport
        durationMs: number
      }
  )

export interface WireShapeReport {
  generatedAt: string
  /** The UTC day the live probe asked for. */
  day: string
  mode: 'live' | 'stored' | 'both'
  note: string
  live: LiveSurfaceReport[]
  stored: StoredSurfaceReport[]
}

/** Yesterday (UTC) — a day the providers have had time to populate. */
export function defaultProbeDay(now: Date = new Date()): string {
  const d = new Date(now.getTime())
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/*
 * The operator-facing summary of what this report does and does not contain. It
 * states the ONE deliberate exception to "no body value is returned" rather than
 * claiming a blanket that the code does not deliver.
 */
const REPORT_NOTE =
  'Shape only. No successful response body is returned, stored or logged — only its key paths, ' +
  'types and counts, plus the values described next. Values are listed for low-cardinality string ' +
  'fields whose key names are not on the identity/money denylist and whose values do not look ' +
  'identifying. ONE envelope field is surfaced verbatim by design: data_refreshed_at, under ' +
  '"freshness". It is an org-level export watermark — it names no person and carries no figure — ' +
  'and it is the only honest signal for whether a figure is settled or still being revised, so it ' +
  'is reported once, on purpose, and excluded from the generic value collector. Live calls fetch ' +
  'ONE page and do not follow the pagination cursor, so the counts describe that page; the GitHub ' +
  'App surface is a two-step read (one report envelope, then ONE of the signed NDJSON files it ' +
  'links to, capped at a stated number of lines) and reports its own bound beside it. When a live ' +
  'call FAILS, the provider error body IS shown verbatim (truncated, credentials removed) — a ' +
  'classified reason hides the cause. The stored scan reads PARSED payloads, so it cannot see ' +
  'inside the subtrees each surface lists as unobservable.'

/** Turn a provider error / thrown transport failure into the report's error shape. */
function errorInfo(page: Extract<RawPage, { ok: false }>): ProviderErrorInfo {
  return { status: page.status, bodyText: page.bodyText, truncated: page.truncated }
}

function thrownInfo(err: unknown): ProviderErrorInfo {
  return {
    status: 0,
    bodyText: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    truncated: false,
  }
}

/** Derive the undeclared-paths section from a drift report + the baseline's provenance. */
function undeclaredFrom(drift: DriftReport, baseline: WireShapeBaseline): UndeclaredReport {
  if (drift.status === 'no-baseline' || drift.status === 'no-data') {
    return {
      kind: 'not-determined',
      paths: [],
      note:
        drift.status === 'no-data'
          ? 'No rows were observed, so nothing can be said about undeclared fields.'
          : 'No baseline is checked in for this surface.',
    }
  }
  if (baseline.provenance === 'schema-derived') {
    return {
      kind: 'undeclared-by-schema',
      paths: drift.added,
      note:
        'Present in the data and absent from our Zod schema. These are fields TokenScope ' +
        'receives and ignores.',
    }
  }
  return {
    kind: 'new-since-capture',
    paths: drift.added,
    note: `Present in the data and absent from the baseline captured at ${baseline.capturedAt ?? 'an unrecorded time'}.`,
  }
}

/** The paths in this summary that the baseline marks as schema-defaulted. */
function defaultedPathsIn(summary: ShapeSummary, baseline: WireShapeBaseline): string[] {
  const defaulted = new Set(baseline.paths.filter((p) => p.defaulted).map((p) => p.path))
  return summary.paths.map((p) => p.path).filter((p) => defaulted.has(p)).sort()
}

/** The stored mode's blind spots for one surface, stated rather than left to be inferred. */
function unobservableIn(meta: SurfaceMeta): UnobservableReport {
  if (meta.strippingSubtrees.length === 0) {
    return {
      paths: [],
      note:
        'Every schema on this surface’s row path is .passthrough(), so an unknown field the ' +
        'provider sent survived into storage and would appear above. Nothing is hidden from this ' +
        'scan by the parse.',
    }
  }
  return {
    paths: [...meta.strippingSubtrees],
    note:
      'The poller stores the PARSED payload, and these subtrees are parsed by a plain z.object ' +
      'that DISCARDS unknown fields. An unknown field nested inside one of them was dropped before ' +
      'storage, so its absence from this scan says nothing about whether the provider sent it. ' +
      'Only the live probe can see into these.',
  }
}

/** Read `data_refreshed_at` off an Enterprise report envelope. */
function freshnessFrom(body: unknown, windowEndingAt: string): FreshnessInfo {
  const raw = (body as { data_refreshed_at?: unknown })?.data_refreshed_at
  const dataRefreshedAt = typeof raw === 'string' ? raw : null
  let coversWindow: boolean | null = null
  if (dataRefreshedAt) {
    const refreshed = Date.parse(dataRefreshedAt)
    const windowEnd = Date.parse(windowEndingAt)
    if (Number.isFinite(refreshed) && Number.isFinite(windowEnd)) coversWindow = refreshed >= windowEnd
  }
  return {
    dataRefreshedAt,
    windowEndingAt,
    coversWindow,
    note:
      "Anthropic's published contract states that rows after data_refreshed_at are an incomplete " +
      'tail, and that figures are revised for up to 30 days. A window this marker covers is ' +
      'therefore settled-so-far, not final.',
  }
}

// ── Configuration discovery ─────────────────────────────────────────────────

export interface AnthropicOrgTarget {
  externalOrgId: string
  apiKind: 'enterprise-analytics' | 'claude-code-admin'
}

/**
 * The Anthropic orgs to probe, one per api_kind (deterministically the
 * lowest external_org_id), because api_kind is what selects the client —
 * analytics-poller.ts:710 branches on exactly this column.
 */
export async function findAnthropicTargets(db: Db): Promise<AnthropicOrgTarget[]> {
  const rows = await db.execute<{ external_org_id: string; api_kind: string }>(sql`
    SELECT DISTINCT ON (api_kind) external_org_id, api_kind
      FROM provider_org
     WHERE provider = 'anthropic'
       AND api_kind IN ('enterprise-analytics', 'claude-code-admin')
     ORDER BY api_kind, external_org_id
  `)
  const out: AnthropicOrgTarget[] = []
  for (const r of rows) {
    if (r.api_kind === 'enterprise-analytics' || r.api_kind === 'claude-code-admin') {
      out.push({ externalOrgId: r.external_org_id, apiKind: r.api_kind })
    }
  }
  return out
}

/** The GitHub enterprise to probe (deterministically the lowest external_id). */
export async function findGithubEnterprise(db: Db): Promise<string | null> {
  const rows = await db.execute<{ external_id: string }>(sql`
    SELECT external_id
      FROM provider_enterprise
     WHERE provider = 'github'
     ORDER BY external_id
     LIMIT 1
  `)
  return rows[0]?.external_id ?? null
}

/**
 * A Copilot login to ask ai_credit/usage about. The endpoint is per-user and
 * rejects org+user together, so a login is mandatory. Its value never reaches the
 * report — redactRequestParams replaces it.
 */
export async function findGithubProbeLogin(db: Db, enterpriseSlug: string): Promise<string | null> {
  const rows = await db.execute<{ github_login: string }>(sql`
    SELECT github_login
      FROM teammate_identity_map
     WHERE github_login IS NOT NULL
       AND lower(coalesce(enterprise_slug, '')) = lower(${enterpriseSlug})
     ORDER BY github_login
     LIMIT 1
  `)
  return rows[0]?.github_login ?? null
}

// ── Live probes ─────────────────────────────────────────────────────────────

function notConfigured(id: SurfaceId, reason: string, mode: 'live'): LiveSurfaceReport
function notConfigured(id: SurfaceId, reason: string, mode: 'stored'): StoredSurfaceReport
function notConfigured(
  id: SurfaceId,
  reason: string,
  mode: 'live' | 'stored',
): LiveSurfaceReport | StoredSurfaceReport {
  const meta = SURFACES[id]
  return {
    id,
    label: meta.label,
    endpoint: meta.endpoint,
    mode,
    status: 'not-configured',
    reason,
  } as LiveSurfaceReport | StoredSurfaceReport
}

/** Build the OK/errored live report from a raw page. */
function liveFromPage(
  id: SurfaceId,
  target: string | null,
  raw: { path: string; params: ParamPairs; page: RawPage },
  durationMs: number,
  opts: { withFreshness: boolean; windowEndingAt: string; fetchBound?: FetchBoundInfo },
): LiveSurfaceReport {
  const meta = SURFACES[id]
  const request: WireShapeRequestInfo = {
    method: 'GET',
    path: raw.path,
    params: redactRequestParams(raw.params),
    note:
      'First page only — the pagination cursor is not followed. Parameter redaction is by key ' +
      'name and deliberately over-matches, so a <redacted> value is not necessarily a secret.',
  }
  if (!raw.page.ok) {
    return {
      id,
      label: meta.label,
      endpoint: meta.endpoint,
      mode: 'live',
      status: 'errored',
      target,
      request,
      error: errorInfo(raw.page),
      durationMs,
    }
  }
  const summary = summariseShape(raw.page.body, { itemsPath: meta.itemsPath })
  const drift = compareToBaseline(meta.baseline, summary)
  return {
    id,
    label: meta.label,
    endpoint: meta.endpoint,
    mode: 'live',
    status: 'ok',
    target,
    request,
    summary,
    drift,
    undeclared: undeclaredFrom(drift, meta.baseline),
    freshness: opts.withFreshness ? freshnessFrom(raw.page.body, opts.windowEndingAt) : null,
    fetchBound: opts.fetchBound ?? null,
    durationMs,
  }
}

function erroredLive(id: SurfaceId, target: string | null, error: ProviderErrorInfo, durationMs: number): LiveSurfaceReport {
  const meta = SURFACES[id]
  return {
    id,
    label: meta.label,
    endpoint: meta.endpoint,
    mode: 'live',
    status: 'errored',
    target,
    request: null,
    error,
    durationMs,
  }
}

async function probeAnthropicEnterprise(
  runDb: DbRunner,
  target: AnthropicOrgTarget,
  day: string,
  endpointBase: string,
): Promise<LiveSurfaceReport[]> {
  const ids: SurfaceId[] = ['anthropic-enterprise-user-usage', 'anthropic-enterprise-user-cost']
  // Its own short transaction, closed before the first fetch below.
  const credential = await runDb((tx) =>
    resolveOrgCredential(tx, { provider: 'anthropic', externalOrgId: target.externalOrgId }),
  )
  if (!credential) {
    const reason = `Anthropic org ${target.externalOrgId} is registered as enterprise-analytics but no API key resolves for its credential_secret_name.`
    return ids.map((id) => notConfigured(id, reason, 'live'))
  }
  // The exact window the poller uses for this report (analytics-poller.ts:437-440).
  const startingAt = `${day}T00:00:00Z`
  const endingAt = oneBucketAfter(startingAt)
  /*
   * MIRRORS THE PRODUCTION CALLERS, which send different arrays per report
   * (analytics-poller.ts, reconciliation/adapters/anthropic.ts): cost_type goes
   * to the cost report only, because UsageRow has no such field.
   *
   * The probe exists to observe what production receives. Asking a different
   * question makes it blind to production's actual shape -- in particular
   * `requests: null`, which the provider returns only when cost_type is
   * grouped, and which is exactly the value that broke the parse.
   */
  const usageGroupBy = ['product', 'model']
  const costGroupBy = ['product', 'model', 'cost_type']
  const client = new AnthropicEnterpriseClient(endpointBase, credential.value)

  const out: LiveSurfaceReport[] = []
  for (const [id, report] of [
    ['anthropic-enterprise-user-usage', 'user_usage_report'],
    ['anthropic-enterprise-user-cost', 'user_cost_report'],
  ] as const) {
    const started = Date.now()
    try {
      const raw = await client.rawReportPage(report, {
        startingAt,
        endingAt,
        groupBy: report === 'user_cost_report' ? costGroupBy : usageGroupBy,
      })
      out.push(
        liveFromPage(id, target.externalOrgId, raw, Date.now() - started, {
          withFreshness: true,
          windowEndingAt: endingAt,
        }),
      )
    } catch (err) {
      out.push(erroredLive(id, target.externalOrgId, thrownInfo(err), Date.now() - started))
    }
  }
  return out
}

async function probeAnthropicAdmin(
  runDb: DbRunner,
  target: AnthropicOrgTarget,
  day: string,
  endpointBase: string,
): Promise<LiveSurfaceReport> {
  const id: SurfaceId = 'anthropic-admin-claude-code'
  const credential = await runDb((tx) =>
    resolveOrgCredential(tx, { provider: 'anthropic', externalOrgId: target.externalOrgId }),
  )
  if (!credential) {
    return notConfigured(
      id,
      `Anthropic org ${target.externalOrgId} is registered as claude-code-admin but no API key resolves for its credential_secret_name.`,
      'live',
    )
  }
  const client = new AnthropicAnalyticsClient(endpointBase, credential.value)
  const started = Date.now()
  try {
    const raw = await client.rawClaudeCodeUsagePage({ startingAt: day, limit: PROBE_PAGE_LIMIT })
    return liveFromPage(id, target.externalOrgId, raw, Date.now() - started, {
      withFreshness: false,
      windowEndingAt: day,
    })
  } catch (err) {
    return erroredLive(id, target.externalOrgId, thrownInfo(err), Date.now() - started)
  }
}

const GITHUB_PAT_SURFACE: SurfaceId = 'github-ai-credit-usage'
const GITHUB_APP_SURFACE: SurfaceId = 'github-user-daily-credits'

/*
 * The two GitHub Copilot read surfaces, from ONE credential resolution.
 *
 * The credential kind decides which of them reconciliation actually calls
 * (github.ts's `scope.credential.kind === 'github-app'` branch), so the probe
 * calls that one and reports the other as 'not-configured'. That is the same
 * neutral state the unused Anthropic api_kind variant reports: a deployment that
 * deliberately runs one mode has not failed at the other, and neither reason
 * below describes a call that was made.
 */
async function probeGithub(runDb: DbRunner, day: string): Promise<LiveSurfaceReport[]> {
  const both = (reason: string): LiveSurfaceReport[] => [
    notConfigured(GITHUB_PAT_SURFACE, reason, 'live'),
    notConfigured(GITHUB_APP_SURFACE, reason, 'live'),
  ]
  const slug = await runDb((tx) => findGithubEnterprise(tx))
  if (!slug) return both('No GitHub enterprise is registered in provider_enterprise.')

  let credential: Awaited<ReturnType<typeof resolveEnterpriseCredential>>
  try {
    credential = await runDb((tx) => resolveEnterpriseCredential(tx, { provider: 'github', externalId: slug }))
  } catch (err) {
    // MissingGithubAppKeyError and friends are CONFIG gaps, not provider errors.
    // Its message names only the secret NAME, never a value.
    return both(err instanceof Error ? err.message : String(err))
  }
  if (!credential) {
    return both(`GitHub enterprise ${slug} has no credential wired for its credential_secret_name.`)
  }

  if (credential.kind === 'github-app') {
    return [
      notConfigured(
        GITHUB_PAT_SURFACE,
        `GitHub enterprise ${slug} is configured in App mode (provider_enterprise.github_app_id is set), so ai_credit/usage is not the read surface in use here — reconciliation reads the users-1-day metrics report instead. Nothing was called and nothing failed.`,
        'live',
      ),
      await probeGithubUserDailyCredits(slug, credential, day),
    ]
  }
  return [
    await probeGithubAiCredit(runDb, slug, credential.value, day),
    notConfigured(
      GITHUB_APP_SURFACE,
      `GitHub enterprise ${slug} is configured in PAT mode (provider_enterprise.github_app_id is not set), so the users-1-day metrics report is not the read surface in use here — reconciliation reads ai_credit/usage instead. Nothing was called and nothing failed.`,
      'live',
    ),
  ]
}

/** PAT mode: one page of per-user ai_credit/usage for one login and one day. */
async function probeGithubAiCredit(
  runDb: DbRunner,
  slug: string,
  pat: string,
  day: string,
): Promise<LiveSurfaceReport> {
  const id = GITHUB_PAT_SURFACE
  const login = await runDb((tx) => findGithubProbeLogin(tx, slug))
  if (!login) {
    return notConfigured(
      id,
      `GitHub enterprise ${slug} has no mapped Copilot login in teammate_identity_map. ai_credit/usage is a per-user endpoint and rejects a query without one.`,
      'live',
    )
  }
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number]
  const started = Date.now()
  try {
    // Inside the try for the same reason as its App-mode sibling below: withPat
    // REFUSES a value that parses as a PEM (the hardened seam against a key being
    // sent as a bearer), and an escaping throw would take every other surface down.
    const client = GithubCopilotClient.withPat(slug, pat, PROBE_FETCH_OPTS)
    const raw = await client.rawAiCreditUsagePage(login, { year, month, day: dayOfMonth })
    return liveFromPage(id, slug, raw, Date.now() - started, { withFreshness: false, windowEndingAt: day })
  } catch (err) {
    return erroredLive(id, slug, thrownInfo(err), Date.now() - started)
  }
}

/** App mode: the users-1-day report envelope plus ONE of its signed NDJSON files. */
async function probeGithubUserDailyCredits(
  slug: string,
  credential: { value: string; appId?: string },
  day: string,
): Promise<LiveSurfaceReport> {
  const id = GITHUB_APP_SURFACE
  if (!credential.appId) {
    return notConfigured(
      id,
      `GitHub enterprise ${slug} resolved an App credential carrying no App id, so no installation token can be minted for the metrics report.`,
      'live',
    )
  }
  const started = Date.now()
  try {
    /*
     * Constructed INSIDE the try. GithubAppAuth asserts the App id and decodes the
     * PEM at construction (fail-loud, by design), so a misconfigured key throws
     * here — and outside the try that throw escapes runLiveProbes and takes every
     * other surface's report down with it. Surface isolation is a promise this
     * module makes in its header; a config error is exactly the case that tests it.
     */
    const client = GithubCopilotClient.withApp(
      slug,
      new GithubAppAuth(credential.appId, credential.value),
      PROBE_FETCH_OPTS,
    )
    const raw = await client.rawUserDailyCreditsPage(day, { lineLimit: PROBE_NDJSON_LINE_LIMIT })
    return liveFromTwoStep(id, slug, raw, day, Date.now() - started)
  } catch (err) {
    return erroredLive(id, slug, thrownInfo(err), Date.now() - started)
  }
}

/** The bound the App surface applied, as the report states it. */
function fetchBoundFrom(nd: RawUserDailyCreditsPage['ndjson']): FetchBoundInfo {
  return {
    linksAvailable: nd?.linksAvailable ?? 0,
    linksRead: nd?.linksRead ?? 0,
    lineLimit: nd?.lineLimit ?? PROBE_NDJSON_LINE_LIMIT,
    linesRead: nd?.linesRead ?? 0,
    linesCapped: nd?.linesCapped ?? false,
    linesUnparseable: nd?.linesUnparseable ?? 0,
    note:
      'A TWO-STEP read: one users-1-day report envelope, then ONE of the signed NDJSON files it ' +
      `links to, parsed to at most ${nd?.lineLimit ?? PROBE_NDJSON_LINE_LIMIT} lines. The record ` +
      'paths below therefore describe that sample, not the enterprise-day. ' +
      `\`${NDJSON_RECORDS_KEY}\` is the probe's own key for those lines — GitHub returns them as a ` +
      'separate file, not as part of the envelope. The download_links VALUES are signed URLs and ' +
      'are never returned by the probe; the report\'s key denylist withholds them as well.',
  }
}

/**
 * Assemble the App surface's report from the two-step read.
 *
 * Both stages are reported on ONE surface, so the envelope's own keys and the
 * per-user record's keys are read together — which is what the question "does a
 * Copilot per-user record carry a model dimension" needs. A step-2 failure is an
 * ERROR for the whole surface rather than an `ok` with zero records: zero records
 * with no error would read as "GitHub sent nothing".
 *
 * Exported for unit testing: this is the ONLY place a live `download_links` value
 * can reach a report, so the test that it does not has to drive this function
 * rather than a layer above it (the App path needs a real installation token, so
 * no stub can reach it end to end).
 */
export function liveFromTwoStep(
  id: SurfaceId,
  target: string,
  raw: RawUserDailyCreditsPage,
  day: string,
  durationMs: number,
): LiveSurfaceReport {
  const req = { path: raw.path, params: raw.params }
  const opts = { withFreshness: false, windowEndingAt: day }
  if (!raw.envelope.ok) {
    return liveFromPage(id, target, { ...req, page: raw.envelope }, durationMs, opts)
  }
  const nd = raw.ndjson
  if (nd?.error) {
    // The step is named because the two calls fail for entirely different reasons
    // — a permission gap on the report, a signature/expiry problem on the file.
    // The provider's own text follows verbatim (credential- and link-scrubbed).
    return liveFromPage(
      id,
      target,
      {
        ...req,
        page: {
          ...nd.error,
          bodyText: `The report envelope read OK; downloading its NDJSON file failed. ${nd.error.bodyText}`,
        },
      },
      durationMs,
      opts,
    )
  }
  const envelope = raw.envelope.body
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return liveFromPage(
      id,
      target,
      {
        ...req,
        page: {
          ok: false,
          status: raw.envelope.status,
          bodyText: `HTTP ${raw.envelope.status} but the report envelope is not a JSON object, so its download_links cannot be read. Observed JSON type: ${envelope === null ? 'null' : Array.isArray(envelope) ? 'array' : typeof envelope}.`,
          truncated: false,
        },
      },
      durationMs,
      opts,
    )
  }
  const root: Record<string, unknown> = { ...envelope, [NDJSON_RECORDS_KEY]: nd?.records ?? [] }
  return liveFromPage(id, target, { ...req, page: { ok: true, status: raw.envelope.status, body: root } }, durationMs, {
    ...opts,
    fetchBound: fetchBoundFrom(nd),
  })
}

export async function runLiveProbes(runDb: DbRunner, opts: { day: string }): Promise<LiveSurfaceReport[]> {
  const endpointBase = process.env.NUXT_ANTHROPIC_API_ENDPOINT
  const targets = await runDb((tx) => findAnthropicTargets(tx))
  const byKind = new Map(targets.map((t) => [t.apiKind, t]))
  const reports = new Map<SurfaceId, LiveSurfaceReport>()

  const enterprise = byKind.get('enterprise-analytics')
  if (!enterprise) {
    const reason =
      'No Anthropic org is registered with api_kind = enterprise-analytics. This is an expected state for an environment that reconciles Anthropic through the Admin API instead.'
    reports.set('anthropic-enterprise-user-usage', notConfigured('anthropic-enterprise-user-usage', reason, 'live'))
    reports.set('anthropic-enterprise-user-cost', notConfigured('anthropic-enterprise-user-cost', reason, 'live'))
  } else if (!endpointBase) {
    const reason = 'NUXT_ANTHROPIC_API_ENDPOINT is not set, so no Anthropic base URL is configured.'
    reports.set('anthropic-enterprise-user-usage', notConfigured('anthropic-enterprise-user-usage', reason, 'live'))
    reports.set('anthropic-enterprise-user-cost', notConfigured('anthropic-enterprise-user-cost', reason, 'live'))
  } else {
    for (const r of await probeAnthropicEnterprise(runDb, enterprise, opts.day, endpointBase)) reports.set(r.id, r)
  }

  const admin = byKind.get('claude-code-admin')
  if (!admin) {
    reports.set(
      'anthropic-admin-claude-code',
      notConfigured(
        'anthropic-admin-claude-code',
        'No Anthropic org is registered with api_kind = claude-code-admin. This is an expected state for an environment that reconciles Anthropic through Enterprise Analytics instead.',
        'live',
      ),
    )
  } else if (!endpointBase) {
    reports.set(
      'anthropic-admin-claude-code',
      notConfigured('anthropic-admin-claude-code', 'NUXT_ANTHROPIC_API_ENDPOINT is not set, so no Anthropic base URL is configured.', 'live'),
    )
  } else {
    reports.set('anthropic-admin-claude-code', await probeAnthropicAdmin(runDb, admin, opts.day, endpointBase))
  }

  for (const r of await probeGithub(runDb, opts.day)) reports.set(r.id, r)

  return SURFACE_ORDER.map((id) => reports.get(id)!).filter(Boolean)
}

// ── Stored-payload scan ─────────────────────────────────────────────────────

/** Default window for the stored scan. Wide enough to span a poll cadence, bounded. */
export const STORED_DEFAULT_WINDOW_DAYS = 30
/** Default row cap. Each row's payload holds many provider rows, so this is a large sample. */
export const STORED_DEFAULT_ROW_LIMIT = 200
export const STORED_MAX_ROW_LIMIT = 2000

/** Everything that is an array becomes elements; anything else becomes one element. */
function asRows(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function storedOk(
  id: SurfaceId,
  rows: unknown[],
  scan: StoredScanInfo,
  durationMs: number,
): StoredSurfaceReport {
  const meta = SURFACES[id]
  // Wrapped under the surface's OWN item key so paths line up with the LIVE
  // baselines (data[]… / usageItems[]… / ndjson_records[]…) — one baseline serves
  // both modes, which is what makes the two comparable.
  const root = { [meta.itemsPath.replace(/\[\]$/, '')]: rows }
  const summary = summariseShape(root, { itemsPath: meta.itemsPath })
  // A stored payload has no HTTP envelope, so the comparison is scoped to the row
  // subtree; without this every envelope key would read as removed.
  const drift = compareToBaseline(meta.baseline, summary, { scopePrefix: meta.itemsPath })
  return {
    id,
    label: meta.label,
    endpoint: meta.endpoint,
    mode: 'stored',
    status: 'ok',
    scan,
    summary,
    drift,
    undeclared: undeclaredFrom(drift, meta.baseline),
    defaultedPaths: defaultedPathsIn(summary, meta.baseline),
    unobservable: unobservableIn(meta),
    durationMs,
  }
}

function storedErrored(id: SurfaceId, err: unknown): StoredSurfaceReport {
  const meta = SURFACES[id]
  return {
    id,
    label: meta.label,
    endpoint: meta.endpoint,
    mode: 'stored',
    status: 'errored',
    error: thrownInfo(err),
  }
}

export interface StoredScanOptions {
  windowDays: number
  rowLimit: number
}

/**
 * Scan stored provider payloads. Read-only, credential-free, no provider call.
 *
 * The two Anthropic Enterprise surfaces are derived from the SAME row sample
 * (one payload carries both `usage` and `cost`), so "usage has model, cost does
 * not" cannot be a sampling artefact of two different scans.
 */
export async function runStoredScans(runDb: DbRunner, opts: StoredScanOptions): Promise<StoredSurfaceReport[]> {
  const targets = await runDb((tx) => findAnthropicTargets(tx))
  const byKind = new Map(targets.map((t) => [t.apiKind, t]))
  const reports = new Map<SurfaceId, StoredSurfaceReport>()
  const { windowDays, rowLimit } = opts

  const enterprise = byKind.get('enterprise-analytics')
  if (!enterprise) {
    const reason = 'No Anthropic org is registered with api_kind = enterprise-analytics, so no Enterprise payloads are stored.'
    reports.set('anthropic-enterprise-user-usage', notConfigured('anthropic-enterprise-user-usage', reason, 'stored'))
    reports.set('anthropic-enterprise-user-cost', notConfigured('anthropic-enterprise-user-cost', reason, 'stored'))
  } else {
    const started = Date.now()
    try {
      const read = await runDb((tx) => readAnthropicPayloads(tx, 'enterprise-analytics', windowDays, rowLimit))
      const payloads = read.rows
      const scan: StoredScanInfo = {
        windowDays,
        rowLimit,
        rowsScanned: payloads.length,
        capped: read.capped,
        source: 'actual_spend.raw_payload',
        filter: 'source = anthropic-analytics-api:<the org whose api_kind is enterprise-analytics>',
      }
      const usageRows = payloads.flatMap((p) => asRows((p as { usage?: unknown })?.usage))
      const costRows = payloads.flatMap((p) => asRows((p as { cost?: unknown })?.cost))
      reports.set('anthropic-enterprise-user-usage', storedOk('anthropic-enterprise-user-usage', usageRows, scan, Date.now() - started))
      reports.set('anthropic-enterprise-user-cost', storedOk('anthropic-enterprise-user-cost', costRows, scan, Date.now() - started))
    } catch (err) {
      reports.set('anthropic-enterprise-user-usage', storedErrored('anthropic-enterprise-user-usage', err))
      reports.set('anthropic-enterprise-user-cost', storedErrored('anthropic-enterprise-user-cost', err))
    }
  }

  const admin = byKind.get('claude-code-admin')
  if (!admin) {
    reports.set(
      'anthropic-admin-claude-code',
      notConfigured('anthropic-admin-claude-code', 'No Anthropic org is registered with api_kind = claude-code-admin, so no Admin payloads are stored.', 'stored'),
    )
  } else {
    const started = Date.now()
    try {
      const read = await runDb((tx) => readAnthropicPayloads(tx, 'claude-code-admin', windowDays, rowLimit))
      const scan: StoredScanInfo = {
        windowDays,
        rowLimit,
        rowsScanned: read.rows.length,
        capped: read.capped,
        source: 'actual_spend.raw_payload',
        filter: 'source = anthropic-analytics-api:<the org whose api_kind is claude-code-admin>',
      }
      // The Admin poller stores either one record or an array of them.
      reports.set('anthropic-admin-claude-code', storedOk('anthropic-admin-claude-code', read.rows.flatMap(asRows), scan, Date.now() - started))
    } catch (err) {
      reports.set('anthropic-admin-claude-code', storedErrored('anthropic-admin-claude-code', err))
    }
  }

  /*
   * BOTH Copilot shapes are scanned, whatever credential the enterprise holds
   * today. Each reader selects on the PAYLOAD, so an estate that migrated
   * PAT -> App mid-window reports real rows on both surfaces instead of one empty
   * one, and the mode in force today cannot hide the history of the other.
   */
  const slug = await runDb((tx) => findGithubEnterprise(tx))
  if (!slug) {
    const reason = 'No GitHub enterprise is registered in provider_enterprise.'
    reports.set('github-ai-credit-usage', notConfigured('github-ai-credit-usage', reason, 'stored'))
    reports.set('github-user-daily-credits', notConfigured('github-user-daily-credits', reason, 'stored'))
  } else {
    const lane = `category IN (${GITHUB_COPILOT_CATEGORIES.join(', ')})`
    const github = [
      {
        id: 'github-ai-credit-usage' as const,
        read: readGithubUsageItems,
        filter: `enterprise_ref = the probed enterprise, ${lane}, raw->'items' is an array (the PAT-mode payload)`,
      },
      {
        id: 'github-user-daily-credits' as const,
        read: readGithubMetricsRecords,
        filter: `enterprise_ref = the probed enterprise, ${lane}, raw->'record' is an object (the App-mode payload)`,
      },
    ]
    for (const surface of github) {
      const started = Date.now()
      try {
        const counts = await runDb((tx) => readGithubRowCounts(tx, slug, windowDays))
        const read = await runDb((tx) => surface.read(tx, slug, windowDays, rowLimit))
        const scan: StoredScanInfo = {
          windowDays,
          rowLimit,
          rowsScanned: read.rows.length,
          capped: read.capped,
          source: 'reconciliation_record.raw',
          filter: surface.filter,
          unfiltered: { ...counts, note: UNFILTERED_NOTE },
        }
        reports.set(surface.id, storedOk(surface.id, read.rows.flatMap(asRows), scan, Date.now() - started))
      } catch (err) {
        reports.set(surface.id, storedErrored(surface.id, err))
      }
    }
  }

  return SURFACE_ORDER.map((id) => reports.get(id)!).filter(Boolean)
}

/**
 * A bounded read: at most `rowLimit` rows, plus whether MORE existed beyond them.
 *
 * `capped` cannot be derived from `rows.length === rowLimit` — a window holding
 * exactly rowLimit rows is exhaustive, and reporting it as truncated sends the
 * operator looking for data that is already all there. Every reader below asks
 * the database for rowLimit + 1, keeps rowLimit, and lets the existence of the
 * discarded row be the answer.
 */
interface BoundedRead {
  rows: unknown[]
  capped: boolean
}

function bounded(all: unknown[], rowLimit: number): BoundedRead {
  return { rows: all.slice(0, rowLimit), capped: all.length > rowLimit }
}

/**
 * The most recent stored Anthropic payloads for one api_kind. Bounded by BOTH a
 * date window and a row cap; the caller reports whether the cap was hit, because
 * a silently truncated scan reads as "we looked at everything".
 */
async function readAnthropicPayloads(
  db: Db,
  apiKind: 'enterprise-analytics' | 'claude-code-admin',
  windowDays: number,
  rowLimit: number,
): Promise<BoundedRead> {
  const rows = await db.execute<{ payload: unknown }>(sql`
    SELECT a.raw_payload AS payload
      FROM actual_spend a
      JOIN provider_org po
        ON po.provider = 'anthropic'
       AND po.api_kind = ${apiKind}
       AND a.source = 'anthropic-analytics-api:' || po.external_org_id
     WHERE a.raw_payload IS NOT NULL
       AND a.date >= (CURRENT_DATE - make_interval(days => ${windowDays}))
     ORDER BY a.pulled_at DESC
     LIMIT ${rowLimit + 1}
  `)
  return bounded(rows.map((r) => r.payload), rowLimit)
}

/*
 * The reconciliation categories carrying per-user Copilot CONSUMPTION, in either
 * credential mode. normaliseSeatDay (github.ts:157) emits one line per category
 * from categoriseSku, which returns only these two; normaliseMetricsCreditLine
 * (github.ts:204) writes copilot_interactive unconditionally. So this list is the
 * lane for both shapes — exactly and only. Naming it keeps a future category that
 * happens to carry an `items` array or a `record` object (a different endpoint, a
 * different shape) out of these surfaces' reports.
 */
const GITHUB_COPILOT_CATEGORIES = ['copilot_interactive', 'copilot_coding_agent'] as const

/** Every category predicate below, as one reusable fragment. */
const githubLaneFilter = sql`r.category IN (${sql.join(GITHUB_COPILOT_CATEGORIES.map((c) => sql`${c}`), sql`, `)})`

/**
 * The most recent stored Copilot ai_credit usageItems arrays FOR ONE ENTERPRISE —
 * the PAT-mode payload, written by normaliseSeatDay as
 * `raw = { login, licenseOrg, periodDate, category, items }`. Same bounding contract.
 *
 * Every filter is load-bearing, not defensive garnish. Without `enterprise_ref`
 * a second registered enterprise's payloads are summarised and attributed to the
 * one named in the report — the probe would be describing a tenant it did not
 * probe. Without `category` any other GitHub lane that stores an `items` array
 * joins the same summary, and a shape report that silently unions two endpoints
 * is worse than no report: every path in it is true of *something*. And the
 * `jsonb_typeof(raw->'items')` test is what makes this the PAT-SHAPE reader
 * rather than a PAT-MODE one: the App-mode rows sitting beside these in a
 * migrated estate carry no `items` and are excluded by their payload, not by an
 * assumption about which credential is configured today.
 */
async function readGithubUsageItems(
  db: Db,
  enterpriseSlug: string,
  windowDays: number,
  rowLimit: number,
): Promise<BoundedRead> {
  const rows = await db.execute<{ items: unknown }>(sql`
    SELECT r.raw -> 'items' AS items
      FROM reconciliation_record r
     WHERE r.provider = 'github'
       AND r.enterprise_ref = ${enterpriseSlug}
       AND ${githubLaneFilter}
       AND jsonb_typeof(r.raw -> 'items') = 'array'
       AND r.period_date >= (CURRENT_DATE - make_interval(days => ${windowDays}))
     ORDER BY r.computed_at DESC
     LIMIT ${rowLimit + 1}
  `)
  return bounded(rows.map((r) => r.items), rowLimit)
}

/**
 * The most recent stored Copilot users-1-day NDJSON records FOR ONE ENTERPRISE —
 * the App-mode payload, written by normaliseMetricsCreditLine (github.ts:213) as
 * `raw = { login, periodDate, credits, record }` where `record` is the SINGLE
 * per-user NDJSON line. One row is one record, so the reader selects the object
 * and asRows wraps it; there is no array to flatten as there is on the PAT shape.
 *
 * Selected by PAYLOAD, exactly like its sibling above and for the same reason: a
 * `jsonb_typeof(raw->'record') = 'object'` test finds these rows in an estate
 * that has since switched back to a PAT, where a credential-kind test would not.
 */
async function readGithubMetricsRecords(
  db: Db,
  enterpriseSlug: string,
  windowDays: number,
  rowLimit: number,
): Promise<BoundedRead> {
  const rows = await db.execute<{ record: unknown }>(sql`
    SELECT r.raw -> 'record' AS record
      FROM reconciliation_record r
     WHERE r.provider = 'github'
       AND r.enterprise_ref = ${enterpriseSlug}
       AND ${githubLaneFilter}
       AND jsonb_typeof(r.raw -> 'record') = 'object'
       AND r.period_date >= (CURRENT_DATE - make_interval(days => ${windowDays}))
     ORDER BY r.computed_at DESC
     LIMIT ${rowLimit + 1}
  `)
  return bounded(rows.map((r) => r.record), rowLimit)
}

/**
 * The same window with NONE of a surface's filters, so `rowsScanned: 0` can be
 * diagnosed instead of guessed at. See UnfilteredCounts.
 *
 * The enterprise comparison deliberately repeats the scans' EXACT-match predicate
 * rather than a case-insensitive one: these two numbers only mean anything if
 * they are counted the same way the scan counts, and a lower()-matched total
 * beside an exact-matched scan would hide precisely the casing mismatch an
 * operator is here to find.
 */
async function readGithubRowCounts(
  db: Db,
  enterpriseSlug: string,
  windowDays: number,
): Promise<{ rowsForProvider: number; rowsForEnterprise: number }> {
  const rows = await db.execute<{ provider_rows: string; enterprise_rows: string }>(sql`
    SELECT count(*)::text AS provider_rows,
           count(*) FILTER (WHERE r.enterprise_ref = ${enterpriseSlug})::text AS enterprise_rows
      FROM reconciliation_record r
     WHERE r.provider = 'github'
       AND r.period_date >= (CURRENT_DATE - make_interval(days => ${windowDays}))
  `)
  return {
    rowsForProvider: Number(rows[0]?.provider_rows ?? 0),
    rowsForEnterprise: Number(rows[0]?.enterprise_rows ?? 0),
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface RunWireShapeOptions {
  mode: 'live' | 'stored' | 'both'
  day: string
  storedWindowDays: number
  storedRowLimit: number
}

export async function runWireShapeProbe(runDb: DbRunner, opts: RunWireShapeOptions): Promise<WireShapeReport> {
  const live = opts.mode === 'stored' ? [] : await runLiveProbes(runDb, { day: opts.day })
  const stored =
    opts.mode === 'live'
      ? []
      : await runStoredScans(runDb, { windowDays: opts.storedWindowDays, rowLimit: opts.storedRowLimit })
  return {
    generatedAt: new Date().toISOString(),
    day: opts.day,
    mode: opts.mode,
    note: REPORT_NOTE,
    live,
    stored,
  }
}
