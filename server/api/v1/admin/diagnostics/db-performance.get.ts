/*
 * GET /api/v1/admin/diagnostics/db-performance — the database's own statistics
 * views, read by the app's connection and rendered in Admin.
 *
 * WHY THIS ENDPOINT EXISTS. Dev's Postgres logs slow statements to Log
 * Analytics, but querying that workspace needs a DATA-plane role
 * (`Log Analytics Reader`); the operator holds control-plane Contributor and
 * cannot self-assign it, so the evidence exists and is unreachable by the
 * person who needs it. The workspace-gated rung of
 * `docs/wiki/Performance-Observability.md`'s triage ladder is therefore a dead
 * end on Dev, and "which of `/me/usage`'s 44 statements spends the 14 s" has no
 * answer. The app's own connection CAN reach the database;
 * this is that door. `docs/design/alert-diagnosability.md` is the standing
 * principle it serves: an operator answers an operational question from Admin
 * alone.
 *
 * RBAC: platform-admin ONLY, matching the other deep probes (network.get.ts,
 * rls-posture.get.ts, otel-logs.get.ts). The response names every table and
 * index in the estate, the server's memory/connection settings, and normalised
 * statement text — infrastructure and control state, not region-scoped
 * operational data. A region-scoped `admin` and global-finops both get a 403,
 * which diagnostics.vue renders as a calm scoped-out note.
 *
 * ── RLS LANE: the REQUEST lane, deliberately ────────────────────────────────
 * Same call as rls-posture.get.ts and for the same two reasons. Every statement
 * below reads `pg_catalog` / `pg_stat_*` / `pg_settings`, which no policy
 * governs, so the lane changes no answer — but it keeps this handler OFF
 * `scripts/check-handler-rls-context.mjs`'s allowlist (no reason entry to argue
 * for, no drift), and it means the connection being MEASURED is the one
 * requests actually use. A probe that measured a different pool would be
 * describing a different server.
 *
 * ── READ-ONLY, AND BOUNDED TWICE ────────────────────────────────────────────
 * Nothing here mutates: no `pg_stat_statements_reset()`, no EXPLAIN, no
 * caller-supplied SQL, and the one parameter (`top`) is a zod-validated integer
 * capped at 50. Every read carries BOTH bounds:
 *   1. a transaction-local `statement_timeout` — the SERVER cancels the
 *      statement (SQLSTATE 57014). This is the bound that actually protects the
 *      database: a race the client loses abandons a promise, not a query.
 *   2. `boundedCall` (the shape from server/workers/ops-alert.ts, as reused in
 *      ./probes.get.ts) — the client stops waiting. Set ABOVE the statement
 *      timeout so the server-side cancel wins by construction and the abandoned
 *      transaction releases its connection on its own.
 * Plus a whole-handler deadline. With SECTION_COUNT reads at PER_READ_BUDGET_MS
 * each, HANDLER_DEADLINE_MS is exactly their sum: the last read still starts
 * inside the deadline even when every earlier read burns its full budget, so
 * the deadline can never STARVE a section — it is a backstop for a read that
 * escapes its own race, not a scheduler.
 *
 * The reads run SEQUENTIALLY, one transaction each. Independently-fallible
 * reads cannot share a transaction (a failing statement aborts it —
 * docs/design/admin-nav-responsiveness.md D4), and issuing six concurrently
 * would take six of the request pool's ten connections for a diagnostic. This
 * probe must never become the outage it is being run to explain.
 *
 * Each read DECLARES itself in `reads` — one `{ available }` entry per section,
 * with a classified reason and a correlation id when false. Without it a failed
 * query and a genuinely empty view are the same bytes on the wire, and the
 * panel renders "nothing to report" for "we could not find out". One
 * unavailable section never blanks its neighbours.
 *
 * ── PARTITIONS: EVERY SECTION ROLLS UP TO THE PARTITION ROOT ────────────────
 * `attribution_record` is partitioned by month. Postgres reports each partition
 * as its OWN relation in `pg_stat_user_tables` / `pg_statio_user_tables` /
 * `pg_class`, and `pg_total_relation_size()` on the partitioned PARENT returns
 * 0 (the parent stores nothing). A probe that grouped by relation would show a
 * top-10 of `attribution_record_2026_08`-style rows, the estate's largest table
 * would read as zero bytes, and its seq-scan pressure would be split 33 ways.
 * So every section groups on `COALESCE(pg_partition_root(oid), oid)` and
 * reports `partitions` so the operator can see the row is a roll-up. (This is
 * the class feedback_audit_the_instrument_not_only_the_claims names: nine
 * review passes missed a probe filtering `relkind='r'` and silently omitting
 * the partitioned table.)
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { z } from 'zod'
import type * as schema from '../../../../../drizzle/schema'
import { requireRole } from '../../../../auth/rbac'
import { getValidated } from '../../../../utils/validated-body'
import { requestClock } from '../../../../utils/request-clock'
import { withRequestRls } from '../../../../db/request-rls'
import { readUnavailable, type ReadAvailability } from '../../../../utils/redact-probe-error'

/** The transaction handle `withRequestRls` hands its body. */
type Tx = PostgresJsDatabase<typeof schema>

/** Server-side cancel. The bound that protects the DATABASE. */
const STATEMENT_TIMEOUT_MS = 1500
/** Client-side race, deliberately ABOVE the statement timeout (see header). */
const PER_READ_BUDGET_MS = 2000
/** How many independently-bounded reads this handler makes. */
const SECTION_COUNT = 6
/** Backstop only: the sum of the per-read budgets, so no section can be starved. */
const HANDLER_DEADLINE_MS = SECTION_COUNT * PER_READ_BUDGET_MS

/** Statement text is already normalised to $1 placeholders by the extension. */
const MAX_STATEMENT_CHARS = 400
/**
 * An index below this costs approximately nothing to keep, so listing it is
 * noise. Reported in the payload rather than hard-coded into the copy: a
 * threshold the reader cannot see is a threshold they will misread.
 */
const MIN_UNUSED_INDEX_BYTES = 65536

/**
 * pg_stat_statements normalises CONSTANTS out of ordinary statements, but
 * UTILITY statements are stored VERBATIM when `track_utility` is on (its
 * default) — so `ALTER ROLE … PASSWORD 'literal'`, which
 * drizzle/provision-app-role.ts issues against this very server, would be
 * readable here in full. Withhold the TEXT of any statement mentioning a
 * password and keep its timings, so the ranking stays honest and the secret
 * never travels. No schema column is named bare `password`, and the word
 * boundary spares `password_hash`-shaped identifiers anyway.
 */
const CREDENTIAL_TEXT = /\bpassword\b/i
const WITHHELD_TEXT = '[text withheld: statement mentions a credential]'

/**
 * Apply that withholding to one statement's text. Exported so the rule can be
 * proven directly: `pg_stat_statements` is not loaded in the test container, so
 * a test driven through the route could never reach this branch and the
 * guarantee would ship unproven.
 */
export function redactStatementText(
  query: string,
  fullLength: number,
): { query: string; truncated: boolean; textWithheld: boolean } {
  if (CREDENTIAL_TEXT.test(query)) {
    return { query: WITHHELD_TEXT, truncated: false, textWithheld: true }
  }
  return { query, truncated: fullLength > MAX_STATEMENT_CHARS, textWithheld: false }
}

const QuerySchema = z.object({
  // The only parameter. Coerced, integral, and capped — a diagnostic that lets
  // a caller ask for an unbounded top-N is a diagnostic that can be pointed at
  // the server it is meant to protect.
  top: z.coerce.number().int().min(1).max(50).default(10),
})

type BoundedOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** The error a read that overran its budget is classified and logged as. */
function budgetExceeded(ms: number): Error & { code: string } {
  // SQLSTATE 57014 (query_canceled) is what the server itself raises when the
  // statement_timeout beneath this race fires, so both bounds classify as
  // 'statement-timeout'. Naming the client-side loss anything else would make
  // the same fault read as two different ones.
  return Object.assign(new Error(`db-performance read exceeded its ${ms} ms budget`), { code: '57014' })
}

/*
 * Race a read against its budget. The losing promise is left pending on
 * purpose: the statement_timeout inside the transaction cancels the query
 * server-side and the connection returns itself: abandoning is safe HERE
 * precisely because the inner bound exists.
 */
async function boundedCall<T>(fn: () => Promise<T>, ms: number): Promise<BoundedOutcome<T>> {
  if (ms <= 0) return { ok: false, error: budgetExceeded(0) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn().then((value) => ({ ok: true as const, value })),
      new Promise<BoundedOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: budgetExceeded(ms) }), ms)
      }),
    ])
  } catch (err) {
    return { ok: false, error: err }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * int8 / numeric arrive as strings over the wire. A non-finite value reads as
 * 0, never NaN — the comment previously said null, which the signature cannot
 * return; 0 and a real measured 0 are indistinguishable here, and that is
 * acceptable only because every caller uses these as counters and sizes.
 */
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export interface StatementRow {
  query: string
  /** True when MAX_STATEMENT_CHARS cut the text, so a reader knows it is partial. */
  truncated: boolean
  /** True when the text was replaced because it mentions a credential. */
  textWithheld: boolean
  calls: number
  totalMs: number
  meanMs: number
  maxMs: number
  rows: number
}

export interface SeqScanRow {
  table: string
  seqScan: number
  seqTupRead: number
  idxScan: number
  liveTuples: number
  /** How many partitions this row rolls up (0 = an ordinary table). */
  partitions: number
  /*
   * ANALYZE FRESHNESS — why a table with the right index is scanned anyway.
   *
   * The planner chooses a sequential scan when it has no row estimates to
   * choose otherwise, and a MAJOR VERSION UPGRADE DOES NOT CARRY STATISTICS
   * ACROSS: pg_upgrade requires a full ANALYZE afterwards, and until it runs
   * every plan on the server is guesswork. That failure is invisible in the
   * scan counts alone — a heavily-scanned table with a matching index and no
   * recent analyze looks identical to one the planner correctly decided to
   * scan. These two columns separate them.
   *
   * Rolled up to the OLDEST member, not the newest: a partitioned table plans
   * only as well as its least-analysed partition, so a fresh empty partition
   * must not mask a stale one.
   */
  /**
   * WORST-CASE analyze freshness, as an ISO timestamp; null if no member has
   * ever been analysed.
   *
   * For an ordinary table this is simply its most recent analyze, manual or
   * auto. For a PARTITIONED one it is the LEAST-RECENTLY-analysed member, not
   * the newest — deliberately, because the table plans only as well as its
   * stalest partition and a fresh (often empty) one must not mask it. Reading
   * this as "when the table was last analysed" would therefore be wrong for
   * exactly the tables it matters most for.
   */
  lastAnalyzed: string | null
  /** Members (partitions, or the table itself) never analysed at all. */
  neverAnalyzed: number
  /** Rows changed since the last analyze — the direct measure of staleness. */
  rowsChangedSinceAnalyze: number
}

export interface CacheRow {
  table: string
  heapHit: number
  heapRead: number
  idxHit: number
  idxRead: number
  /** hit / (hit + read) across heap AND index blocks; null when nothing was read. */
  hitRatio: number | null
  partitions: number
}

export interface UnusedIndexRow {
  index: string
  table: string
  bytes: number
  partitions: number
}

export interface SizeRow {
  table: string
  tableBytes: number
  indexBytes: number
  totalBytes: number
  partitions: number
}

export interface SettingRow {
  name: string
  /** The raw value, in `unit` (e.g. shared_buffers 16384 × 8kB). */
  setting: string
  unit: string
  /** What SHOW would print — the same number with its unit applied. */
  display: string
  source: string
  /** The value is set but needs a server RESTART before it takes effect. */
  pendingRestart: boolean
}

/**
 * How far back the counters on this page reach.
 *
 * WITHOUT IT THE NUMBERS HAVE NO DENOMINATOR. "68,400 sequential scans" is
 * alarming over an hour and unremarkable over a year, and nothing else on the
 * page says which. It also decides what "never scanned" is worth: a MAJOR
 * VERSION UPGRADE resets these counters, so shortly afterwards an index used
 * weekly is indistinguishable from a dead one, and dropping it on that basis
 * destroys a working index to save nothing.
 *
 * SCOPE: the pg_stat_user_* counters only — sequential scans, cache, unused
 * indexes. It does NOT describe the statement table: `pg_stat_statements` keeps
 * its own reset time in `pg_stat_statements_info` and a database-wide reset
 * does not touch it, so labelling that section with this timestamp would assert
 * a denominator that is not its own.
 *
 * It is also a FLOOR, not an exact window for any single row:
 * `pg_stat_reset_single_table_counters` re-zeroes one relation without moving
 * it, so an individual table can be younger than this says. It is the last
 * database-WIDE reset, and the copy on the page says exactly that.
 */
export interface StatsWindow {
  /** ISO instant of the last database-wide reset; null if never reset. */
  databaseSince: string | null
  /**
   * Whether the read that fetched these succeeded. Without it a failed read and
   * a genuine "never reset" are the same null, and the page would present
   * "window unknown" as though it were a fact about the database.
   */
  available: boolean
}

/**
 * Whether shared_preload_libraries actually names pg_stat_statements.
 *
 * EXACT, comma-delimited — never a substring test, which would match a
 * `pg_stat_statements_extra` and report the library as loaded when it is not.
 * ONE definition: both call sites share it.
 */
export function isPgStatStatementsPreloaded(raw: string | null | undefined): boolean {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .includes('pg_stat_statements')
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'platform-admin')
  const { top } = await getValidated(event, QuerySchema)

  // The SERVER owns the labelled instant (CLAUDE.md §The clock). Date.now()
  // below is monotonic budget arithmetic, not a window or a label.
  // `now` is already an ISO-8601 UTC instant string — the shipped contract.
  const generatedAt = requestClock(event).now
  const startedMono = Date.now()
  const remainingMs = () => HANDLER_DEADLINE_MS - (Date.now() - startedMono)

  /*
   * One read: its own transaction, its own statement_timeout, its own race, its
   * own catch. `context` is the hardcoded probe-error label passed whole at each
   * call site (redact-probe-error.ts's contract), never derived from request
   * input.
   *
   * `set_config(..., true)` rather than a raw `SET LOCAL`: it is a function, so
   * the value BINDS as a parameter and no SQL string is ever built here — the
   * same reason server/db/rls.ts sets the four RLS GUCs that way.
   */
  async function read<T>(
    context: string,
    body: (tx: Tx) => Promise<T>,
  ): Promise<{ value: T | null; availability: ReadAvailability }> {
    const outcome = await boundedCall(
      () =>
        withRequestRls(event, async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
          )
          return body(tx)
        }),
      Math.min(PER_READ_BUDGET_MS, remainingMs()),
    )
    if (outcome.ok) return { value: outcome.value, availability: { available: true } }
    return { value: null, availability: readUnavailable(outcome.error, context) }
  }

  // ── 1. pg_stat_statements ───────────────────────────────────────────────
  // Two facts decide whether the view can be read at all, and they are
  // DIFFERENT failures with different fixes: the library must be preloaded
  // (a server parameter + a RESTART) and the extension must be created (one
  // DDL statement). Measuring both means the panel can say which one is
  // missing instead of "no data". Neither absence is a probe FAILURE — the
  // read succeeds and reports the configuration honestly.
  let extension: {
    preloaded: boolean | null
    installed: boolean | null
    ready: boolean
    note: string
  } = {
    preloaded: null,
    installed: null,
    ready: false,
    note: 'The extension state could not be read.',
  }
  const statementsRead = await read('diagnostics:db-performance:statements', async (tx) => {
    const stateRows = await tx.execute<{
      preload: string | null
      installed: boolean
      track: string | null
    }>(sql`
      SELECT COALESCE(current_setting('shared_preload_libraries', true), '') AS preload,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed,
             -- missing_ok = true, so this is NULL rather than an error when the
             -- extension is absent, which is its normal state here.
             COALESCE(current_setting('pg_stat_statements.track', true), '') AS track
    `)
    const state = [...stateRows][0]
    const preloaded = isPgStatStatementsPreloaded(state?.preload)
    const installed = Boolean(state?.installed)
    /*
     * `track = 'none'` yields a readable view that collects nothing. Without
     * this, the badge reads "Loaded" and the empty table implies "nothing has
     * run yet" — a false verdict about the server's configuration, on the panel
     * whose job is to report that configuration.
     */
    const track = (state?.track ?? '').trim().toLowerCase()
    const tracking = track !== '' && track !== 'none'
    const ready = preloaded && installed && tracking
    extension = {
      preloaded,
      installed,
      ready,
      note: ready
        ? 'Loaded. Counters are CUMULATIVE since the last reset or server restart — not per-request.'
        : !preloaded
          ? "pg_stat_statements is NOT in shared_preload_libraries, so the server is collecting no per-statement history at all. To enable: add it to the server's shared_preload_libraries (infra/modules/postgresql.bicep declares it) and RESTART the server, then run CREATE EXTENSION pg_stat_statements."
          : !installed
            ? 'pg_stat_statements is preloaded but the extension is not created in this database. To enable: CREATE EXTENSION pg_stat_statements.'
            : `pg_stat_statements is preloaded and installed, but pg_stat_statements.track is '${track || 'unset'}', so nothing is being recorded. Set it to 'top' or 'all'.`,
    }
    if (!ready) return []

    // Scoped to THIS database so another database on the same server cannot
    // dilute the ranking. `top` is the zod-validated integer, BOUND as a
    // parameter — no interpolation anywhere in this file's SQL.
    const rows = await tx.execute<{
      query: string
      full_len: number
      calls: string
      total_ms: string
      mean_ms: string
      max_ms: string
      rows: string
    }>(sql`
      SELECT left(query, ${MAX_STATEMENT_CHARS}) AS query,
             length(query) AS full_len,
             calls,
             round(total_exec_time::numeric, 1) AS total_ms,
             round(mean_exec_time::numeric, 2) AS mean_ms,
             round(max_exec_time::numeric, 2) AS max_ms,
             rows
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC
      LIMIT ${top}
    `)
    return [...rows].map((r) => ({
      ...redactStatementText(r.query, num(r.full_len)),
      calls: num(r.calls),
      totalMs: num(r.total_ms),
      meanMs: num(r.mean_ms),
      maxMs: num(r.max_ms),
      rows: num(r.rows),
    }))
  })
  const statements: StatementRow[] = statementsRead.value ?? []

  // ── 2. Sequential-scan pressure ─────────────────────────────────────────
  // The finding is a BIG table with high seq_scan and low idx_scan. Ordered by
  // seq_tup_read (rows actually walked), which is the pressure — seq_scan alone
  // ranks a nine-row lookup table above a full pass over a million rows.
  const seqRead = await read('diagnostics:db-performance:sequential-scans', async (tx) => {
    const rows = await tx.execute<{
      table_name: string
      seq_scan: string
      seq_tup_read: string
      idx_scan: string
      n_live_tup: string
      partitions: number
      last_analyzed: string | null
      never_analyzed: number
      mod_since_analyze: string
    }>(sql`
      WITH t AS (
        SELECT COALESCE(pg_partition_root(s.relid), s.relid) AS root_oid,
               s.relid, s.seq_scan, s.seq_tup_read, s.idx_scan, s.n_live_tup,
               -- Manual and auto analyze are two ways of getting the same
               -- thing; the planner does not care which ran, only how stale
               -- the result is.
               GREATEST(s.last_analyze, s.last_autoanalyze) AS analyzed_at,
               s.n_mod_since_analyze
        FROM pg_stat_user_tables s
      )
      SELECT (root_oid::regclass)::text AS table_name,
             COALESCE(SUM(seq_scan), 0)::bigint AS seq_scan,
             COALESCE(SUM(seq_tup_read), 0)::bigint AS seq_tup_read,
             COALESCE(SUM(idx_scan), 0)::bigint AS idx_scan,
             COALESCE(SUM(n_live_tup), 0)::bigint AS n_live_tup,
             COUNT(*) FILTER (WHERE relid <> root_oid)::int AS partitions,
             -- MIN, so the oldest member decides: a partitioned table plans
             -- only as well as its least-analysed partition.
             MIN(analyzed_at) AS last_analyzed,
             COUNT(*) FILTER (WHERE analyzed_at IS NULL)::int AS never_analyzed,
             COALESCE(SUM(n_mod_since_analyze), 0)::bigint AS mod_since_analyze
      FROM t
      GROUP BY root_oid
      ORDER BY seq_tup_read DESC, table_name
      LIMIT ${top}
    `)
    return [...rows].map((r) => ({
      table: r.table_name,
      seqScan: num(r.seq_scan),
      seqTupRead: num(r.seq_tup_read),
      idxScan: num(r.idx_scan),
      liveTuples: num(r.n_live_tup),
      partitions: num(r.partitions),
      lastAnalyzed: r.last_analyzed ? new Date(r.last_analyzed).toISOString() : null,
      neverAnalyzed: num(r.never_analyzed),
      rowsChangedSinceAnalyze: num(r.mod_since_analyze),
    }))
  })
  const sequentialScans: SeqScanRow[] = seqRead.value ?? []

  // ── 3. Cache behaviour ──────────────────────────────────────────────────
  // Block counts, not timings, so `track_io_timing` being off (its default, and
  // Dev's setting) does not blank this section. Ordered by physical reads: the
  // tables the buffer cache is missing.
  const cacheRead = await read('diagnostics:db-performance:cache', async (tx) => {
    const rows = await tx.execute<{
      table_name: string
      heap_hit: string
      heap_read: string
      idx_hit: string
      idx_read: string
      partitions: number
    }>(sql`
      WITH t AS (
        SELECT COALESCE(pg_partition_root(s.relid), s.relid) AS root_oid,
               s.relid,
               COALESCE(s.heap_blks_hit, 0) AS hh, COALESCE(s.heap_blks_read, 0) AS hr,
               COALESCE(s.idx_blks_hit, 0) AS ih, COALESCE(s.idx_blks_read, 0) AS ir
        FROM pg_statio_user_tables s
      )
      SELECT (root_oid::regclass)::text AS table_name,
             SUM(hh)::bigint AS heap_hit,
             SUM(hr)::bigint AS heap_read,
             SUM(ih)::bigint AS idx_hit,
             SUM(ir)::bigint AS idx_read,
             COUNT(*) FILTER (WHERE relid <> root_oid)::int AS partitions
      FROM t
      GROUP BY root_oid
      ORDER BY (SUM(hr) + SUM(ir)) DESC, table_name
      LIMIT ${top}
    `)
    return [...rows].map((r) => {
      const hit = num(r.heap_hit) + num(r.idx_hit)
      const readBlocks = num(r.heap_read) + num(r.idx_read)
      return {
        table: r.table_name,
        heapHit: num(r.heap_hit),
        heapRead: num(r.heap_read),
        idxHit: num(r.idx_hit),
        idxRead: num(r.idx_read),
        // Null, never 1.0, when the table has been neither hit nor read: a
        // perfect ratio for a table nobody touched is a lie.
        hitRatio: hit + readBlocks === 0 ? null : hit / (hit + readBlocks),
        partitions: num(r.partitions),
      }
    })
  })
  const cache: CacheRow[] = cacheRead.value ?? []

  // ── 4. Unused indexes ───────────────────────────────────────────────────
  // Never scanned, and big enough to matter: they cost every write and their
  // storage for nothing. UNIQUE and PRIMARY KEY indexes are excluded — they
  // back a constraint, so "unused" is not an argument for dropping them, and
  // listing them would train the reader to ignore this section.
  const unusedRead = await read('diagnostics:db-performance:unused-indexes', async (tx) => {
    const rows = await tx.execute<{
      index_name: string
      table_name: string
      bytes: string
      partitions: number
    }>(sql`
      WITH ix AS (
        SELECT COALESCE(pg_partition_root(s.indexrelid), s.indexrelid) AS root_ix,
               s.indexrelid,
               s.idx_scan,
               i.indisunique,
               i.indisprimary,
               i.indisexclusion,
               COALESCE(pg_partition_root(s.relid), s.relid) AS root_tbl
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
      )
      SELECT (root_ix::regclass)::text AS index_name,
             (MIN(root_tbl)::regclass)::text AS table_name,
             SUM(pg_relation_size(indexrelid))::bigint AS bytes,
             COUNT(*) FILTER (WHERE indexrelid <> root_ix)::int AS partitions
      FROM ix
      GROUP BY root_ix
      HAVING COALESCE(SUM(idx_scan), 0) = 0
         AND NOT bool_or(indisunique)
         AND NOT bool_or(indisprimary)
         -- EXCLUSION constraints too. They are enforced on WRITE and are
         -- frequently never scanned, so without this an index holding a
         -- correctness invariant appears under a caption saying it costs
         -- "nothing" — an invitation to drop a constraint. This estate has
         -- several (btree_gist ranges); they are not optional.
         AND NOT bool_or(indisexclusion)
         AND SUM(pg_relation_size(indexrelid)) >= ${MIN_UNUSED_INDEX_BYTES}
      ORDER BY bytes DESC, index_name
      LIMIT ${top}
    `)
    return [...rows].map((r) => ({
      index: r.index_name,
      table: r.table_name,
      bytes: num(r.bytes),
      partitions: num(r.partitions),
    }))
  })
  const unusedIndexes: UnusedIndexRow[] = unusedRead.value ?? []

  // ── 5. Sizes ────────────────────────────────────────────────────────────
  const sizesRead = await read('diagnostics:db-performance:sizes', async (tx) => {
    const rows = await tx.execute<{
      table_name: string
      table_bytes: string
      index_bytes: string
      total_bytes: string
      partitions: number
    }>(sql`
      WITH rel AS (
        SELECT c.oid AS oid, COALESCE(pg_partition_root(c.oid), c.oid) AS root_oid
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      )
      SELECT (root_oid::regclass)::text AS table_name,
             SUM(pg_table_size(oid))::bigint AS table_bytes,
             SUM(pg_indexes_size(oid))::bigint AS index_bytes,
             SUM(pg_total_relation_size(oid))::bigint AS total_bytes,
             COUNT(*) FILTER (WHERE oid <> root_oid)::int AS partitions
      FROM rel
      GROUP BY root_oid
      ORDER BY total_bytes DESC, table_name
      LIMIT ${top}
    `)
    return [...rows].map((r) => ({
      table: r.table_name,
      tableBytes: num(r.table_bytes),
      indexBytes: num(r.index_bytes),
      totalBytes: num(r.total_bytes),
      partitions: num(r.partitions),
    }))
  })
  const sizes: SizeRow[] = sizesRead.value ?? []

  // ── 6. Relevant server settings ─────────────────────────────────────────
  // `pending_restart` is the one an operator most needs here: it is how the
  // bicep change to shared_preload_libraries reports "applied, not yet in
  // force" (see infra/modules/postgresql.bicep).
  const settingsRead = await read('diagnostics:db-performance:settings', async (tx) => {
    const rows = await tx.execute<{
      name: string
      setting: string
      unit: string
      display: string
      source: string
      pending_restart: boolean
      stats_reset: string | null
    }>(sql`
      SELECT s.name,
             s.setting,
             COALESCE(s.unit, '') AS unit,
             current_setting(s.name) AS display,
             s.source,
             s.pending_restart,
             -- Rides THIS read rather than a seventh transaction: the handler
             -- deadline is exactly 6 x the per-read budget, so an extra
             -- transaction would silently break that bound.
             (SELECT stats_reset FROM pg_stat_database
               WHERE datname = current_database()) AS stats_reset
      FROM pg_settings s
      WHERE s.name IN (
        'shared_buffers', 'work_mem', 'effective_cache_size', 'max_connections',
        'log_min_duration_statement', 'track_io_timing', 'shared_preload_libraries',
        -- The two pg_stat_statements knobs. They appear in pg_settings only
        -- when the library is loaded, so the row count here is environment
        -- dependent by design.
        --
        -- track, because 'none' means installed, readable, and RECORDING
        -- NOTHING: an empty statement table that reads as "nothing is slow".
        --
        -- track_utility, because ON makes the extension store utility
        -- statements VERBATIM, and provision-app-role.ts issues
        -- ALTER ROLE ... PASSWORD against this server. That is a credential in a
        -- view, and an operator should be able to SEE it is off rather than
        -- trust that it is. Reach is not the point: few people can read this
        -- view, and a password still does not belong in it.
        'pg_stat_statements.track', 'pg_stat_statements.track_utility'
      )
      ORDER BY s.name
    `)
    const all = [...rows]
      /*
       * pg_stat_statements has its OWN reset domain, and it must be read as a
       * SEPARATE STATEMENT rather than a subquery. A `CASE WHEN
       * to_regclass(...) IS NULL` guard does not help: Postgres resolves the
       * relation at PARSE time, so naming the view at all makes the entire
       * query fail whenever the extension is absent — which is its normal
       * state until the boot step creates it, and which one of this file's own
       * tests induces by dropping it.
       *
       * A second statement, not a second transaction: the probe's deadline is
       * 6 x the per-read budget and counts TRANSACTIONS, so this stays inside
       * the bound.
       */
      /*
       * pg_stat_statements keeps its OWN reset time, and reaching it safely
       * needs BOTH facts, not one:
       *
       *   - the view must EXIST (the extension is created), and
       *   - the LIBRARY must be preloaded — otherwise the view exists in the
       *     catalog and selecting from it raises "must be loaded via
       *     shared_preload_libraries", which would fail this whole read and
       *     blank seven unrelated settings to report a timestamp nobody asked
       *     for. That state is not hypothetical; it is exactly the one this
       *     change exists to leave.
       *
       * Preloading is already in `all` — this read fetches
       * shared_preload_libraries — so the guard costs nothing and cannot throw.
       * A separate STATEMENT, not a separate transaction: the handler's
       * deadline counts transactions, so this stays inside the bound.
       */
      return {
        rows: all.map((r) => ({
          name: r.name,
          setting: r.setting,
          unit: r.unit,
          display: r.display,
          source: r.source,
          pendingRestart: Boolean(r.pending_restart),
        })),
        // Same on every row (a scalar subquery); read from the first.
        statsResetAt: all[0]?.stats_reset ?? null,
      }
  })
  const settings: SettingRow[] = settingsRead.value?.rows ?? []
  const iso = (v: string | null | undefined): string | null =>
    v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null
  const statsWindow: StatsWindow = {
    databaseSince: iso(settingsRead.value?.statsResetAt),
    // Shares the settings read, so it shares its fate. Stated rather than
    // inferred: a failed read and a never-reset database both yield null, and
    // only this distinguishes "we could not find out" from "it has not happened".
    available: settingsRead.availability.available,
  }

  return {
    generatedAt,
    topN: top,
    // The bounds this run was held to, named rather than implied: a section
    // reported 'statement-timeout' is only interpretable beside its budget.
    budget: {
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      perReadMs: PER_READ_BUDGET_MS,
      deadlineMs: HANDLER_DEADLINE_MS,
      elapsedMs: Date.now() - startedMono,
    },
    statements: { extension, rows: statements },
    // The window EVERY counter below is measured over. Stated once, at the top,
    // because a scan count without it is not evidence.
    statsWindow,
    sequentialScans,
    cache,
    unusedIndexes: { minBytes: MIN_UNUSED_INDEX_BYTES, rows: unusedIndexes },
    sizes,
    settings,
    // Availability of each read above, keyed by the field it governs. An empty
    // section and a failed one are otherwise the same bytes.
    reads: {
      statements: statementsRead.availability,
      sequentialScans: seqRead.availability,
      cache: cacheRead.availability,
      unusedIndexes: unusedRead.availability,
      sizes: sizesRead.availability,
      settings: settingsRead.availability,
    },
  }
})
