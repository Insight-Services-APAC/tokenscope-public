/*
 * Azure Monitor reader worker — the read joiner.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 6: "Read joiner — joins
 * instance_attestation.session_id against emitted spans, writes
 * attribution_record". Per ADR-0002 cost is derived from a rate_card
 * at write time; rate_card_id + version pinned on each row (COST-7).
 *
 * Idempotency: skip writes when an attribution_record already exists
 * for the (session_id, ts_event, token_type, model) tuple.
 *
 * Defaults to a 24-hour scan window (R1 sweep F2 — production-scale DB
 * would otherwise scan the full instance_attestation table per tick).
 * Override via opts.sinceMs or opts.sessionIds.
 *
 * Cost computation: per data-model.md `cost = tokens / unit_qty *
 * unit_cost_usd` from the matching rate_line. Skips the span if no
 * matching rate_card / rate_line — pilot data quality > silently-zero
 * rows (R1 sweep F1 + F3).
 *
 * Pure function; BullMQ scheduling at Epic 10.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import * as schemaImport from '../../drizzle/schema'
import type { TelemetryReader, UsageRecord } from '../azure/reader'
import { recordAuditEvent } from '../db/audit'
import { loadLifecyclePolicyResolver } from '../db/project-lifecycle-policy'
import { notifyProjectEndedRetag } from '../notifications/project-lifecycle'

export interface JoinResult {
  sessionsProcessed: number
  attributionRowsWritten: number
  spansSkippedNoRateCard: number
  // Membership gate (client-attribution-auth-spec §2): a project tag from a
  // teammate who is NOT assigned to that project is rejected — the project
  // attribution is withheld (it surfaces as untagged spend at reconciliation)
  // and the rejection is audited. "Tag proposes, membership disposes."
  spansSpilledUnauthorized: number
  // Project-lifecycle spill (D2): events whose ts_event is past the project's
  // end_date + grace are written UNALLOCATED (project/cou nulled, activity kept)
  // — the re-tag signal. Per-event, so a boundary-spanning conversation splits.
  spansSpilledEnded: number
  // Per-session fault isolation (ING-6): sessions whose read/join threw. One bad
  // session (reader HTTP error, malformed value, FK violation) must not abort
  // the whole tick and starve every remaining instance — the documented "silent
  // attribution stop" outage class. Errored sessions retry next tick.
  errors: number
  // Whether this run ignored the per-instance watermark and re-read the full
  // window (ING-1 daily deep-rescan). Persisted via worker_run.result so
  // shouldDeepRescan can find the last deep pass.
  deepRescan: boolean
  // Behavioural usage-signal lane (mig 0065, Copilot tool/MCP/context/turn). The
  // signal read+land runs in its OWN per-session try/catch AFTER token attribution,
  // so a signal-path fault never disturbs billing — it surfaces here, not in `errors`.
  signalRowsWritten: number
  signalErrors: number
}

export interface JoinOptions {
  sessionIds?: string[]
  sinceMs?: number
  now?: Date
  /*
   * ING-1: ignore the per-instance high-water-mark and re-read each instance's
   * FULL reader window. The watermark cursors on EVENT time with a 5-minute
   * lookback, but OTLP batching/retry, laptop suspends, and Azure ingestion
   * latency routinely deliver events later than that — anything older than
   * (watermark − 5min) at read time was permanently dropped. A periodic
   * deep-rescan re-reads the window; onConflictDoNothing makes it free.
   */
  deepRescan?: boolean
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

// ING-1: how often the scheduled tick swaps the watermark for a full-window
// deep-rescan (recovers telemetry that arrived later than the 5-min lookback).
const DEEP_RESCAN_INTERVAL_HOURS = 24

/*
 * Decide whether the next scheduled joiner tick should deep-rescan (ING-1):
 * true when NO successful azure-monitor-read run in the last `intervalHours`
 * carried result.deepRescan=true. State lives in the existing worker_run
 * bookkeeping (run-health persists the result object verbatim) — no schema
 * change, and a crashed deep pass is retried on the very next tick.
 */
export async function shouldDeepRescan(
  db: PostgresJsDatabase<typeof schema>,
  opts: { intervalHours?: number } = {},
): Promise<boolean> {
  const intervalHours = opts.intervalHours ?? DEEP_RESCAN_INTERVAL_HOURS
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM worker_run
    WHERE worker_name = 'azure-monitor-read'
      AND status = 'success'
      AND (result->>'deepRescan') = 'true'
      AND started_at > NOW() - (${intervalHours} * INTERVAL '1 hour')
    LIMIT 1
  `)
  return rows.length === 0
}

/*
 * Fail-soft audit on the joiner hot path (ING-6): recordAuditEvent throws on
 * insert failure, which would abort the whole tick over an observability write.
 * Attribution is the product promise; the audit trail must never starve it.
 */
async function auditFailSoft(
  db: PostgresJsDatabase<typeof schema>,
  input: Parameters<typeof recordAuditEvent>[1],
): Promise<void> {
  try {
    await recordAuditEvent(db, input)
  } catch (err) {
    console.warn(`[azure-monitor-read] audit write failed (${input.eventType}); continuing: ${String(err)}`)
  }
}

// ── Copilot AI-credit pricing constant ────────────────────────────────────────
// 1 GitHub AI credit = $0.01 USD (one cent) — GitHub usage-based billing, 2026-06-01.
// GUARD THE 100× TRAP: this is $0.01 (one cent), NOT 0.01¢ (one hundredth of a cent).
// Source: official GitHub models-and-pricing docs; every plan ratio is $0.01/credit
// (Pro 1000cr/$10, Pro+ 3900/$39, Business 1900/$19, Enterprise 3900/$39);
// overage $0.01/cr. Cross-check: nano_aiu=9111525000 ⇒ 9.11 credits ⇒ $0.0911
// ≈ same call priced at Sonnet 4.6 token rates. This is INDICATIVE (no billing-API
// reconciliation in v1 — deferred to F2). Do NOT use a token rate_line for Copilot.
const COPILOT_AI_CREDIT_USD = 0.01 // $0.01 per AI credit — VERIFIED 2026-06-01

/**
 * Compute Copilot cost from nano_aiu: cost_usd = nano_aiu × 1e-11.
 * Equivalent to: (nano_aiu / 1e9) × COPILOT_AI_CREDIT_USD.
 * Only valid for tool='copilot-cli'; token rate cards are NOT used for Copilot.
 * Returns a 6-decimal string (matches computeCost format), or null if nano_aiu missing.
 */
function computeCopilotCost(nanoAiu: number | undefined): string | null {
  if (nanoAiu == null || !Number.isFinite(nanoAiu) || nanoAiu <= 0) return null
  // cost_usd = (nano_aiu / 1e9) * $0.01 = nano_aiu * 1e-11
  const cost = (nanoAiu / 1e9) * COPILOT_AI_CREDIT_USD
  // L10 fix: nano_aiu values 1–99 produce costs < 1e-9, which round to "0.000000"
  // at 6dp. Compare against the toFixed(6) rounding threshold (0.0000005) rather
  // than exact zero — IEEE 754 never represents nano_aiu*1e-11 as exactly 0.0.
  // Real Copilot spans have nano_aiu in the billions; pathological tiny values
  // are skipped cleanly rather than attributed as zero cost.
  if (cost < 0.0000005) return null
  return cost.toFixed(6)
}

/*
 * ING-5: fixed Copilot cost-carrier order. The carrier for a span is the
 * present token_type EARLIEST in this list (with unknown types last, ordered
 * after the known ones) — deterministic regardless of KQL row order.
 */
const TOKEN_TYPE_PRIORITY = ['input', 'output', 'cache-read', 'cache-write'] as const

function tokenTypePriority(tokenType: string): number {
  const i = TOKEN_TYPE_PRIORITY.indexOf(tokenType as (typeof TOKEN_TYPE_PRIORITY)[number])
  return i === -1 ? TOKEN_TYPE_PRIORITY.length : i
}

/**
 * Convert nano_aiu to the native AI-credit quantity: credit_qty = nano_aiu / 1e9.
 * This is the reconciliation operand the credit lane sums (engine ai-credits path),
 * verified 2026-06-08: GitHub billing `ai_credit/usage` reports `unitType:'ai-credits'`
 * at `pricePerUnit:$0.01`, matching nano_aiu/1e9 priced by COPILOT_AI_CREDIT_USD.
 * Persisted ONCE per span (alongside cost_usd) so summing credit_qty across the
 * four token_type rows of a span does not multiply the credits. Returns a 6-decimal
 * string, or null when nano_aiu is absent/non-positive (mirrors computeCopilotCost).
 */
function computeCopilotCreditQty(nanoAiu: number | undefined): string | null {
  if (nanoAiu == null || !Number.isFinite(nanoAiu) || nanoAiu <= 0) return null
  const credits = nanoAiu / 1e9
  if (credits < 0.0000005) return null
  return credits.toFixed(6)
}

interface SessionRow extends Record<string, unknown> {
  instance_id: string
  teammate_id: string
  region_id: string
  org_unit_id: string
  cost_owning_unit_id: string
  project_code_hash: string
  tool: string
  // Identity provenance (mig 0057): the emitting instance's identity_state,
  // stamped onto every attribution_record this session writes. NOT NULL with a
  // 'confirmed' default on the attestation row, so it is always present.
  identity_state: string
}

interface RateLine extends Record<string, unknown> {
  unit: string
  unit_qty: string
  unit_cost_usd: string
  model: string | null
}
interface RateCardWithLines {
  id: string
  version: number
  lines: RateLine[]
}

/*
 * Scheduler pre-query (registry 'azure-monitor-read' tick): instance_attestation
 * rows that still need a (re)join. A session is joinable when it is EITHER:
 *
 *   - ACTIVE (ts_actual_end IS NULL), with ts_start within `activeMaxAgeHours`
 *     — re-scanned EVERY tick regardless of age so spend on a long-lived
 *     session (Claude sessions can run for days/weeks) keeps attributing in
 *     near-real-time, including a session tagged retroactively mid-flight via
 *     the untagged-spend UI: once an attestation exists, ongoing spend on the
 *     still-open session keeps flowing to that budget. runReadJoiner is
 *     idempotent-additive (keyed on session_id + ts_event + token_type +
 *     model), so re-scanning only adds events that landed since the last tick.
 *     The age cap is a backstop against sessions that died without an /end
 *     call; session-gc closes inactive ones (sets ts_actual_end) well inside
 *     it; OR
 *
 *   - RECENTLY CLOSED (ts_actual_end within `windowHours`) — keep re-scanning for
 *     trailing emit so a close (session-gc / /end) does NOT instantly freeze an
 *     instance that is still emitting. This is defense-in-depth for the 2026-06-06
 *     outage: a 12h-TTL gc-close froze a live instance's attribution because a
 *     closed+already-attributed instance matched none of the clauses; OR
 *
 *   - ended/unknown but UNATTRIBUTED, with ts_start within `windowHours` — a
 *     one-shot catch-up join (e.g. a session that ended between ticks).
 *
 * A long-closed session with attribution and no recent emit naturally ages out of
 * all clauses. Purged sessions are excluded, matching runReadJoiner's window query.
 *
 * NOTE (perf): active sessions are re-SELECTED each tick (which instances to
 * scan), but runReadJoiner now bounds the per-instance READ with a per-instance
 * high-water-mark (MAX already-attributed ts_event), so the reader only pulls
 * events newer than the last-attributed one — bounded by new emission, not the
 * instance's lifetime history. This narrows the READ only; WHICH instances are
 * scanned (incl. the E2 revocation exclusions) is unchanged.
 *
 * Extracted + exported so the column/window/active contract is regression-tested
 * — the registry wrapper has no DI seam, so a stale column here fails SILENTLY
 * on every scheduled tick (exactly how `sa.created_at` slipped past the suite,
 * which only ever calls runReadJoiner directly with explicit sessionIds).
 */
export async function selectRecentJoinableSessionIds(
  db: PostgresJsDatabase<typeof schema>,
  opts: { windowHours?: number; activeMaxAgeHours?: number; limit?: number } = {},
): Promise<string[]> {
  const windowHours = opts.windowHours ?? 24
  const activeMaxAgeHours = opts.activeMaxAgeHours ?? 24 * 30 // 30d — covers days/weeks; gc closes dead ones sooner
  // Positive-integer guard: NaN/0/empty/garbage AND negatives all fall back to 500.
  // A negative LIMIT throws in Postgres → would fail the whole tick (silent
  // attribution stop, the outage class), so a fat-fingered env var must not reach it.
  const envCap = Number(process.env.NUXT_JOINER_INSTANCE_CAP)
  const limit = opts.limit ?? (Number.isInteger(envCap) && envCap > 0 ? envCap : 500)
  const rows = await db.execute<{ id: string }>(sql`
    SELECT sa.instance_id::text AS id
    FROM instance_attestation sa
    WHERE sa.ts_purged IS NULL
      AND sa.attestation_state IN ('attested', 'unassigned')  -- B′ (ADR-0004): device-enrol rows are 'unassigned' (project NULL); project comes from the emitted attr, not the row
      -- E2 (ADR-0005): never attribute records from an instance whose teammate was
      -- revoked AFTER enrolment (offboarding / force-revoke). Mirrors /bearer.
      AND NOT EXISTS (
        SELECT 1 FROM teammate t
         WHERE t.id = sa.teammate_id AND t.revoked_at IS NOT NULL AND t.revoked_at > sa.ts_start
      )
      AND (
        -- ACTIVE (open) within the active-age cap: re-scanned every tick.
        (sa.ts_actual_end IS NULL
         AND sa.ts_start >= NOW() - (${activeMaxAgeHours} * INTERVAL '1 hour'))
        -- RECENTLY CLOSED within the window: keep re-scanning for trailing emit so a
        -- close (session-gc / /end) does NOT instantly freeze a still-emitting
        -- instance (defense-in-depth for the 2026-06-06 outage). The per-instance
        -- watermark bounds the read to events newer than the last attributed one.
        OR (sa.ts_actual_end >= NOW() - (${windowHours} * INTERVAL '1 hour'))
        -- ended/unknown but NEVER attributed, start within window: one-shot catch-up.
        OR (sa.ts_start >= NOW() - (${windowHours} * INTERVAL '1 hour')
            AND NOT EXISTS (
              SELECT 1 FROM attribution_record ar
               WHERE ar.instance_id = sa.instance_id
            ))
      )
    -- R1 HIGH: a burst of recently-closed instances must never evict live/active
    -- instances under the 500-row cap. Order active (ts_actual_end IS NULL) first,
    -- then most-recently-started, so the LIMIT sheds the oldest closed rows — not a
    -- still-emitting active session whose spend would then silently stop attributing.
    ORDER BY (sa.ts_actual_end IS NULL) DESC, sa.ts_start DESC
    LIMIT ${limit}
  `)
  // Observability (R2 L1): hitting the cap means some joinable instances are NOT
  // scanned this tick. The ORDER BY sheds closed-first, but >limit ACTIVE instances
  // would still drop live ones → silent attribution stop (the outage class). Surface
  // it so the cap is visible before it bites; raise NUXT_JOINER_INSTANCE_CAP / page.
  if (rows.length === limit) {
    console.warn(
      `[azure-monitor-read] joinable-instance cap hit (${limit}); some instances skipped this tick. Raise NUXT_JOINER_INSTANCE_CAP or page the query.`,
    )
  }
  return [...rows].map((r) => r.id)
}

export async function runReadJoiner(
  db: PostgresJsDatabase<typeof schema>,
  reader: TelemetryReader,
  opts: JoinOptions = {},
): Promise<JoinResult> {
  const now = opts.now ?? new Date()
  const sinceMs = opts.sinceMs ?? DEFAULT_WINDOW_MS
  const since = new Date(now.getTime() - sinceMs).toISOString()
  const explicitSessions = opts.sessionIds

  const sessions = await db.execute<SessionRow>(
    explicitSessions
      ? sql`
          SELECT instance_id::text AS instance_id,
                 teammate_id::text AS teammate_id,
                 region_id::text   AS region_id,
                 org_unit_id::text AS org_unit_id,
                 cost_owning_unit_id::text AS cost_owning_unit_id,
                 project_code_hash, tool, identity_state
          FROM instance_attestation
          WHERE attestation_state IN ('attested', 'unassigned')  -- B′: device-enrol rows are 'unassigned'; project from the emitted attr
            AND NOT EXISTS (  -- E2 (ADR-0005): skip revoked-teammate instances
              SELECT 1 FROM teammate t
               WHERE t.id = instance_attestation.teammate_id
                 AND t.revoked_at IS NOT NULL AND t.revoked_at > instance_attestation.ts_start
            )
            AND instance_id IN (${sql.join(
              explicitSessions.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
        `
      : sql`
          SELECT instance_id::text AS instance_id,
                 teammate_id::text AS teammate_id,
                 region_id::text   AS region_id,
                 org_unit_id::text AS org_unit_id,
                 cost_owning_unit_id::text AS cost_owning_unit_id,
                 project_code_hash, tool, identity_state
          FROM instance_attestation
          WHERE ts_purged IS NULL
            AND attestation_state IN ('attested', 'unassigned')  -- B′: include unassigned device-enrol rows
            AND NOT EXISTS (  -- E2 (ADR-0005): skip revoked-teammate instances
              SELECT 1 FROM teammate t
               WHERE t.id = instance_attestation.teammate_id
                 AND t.revoked_at IS NOT NULL AND t.revoked_at > instance_attestation.ts_start
            )
            AND (ts_actual_end >= ${since}::timestamptz OR (ts_actual_end IS NULL AND ts_start >= ${since}::timestamptz))
        `,
  )

  // ── Per-instance high-water-mark (scalability fix) ──────────────────────
  // For each instance about to be processed, the watermark is the MAX(ts_event)
  // of ALREADY-WRITTEN attribution_record rows — the last event we've attributed.
  // The reader then pulls only events newer than (watermark - lookback), so the
  // per-tick read is bounded by new emission, not the instance's lifetime history
  // (this is the fix for the O(active-instances × lifetime-records) full-rescan
  // that caused live 504s once an instance reached ~4,300 records).
  //
  // CORRECTNESS: the watermark is MAX over already-WRITTEN rows, so no
  // un-attributed record is ever skipped — the lookback re-reads the boundary and
  // onConflictDoNothing dedups the overlap. An instance with NO attribution yet
  // has no watermark → undefined → the reader does a full-window read (unchanged).
  // Batched into ONE query (instance_id → max_ts_event) to avoid N round-trips.
  // A deep-rescan tick (ING-1) skips the watermarks entirely → every instance
  // gets a full-window read; the dedup index absorbs the re-reads.
  const watermarks = new Map<string, Date>()
  if (sessions.length > 0 && !opts.deepRescan) {
    const wmRows = await db.execute<{ instance_id: string; max_ts: string | null }>(sql`
      SELECT instance_id::text AS instance_id, MAX(ts_event)::text AS max_ts
      FROM attribution_record
      WHERE instance_id IN (${sql.join(
        [...new Set(sessions.map((s) => s.instance_id))].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY instance_id
    `)
    for (const r of wmRows) {
      if (r.max_ts) watermarks.set(r.instance_id, new Date(r.max_ts))
    }
  }

  // Behavioural usage-signal lane watermark (mig 0065) — its OWN high-water-mark
  // over usage_signal_record, independent of the token watermark (an invoke_agent
  // turn emits signals but no token row, so the two lanes' frontiers can diverge).
  // Same batched MAX(ts_event) shape; deep-rescan skips it for a full re-read.
  const signalWatermarks = new Map<string, Date>()
  if (sessions.length > 0 && !opts.deepRescan && typeof reader.getSignalUsage === 'function') {
    const swRows = await db.execute<{ instance_id: string; max_ts: string | null }>(sql`
      SELECT instance_id::text AS instance_id, MAX(ts_event)::text AS max_ts
      FROM usage_signal_record
      WHERE instance_id IN (${sql.join(
        [...new Set(sessions.map((s) => s.instance_id))].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY instance_id
    `)
    for (const r of swRows) {
      if (r.max_ts) signalWatermarks.set(r.instance_id, new Date(r.max_ts))
    }
  }
  let signalRowsWritten = 0
  let signalErrors = 0

  // Per-run rate-card cache, keyed `${tool}|${region_id}|${UTC-day-of-event}`
  // (mig 0050: selection is scope-aware AND temporal, so the resolved card
  // varies by region and by event timestamp). Day granularity keeps DB hits at
  // ~1 per (tool, region, day) per run instead of 1 per record — the joiner
  // prices bursts of same-day events per instance. Caveat: a card whose
  // effective boundary falls MID-day buckets that day's events with whichever
  // card the day's first-resolved event matched; the admin flow writes
  // day-aligned ranges, so this stays theoretical.
  const rateCardCache = new Map<string, RateCardWithLines | null>()
  // Snapshot the (small) project-lifecycle policy table ONCE per tick → a pure
  // (regionId) => {graceHours, warnDays} resolver. Zero per-event/per-group
  // queries on the hot path (D9). grace is resolved by the PROJECT's region.
  const lifecyclePolicyFor = await loadLifecyclePolicyResolver(db)
  let written = 0
  let skippedNoCard = 0
  let spilledUnauthorized = 0
  let spilledEnded = 0
  let errors = 0

  // ING-6: per-session fault isolation — invoked per session under try/catch
  // below (the reconciliation-sync per-scope pattern) so one bad session cannot
  // starve every remaining instance this tick.
  const processSession = async (session: SessionRow): Promise<void> => {
    // High-water-mark: pull only events newer than the last-attributed one
    // (minus the reader's lookback). undefined for a first-ever scan → full window.
    const usage = await reader.getSessionUsage(session.instance_id, watermarks.get(session.instance_id))
    if (usage.length === 0) return

    // ── ADR-0004 "B′": project from the EMITTED telemetry, not the row ──
    // Teammate (who) still comes from the unspoofable attestation row (by
    // session_id). Project (which) resolution ORDER, per record (§13):
    //   1. emitted project.code_hash (B′) — the per-event .tokenscope claim;
    //   2. ELSE a per-conversation assignment (session_assignment, keyed on
    //      the record's claude_session_id + this teammate) — the retroactive
    //      "assign this untagged conversation" mapping the assign endpoint writes;
    //   3. ELSE untagged (skip).
    // One DEVICE_SID is shared across a user's repos AND conversations, so
    // records under it may resolve to DIFFERENT project hashes; attribution is
    // decided PER project group, each membership-gated. The attestation row's own
    // project_code_hash is the DEVICE's (usually NULL) and is not used here.
    //
    // The session_assignment fallback is resolved to a project CODE HASH
    // (not directly to a project id) so both lanes converge on the same
    // membership-gated grouping below — keeping the gate the single decision
    // point and avoiding a second attribution path that could skip it.
    const convProjectHashCache = new Map<string, string | null>()
    // Orthogonal activity axis (mig 0020): the per-conversation activity label,
    // resolved from session_assignment by (claude_session_id, teammate) and
    // denormalised onto each attribution_record. Independent of the project
    // resolution — a B′-attributed record can still carry an activity.
    const convActivityCache = new Map<string, string | null>()
    // Untagged records group under this sentinel (instead of being skipped) so
    // they're itemised into the ledger as project-less (unallocated) rows.
    const UNTAGGED_KEY = '__untagged__'
    const groups = new Map<string, UsageRecord[]>()
    for (const rec of usage) {
      let codeHash = rec.projectCodeHash ?? null
      if (!codeHash && rec.claudeSessionId) {
        // Fallback: an explicit per-conversation assignment for THIS teammate.
        let resolved = convProjectHashCache.get(rec.claudeSessionId)
        if (resolved === undefined) {
          const [ca] = await db.execute<{ code_hash: string }>(sql`
            SELECT p.code_hash AS code_hash
            FROM session_assignment ca
            JOIN project p ON p.id = ca.project_id
            WHERE ca.claude_session_id = ${rec.claudeSessionId}
              AND ca.teammate_id = ${session.teammate_id}::uuid
            LIMIT 1
          `)
          resolved = ca?.code_hash ?? null
          convProjectHashCache.set(rec.claudeSessionId, resolved)
        }
        codeHash = resolved
      }
      // No skip: untagged records group under the sentinel so they're itemised
      // as project-less (unallocated) rows. attribution_record is the single ledger.
      const key = codeHash ?? UNTAGGED_KEY
      const list = groups.get(key) ?? []
      list.push(rec)
      groups.set(key, list)
    }

    for (const [key, groupUsage] of groups) {
      // Resolve the project (NULLABLE). Untagged, unknown-project, and non-member
      // spill all resolve to NULL = unallocated — but are STILL written to the
      // ledger (itemised), not dropped. cost_owning_unit follows the project.
      let projectId: string | null = null
      let cou: string | null = null
      // Per-group spill boundary in epoch-ms: events with ts_event strictly past
      // (end_date + grace) spill to unallocated. null = no end / not applicable.
      let spillAfterMs: number | null = null
      // ING-8: unknown-project / unauthorized-spill audits and counters are
      // DEFERRED until after the insert loop and gated on newly-written rows —
      // same gate as the ended-spill path. The lookback overlap re-reads these
      // groups every tick; un-gated, the append-only audit re-fired (~12 dup
      // rows/hour per active unauthorized tagger) even when every insert
      // deduped to zero.
      let unknownProject = false
      let unauthorizedProjectId: string | null = null
      if (key !== UNTAGGED_KEY) {
        const [proj] = await db.execute<{
          id: string
          cost_owning_unit_id: string
          region_id: string
          // end_date as epoch MILLISECONDS straight from Postgres — never parse
          // a timestamptz::text in JS (the space-separated form isn't in the
          // ECMAScript parse grammar; a NaN would fail-OPEN and mis-bill the
          // dead project). NULL when the project has no end_date.
          end_ms: string | null
        }>(
          sql`SELECT id::text AS id, cost_owning_unit_id::text AS cost_owning_unit_id,
                     region_id::text AS region_id,
                     (EXTRACT(EPOCH FROM end_date) * 1000)::bigint::text AS end_ms
              FROM project WHERE code_hash = ${key} LIMIT 1`,
        )
        if (!proj) {
          // Hash matches no registered project → leave UNALLOCATED + audit (after
          // the inserts, gated on new rows) so ops can spot an unregistered
          // .tokenscope without the audit re-firing on every overlap re-read.
          unknownProject = true
        } else {
          // ── Membership gate (spec §2) ── tag proposes, membership disposes.
          // A non-member's claim is NOT billed to the project; it's itemised as
          // unallocated (spill) and audited loudly. Don't silently bill an
          // unauthorized tag.
          const member = await db.execute<{ ok: number }>(
            sql`
              SELECT 1 AS ok FROM project_assignment
              WHERE project_id = ${proj.id}::uuid
                AND teammate_id = ${session.teammate_id}::uuid
                AND effective @> now()
              LIMIT 1
            `,
          )
          if (member.length === 0) {
            // Counter + audit deferred until after the inserts (ING-8 gate).
            unauthorizedProjectId = proj.id
            // projectId stays null → unallocated
          } else {
            projectId = proj.id
            cou = proj.cost_owning_unit_id
            // Project-lifecycle spill (D2). If the project has ended, events past
            // end_date + grace spill to unallocated. Resolve grace by the
            // PROJECT's region (region admins override their region). Decided
            // per-event below so a boundary-spanning conversation splits cleanly.
            if (proj.end_ms !== null) {
              const grace = lifecyclePolicyFor(proj.region_id).graceHours
              spillAfterMs = Number(proj.end_ms) + grace * 3_600_000
            }
          }
        }
      }

      // ── Org lane (spec §2.1) ───────────────────────────────────────
      // The Claude-stamped organization.id picks the reconciliation lane via the
      // provider_org registry: reconciled → tier-1/estimated (API is the ceiling);
      // indicative or unknown → tier-2/telemetry-only (excluded from reconciliation).
      // Unknown orgs are attributed best-effort AND flagged for classification.
      //
      // Copilot-specific: Copilot v1 spend is ALWAYS tier-2/telemetry-only
      // (no billing-API reconciliation in v1 — deferred to F2). The GitHub billing
      // reconciliation worker (F2) will promote Copilot rows to tier-1 when it lands.
      const isCopilot = session.tool === 'copilot-cli'
      const orgId = groupUsage.find((u) => u.organizationId)?.organizationId
      let fidelityTier = isCopilot ? 'tier-2' : 'tier-1'
      let costBasis = isCopilot ? 'telemetry-only' : 'estimated'
      if (!isCopilot && orgId) {
        const [orgRow] = await db.execute<{ mode: string }>(
          sql`SELECT reconciliation_mode AS mode FROM provider_org
              WHERE provider = 'anthropic' AND lower(external_org_id) = lower(${orgId}) LIMIT 1`,
        )
        if (!orgRow) {
          fidelityTier = 'tier-2'
          costBasis = 'telemetry-only'
          await auditFailSoft(db, {
            eventType: 'attribution-org-unclassified',
            actorTeammateId: session.teammate_id,
            actorSystem: 'read-joiner',
            subjectKind: 'session',
            subjectId: session.instance_id,
            payload: { organization_id: orgId, note: 'add this org to the provider_org registry' },
          })
        } else if (orgRow.mode === 'indicative') {
          fidelityTier = 'tier-2'
          costBasis = 'telemetry-only'
        }
      }

      // Copilot cost path: use AI-credit constant (NOT token rate cards).
      // Token rate cards (rate_line) are for Claude only. Copilot rows carry
      // nano_aiu; cost = nano_aiu × 1e-11 (i.e. credits × $0.01).
      // Copilot rows carry a null card (the INSERT uses rateCardId=null).
      // For Claude, the card is resolved PER EVENT inside the loop below
      // (mig 0050: selection is scope-aware + temporal, so it depends on the
      // event timestamp and the teammate's region), via the per-run
      // (tool, region, day) cache.

      // Per-group tally of ended-spill events, for one summary audit below.
      // Count only NEWLY-WRITTEN spilled rows. The reader re-reads a 5-minute
      // overlap each tick (WATERMARK_LOOKBACK_MS) so onConflictDoNothing can
      // dedup the boundary — which means a boundary-spanning spill is re-seen
      // every tick. Tallying ALL spilled events would re-inflate the counter
      // and re-emit the append-only audit on every tick. Gate on `ins.length`.
      // The unknown-project / unauthorized paths use the same gate (ING-8).
      //
      // ING-5: the Copilot cost carrier is DETERMINISTIC — for each span, the
      // present token_type earliest in TOKEN_TYPE_PRIORITY carries the cost.
      // "First surviving record" was arrival-order dependent (the KQL has no
      // ORDER BY): a tick crashing mid-span, or a concurrent run, let the next
      // pass pick a DIFFERENT carrier → a second full-cost row that conflicts
      // with nothing. The carrier additionally checks the DB for an existing
      // >0-cost row per span before carrying cost again.
      const copilotPricedSpans = new Set<string>()
      const spanCarrier = new Map<string, string>()
      if (isCopilot) {
        for (const rec of groupUsage) {
          const spanKey = `${rec.tsEvent}:${rec.sourceRunId ?? ''}`
          const current = spanCarrier.get(spanKey)
          if (
            current === undefined ||
            tokenTypePriority(rec.tokenType) < tokenTypePriority(current)
          ) {
            spanCarrier.set(spanKey, rec.tokenType)
          }
        }
      }
      let groupEndedSpillNew = 0
      let groupNewRows = 0
      for (const rec of groupUsage) {
        // Copilot: cost from AI credits (nano_aiu), NOT token rate card.
        // Claude: cost from token rate card (unchanged).
        let costUsd: string | null
        // Copilot reconciliation operand (native AI credits). Persisted ONCE per
        // span on the same surviving row as cost_usd; '0' on subsequent token_type
        // rows; null for Claude (token lane). See computeCopilotCreditQty.
        let creditQty: string | null = null
        // Claude only: the rate card this event prices against (pinned on the
        // row, COST-7). Stays null for Copilot (AI-credit constant, no card).
        let card: RateCardWithLines | null = null
        if (isCopilot) {
          // Cost = nano_aiu × 1e-11 (= credits × $0.01).
          // nano_aiu is the same value on all token_type rows for a given span.
          // To avoid 4× counting, price it once per span (keyed by tsEvent+sourceRunId)
          // on the DETERMINISTIC carrier token_type (ING-5) — fixed priority with
          // fallback, not specifically 'input', because if input_tokens==0 the
          // reader drops the input row and the cost would be lost.
          const spanKey = `${rec.tsEvent}:${rec.sourceRunId ?? ''}`
          if (spanCarrier.get(spanKey) === rec.tokenType && !copilotPricedSpans.has(spanKey)) {
            costUsd = computeCopilotCost(rec.nanoAiu)
            if (costUsd === null) {
              // nano_aiu absent — skip this record (under-report is safer than over).
              skippedNoCard += 1
              continue
            }
            // ING-5: a prior partial tick (or the pre-deterministic code) may
            // already hold this span's cost on a DIFFERENT token_type row —
            // never write a second full-cost row for the same span.
            const [priced] = await db.execute<{ ok: number }>(sql`
              SELECT 1 AS ok FROM attribution_record
              WHERE instance_id = ${session.instance_id}::uuid
                AND ts_event = ${rec.tsEvent}::timestamptz
                AND COALESCE(source_run_id, '') = ${rec.sourceRunId ?? ''}
                AND cost_usd > 0
              LIMIT 1
            `)
            if (priced) {
              costUsd = '0.000000'
              creditQty = '0.000000'
            } else {
              // credit_qty is the SAME nano_aiu, so it survives iff cost did.
              creditQty = computeCopilotCreditQty(rec.nanoAiu)
            }
            copilotPricedSpans.add(spanKey)
          } else {
            // Non-carrier token_type rows for the same span: tokens recorded for
            // reporting only, cost (and credits) attributed on the carrier row.
            costUsd = '0.000000'
            creditQty = '0.000000'
          }
        } else {
          // Claude: token rate card, resolved PER EVENT (COST-4/COST-6, mig
          // 0050) — scope-aware (region tier > global) and temporal (only a
          // card whose effective range contains ts_event prices it). Cached
          // per (tool, region, UTC-day-of-event) for the run so per-event DB
          // hits don't explode (see rateCardCache above).
          //
          // INVARIANT (regression-pinned in joiner-rate-card-scope.test.ts):
          // with only the seeded card (mig 0004 — global, region_id NULL,
          // effective [2026-01-01, 2099-01-01)) every existing event resolves
          // to it exactly as before this change.
          const eventDay = new Date(rec.tsEvent).toISOString().slice(0, 10)
          const cardKey = `${session.tool}|${session.region_id ?? ''}|${eventDay}`
          let resolved = rateCardCache.get(cardKey)
          if (resolved === undefined) {
            resolved = await resolveRateCard(db, session.tool, rec.tsEvent, session.region_id ?? null)
            rateCardCache.set(cardKey, resolved)
          }
          card = resolved
          if (!card) {
            skippedNoCard += 1
            continue
          }
          costUsd = computeCost(card, rec.tokenType, rec.model, rec.tokens)
          if (costUsd === null) {
            skippedNoCard += 1
            continue
          }
        }

        // Project-lifecycle spill (D2), PER EVENT. A post-end event is written
        // UNALLOCATED — project_id/cou nulled — so it lands in the dev's
        // needs-tagging / tagged-spill lane as the re-tag signal (D2a). Activity
        // is PRESERVED (tagged spills stay categorised). Pre-end events in the
        // SAME conversation keep their attribution → the conversation splits.
        // Deterministic on the frozen ts_event, so active-session re-scans are stable.
        let recProjectId = projectId
        let recCou = cou
        const spilled = spillAfterMs !== null && new Date(rec.tsEvent).getTime() > spillAfterMs
        if (spilled) {
          recProjectId = null
          recCou = null
        }

        // Backfill provenance (ADR-0005 slice 3): a record re-emitted by
        // /tokenscope:backfill carries the tokenscope.backfill=true resource
        // attr. It is a CAPPED, NON-RECONCILED provenance class — dedup makes it
        // idempotent but does NOT make it tier-1 truth. Mark it advisory so it's
        // visibly distinguishable AND excluded from reconciliation (telemetry-only
        // already drops out of the reconciliation CTE, which compares against the
        // authoritative Anthropic actual). metadata.backfill is the explicit,
        // queryable provenance flag on top of the tier/basis.
        const recFidelityTier = rec.backfill ? 'tier-2' : fidelityTier
        const recCostBasis = rec.backfill ? 'telemetry-only' : costBasis
        // metadata keys MERGE (mig 0045): law_cost_usd (Claude's own per-event
        // cost, duplicated per token-type row by the KQL mv-expand; v_cost_drift
        // aggregates it MAX per span) coexists with the backfill flag.
        const metaObj: Record<string, unknown> = {}
        if (rec.backfill) metaObj.backfill = true
        if (rec.lawCostUsd !== undefined) metaObj.law_cost_usd = rec.lawCostUsd
        const recMetadata = Object.keys(metaObj).length > 0 ? metaObj : null

        // Activity (mig 0020): denormalise the conversation's activity label from
        // session_assignment, if the teammate tagged one. Independent of project.
        // This stamps NEW rows only (onConflictDoNothing skips existing); the
        // assign endpoint backfills already-attributed rows, so both converge.
        // assign is the sole activity write path in MVP — keep it that way.
        let activity: string | null = null
        if (rec.claudeSessionId) {
          let a = convActivityCache.get(rec.claudeSessionId)
          if (a === undefined) {
            const [row] = await db.execute<{ activity: string | null }>(sql`
              SELECT activity FROM session_assignment
              WHERE claude_session_id = ${rec.claudeSessionId}
                AND teammate_id = ${session.teammate_id}::uuid
              LIMIT 1
            `)
            a = row?.activity ?? null
            convActivityCache.set(rec.claudeSessionId, a)
          }
          activity = a
        }

        // R1 #5: atomic idempotency. The old SELECT-then-INSERT was non-atomic —
        // two concurrent joins (a scheduled tick + an inline assign-join, or a
        // replayed trigger) on the same session both saw "not present" and both
        // inserted, double-counting spend. ON CONFLICT DO NOTHING on the
        // (instance_id, COALESCE(claude_session_id,''), ts_event, token_type,
        // model, COALESCE(source_run_id,'')) unique index (migrations 0011+0017+0035)
        // makes it race-safe. source_run_id (0035) prevents parallel-subagent
        // same-ms collisions (Copilot fleet mode).
        const ins = await db
          .insert(schemaImport.attributionRecord)
          .values({
            instanceId: session.instance_id,
            // Claude's per-conversation session.id (subagents share their parent's),
            // so the session views can group spend per conversation rather than
            // collapsing every conversation on a device into one instance row.
            claudeSessionId: rec.claudeSessionId ?? null,
            teammateId: session.teammate_id,
            // NULL = unallocated (untagged / unknown-project / unauthorized
            // spill / post-end lifecycle spill). Otherwise the membership-gated
            // project. recProjectId/recCou are the PER-EVENT values (D2 spill).
            projectId: recProjectId,
            regionId: session.region_id,
            orgUnitId: session.org_unit_id,
            // Cost-owning unit follows the ATTRIBUTED project (B′): the project's
            // COU, or NULL when unallocated / spilled. (region_id/org_unit_id
            // remain the emitting teammate's — they describe who incurred it.)
            costOwningUnitId: recCou,
            tool: session.tool,
            model: rec.model,
            tokenType: rec.tokenType,
            tokens: BigInt(rec.tokens),
            costUsd,
            // Copilot: native AI-credit operand (nano_aiu/1e9) for credit-lane
            // reconciliation; null for Claude (token lane). Priced once per span.
            creditQty,
            // Copilot: no rate_card row (priced by AI-credit constant, not token lines).
            // Claude: the matched rate card row.
            rateCardId: card?.id ?? null,
            rateCardVersion: card?.version ?? null,
            fidelityTier: recFidelityTier,
            costBasis: recCostBasis,
            tsEvent: new Date(rec.tsEvent),
            sourceRunId: rec.sourceRunId,
            isFrozen: true,
            activity,
            // Per-event lane (mig 0045). NULL = unknown (legacy emission /
            // attr absent) — never defaulted to 'main'.
            querySource: rec.querySource ?? null,
            // Identity provenance (mig 0057): propagate the emitting instance's
            // identity_state ('provisional' | 'confirmed') so downstream surfaces
            // can exclude/label provisional usage. Money is gated by reconciled,
            // not this — display + human-paging discipline only.
            identityState: session.identity_state,
            metadata: recMetadata,
          })
          // Dedup on the (instance_id, COALESCE(claude_session_id,''), ts_event,
          // token_type, model) unique index (migration 0017). No explicit target:
          // it's an EXPRESSION index (the COALESCE), which a drizzle column-list
          // target can't name; attribution_record has exactly one unique index, so
          // a bare DO NOTHING dedups on it without risk of swallowing another.
          .onConflictDoNothing()
          .returning({ id: schemaImport.attributionRecord.id })
        if (ins.length > 0) {
          written += 1
          groupNewRows += 1
          if (spilled) groupEndedSpillNew += 1
        }
      }

      // ING-8: unknown-project / unauthorized-spill counters + audits, gated on
      // newly-written rows exactly like the ended-spill path below — overlap
      // re-reads that dedup to zero must not re-fire the append-only audits.
      if (groupNewRows > 0 && unknownProject) {
        await auditFailSoft(db, {
          eventType: 'attribution-unknown-project',
          actorTeammateId: session.teammate_id,
          actorSystem: 'read-joiner',
          subjectKind: 'session',
          subjectId: session.instance_id,
          payload: {
            project_code_hash: key,
            spans: groupNewRows,
            reason: 'emitted project.code_hash matches no registered project — left unallocated',
          },
        })
      }
      if (groupNewRows > 0 && unauthorizedProjectId) {
        spilledUnauthorized += groupNewRows
        await auditFailSoft(db, {
          eventType: 'attribution-spill-unauthorized',
          actorTeammateId: session.teammate_id,
          actorSystem: 'read-joiner',
          subjectKind: 'session',
          subjectId: session.instance_id,
          payload: {
            project_code_hash: key,
            project_id: unauthorizedProjectId,
            spans: groupNewRows,
            reason: 'teammate not assigned to tagged project — billed as unallocated (spill)',
          },
        })
      }

      // Project-lifecycle spill (D2/D2a) — one summary audit + the re-tag inbox
      // signal (Step 8) per group that spilled NEW rows this tick. Gating on
      // newly-written rows (not all spilled events re-read in the overlap window)
      // keeps the counter honest and the append-only audit from re-emitting every
      // tick. `projectId` is the (now-ended) project the spend used to bill to.
      if (groupEndedSpillNew > 0 && projectId) {
        spilledEnded += groupEndedSpillNew
        await auditFailSoft(db, {
          eventType: 'attribution-spill-ended',
          actorTeammateId: session.teammate_id,
          actorSystem: 'read-joiner',
          subjectKind: 'project',
          subjectId: projectId,
          payload: {
            project_code_hash: key,
            project_id: projectId,
            spans: groupEndedSpillNew,
            reason: 'project ended — events past end_date + grace spilled to unallocated (re-tag signal)',
          },
        })
        await notifyProjectEndedRetag(db, { teammateId: session.teammate_id, projectId })
      }
    }
  }

  // Behavioural usage-signal landing (mig 0065). Teammate-grain: NO project
  // gating, rate card, or lifecycle resolution — resolve instance→teammate (already
  // on SessionRow) and dedup-insert one row per (span, signal). Dedup key
  // (instance, COALESCE(source_run_id,''), signal_name) makes the watermark's
  // overlapping re-reads idempotent via onConflictDoNothing.
  const landSignals = async (session: SessionRow): Promise<void> => {
    if (typeof reader.getSignalUsage !== 'function') return
    const signals = await reader.getSignalUsage(
      session.instance_id,
      signalWatermarks.get(session.instance_id),
    )
    if (signals.length === 0) return
    for (const sig of signals) {
      const ins = await db
        .insert(schemaImport.usageSignalRecord)
        .values({
          instanceId: session.instance_id,
          teammateId: session.teammate_id,
          tool: session.tool,
          signalName: sig.signalName,
          value: String(sig.value), // numeric column — pass as string
          tsEvent: new Date(sig.tsEvent),
          sourceRunId: sig.sourceRunId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schemaImport.usageSignalRecord.id })
      if (ins.length > 0) signalRowsWritten += 1
    }
  }

  for (const session of sessions) {
    try {
      await processSession(session)
    } catch (err) {
      // ING-6: isolate the bad session so it cannot starve the remaining
      // instances this tick (the documented silent-attribution-stop class);
      // it is retried on the next tick. Surfaced via JoinResult.errors.
      errors += 1
      console.warn(
        `[azure-monitor-read] instance ${session.instance_id} failed; continuing with remaining sessions: ${String(err)}`,
      )
    }
    // Signal lane in its OWN try/catch — a signal-path fault must never affect the
    // token attribution above (billing-sacred) nor the JoinResult.errors count.
    try {
      await landSignals(session)
    } catch (err) {
      signalErrors += 1
      console.warn(
        `[azure-monitor-read] signal landing failed for instance ${session.instance_id}; token attribution unaffected: ${String(err)}`,
      )
    }
  }

  return {
    sessionsProcessed: sessions.length,
    attributionRowsWritten: written,
    spansSkippedNoRateCard: skippedNoCard,
    spansSpilledUnauthorized: spilledUnauthorized,
    spansSpilledEnded: spilledEnded,
    errors,
    deepRescan: opts.deepRescan ?? false,
    signalRowsWritten,
    signalErrors,
  }
}

/*
 * Scope-aware + temporal rate-card selection (COST-4/COST-6, mig 0050).
 * Precedence ladder per the contract in 0050_rate_card_scope.sql:
 * (cou match) > (region match) > (global); within each tier only cards whose
 * `effective` range contains the EVENT timestamp and retired_at IS NULL,
 * tie-broken by highest version. Consistent with the estimates path
 * (server/usage/insights.ts fetchRateLines: `effective @> now()`), which this
 * previously diverged from — a card whose period had ENDED kept pricing new
 * events if it carried the highest version.
 *
 * regionId is the teammate's region from the attestation row. NULL (defensive
 * — the column is NOT NULL) degrades to global-tier cards only.
 *
 * CONTRACT (R1 F7, explicit): the pricing region is the ENROLMENT region —
 * the attestation row's region at provision time, not the teammate's current
 * row. A teammate who changes region keeps pricing against the old region's
 * cards until re-enrolment (instances carry a 90d TTL, so the staleness
 * window is bounded). Move-day repricing would make historic costing depend
 * on a MUTABLE column — the worse trade. Revisit with the recost design
 * (docs/design/recost-propagation.md).
 *
 * TODO(cou tier): cou_id selection is NOT implemented yet — `cou_id IS NULL`
 * below excludes CoU-scoped cards entirely, so a future cou-scoped card can
 * never leak into the wrong scope via version ordering. Landing the tier needs
 * (a) a write path that creates cou-scoped cards and (b) a decision on lineage
 * semantics (does a card scoped at an ancestor org_unit cover descendant
 * CoUs?) — which requires an ltree ancestor walk we must NOT bolt on per-event
 * here. When it lands, add the cou predicate + `(cou_id IS NOT NULL) DESC`
 * tier to the ORDER BY and key the joiner cache by cou as well.
 *
 * INVARIANT: with only the seeded card (mig 0004 — global, region_id NULL,
 * effective [2026-01-01, 2099-01-01)) every existing event resolves to it
 * exactly as before the 0050 change.
 */
async function resolveRateCard(
  db: PostgresJsDatabase<typeof schema>,
  tool: string,
  eventTs: string,
  regionId: string | null,
): Promise<RateCardWithLines | null> {
  const provider =
    tool === 'claude-code' ? 'anthropic' : tool === 'copilot-cli' ? 'github' : null
  if (!provider) return null
  const scopeKey = `${provider}:${tool}`
  const cards = await db.execute<{ id: string; version: number }>(
    sql`SELECT id::text AS id, version FROM rate_card
        WHERE scope_key = ${scopeKey}
          AND retired_at IS NULL
          AND effective @> ${eventTs}::timestamptz
          AND (region_id IS NULL OR region_id = ${regionId}::uuid)
          AND cou_id IS NULL
        ORDER BY (region_id IS NOT NULL) DESC, version DESC
        LIMIT 1`,
  )
  const card = cards[0]
  if (!card) return null
  const lines = await db.execute<RateLine>(
    sql`SELECT unit, unit_qty::text AS unit_qty, unit_cost_usd::text AS unit_cost_usd, model
        FROM rate_line WHERE rate_card_id = ${card.id}::uuid`,
  )
  return { id: card.id, version: card.version, lines }
}

function computeCost(
  card: RateCardWithLines,
  tokenType: string,
  model: string,
  tokens: number,
): string | null {
  const candidates = card.lines.filter((l) => l.unit === tokenType)
  if (candidates.length === 0) return null
  const exact = candidates.find((l) => l.model === model)
  const line = exact ?? candidates.find((l) => l.model === null)
  if (!line) return null

  const unitQty = Number(line.unit_qty)
  const unitCost = Number(line.unit_cost_usd)
  if (!Number.isFinite(unitQty) || unitQty === 0) return null
  const cost = (tokens / unitQty) * unitCost
  return cost.toFixed(6)
}
