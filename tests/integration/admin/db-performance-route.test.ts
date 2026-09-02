// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics/db-performance — the operator's door onto the
 * database's own statistics views.
 *
 * WHAT THIS FILE PINS, and why each one is here rather than assumed:
 *
 *  1. RBAC. The response names every table, index and server setting in the
 *     estate, so the gate is platform-admin — not the region `admin` most of
 *     this page answers to, and not global-finops either. A route test is the
 *     only thing that can see that boundary (CLAUDE.md rule 10).
 *  2. Each section answers against a REAL Postgres, and declares itself
 *     available.
 *  3. HONEST DEGRADATION, the two shapes that are NOT the same thing:
 *       (a) pg_stat_statements is not loaded — a CONFIGURATION fact. The read
 *           SUCCEEDS, says exactly what is missing and what would enable it,
 *           and does not fail the probe. The test container has no
 *           `shared_preload_libraries`, which makes this the natural case here.
 *       (b) a section's source is unavailable — the read FAILED. It must report
 *           `available:false` with a classified reason, never an empty success,
 *           and its neighbours must still carry their rows.
 *  4. The partition roll-up. `attribution_record` is partitioned; every section
 *     groups on the partition ROOT. Without it the largest table in the estate
 *     reports zero bytes (a partitioned parent stores nothing) and the top-N is
 *     33 rows of one table. This is the instrument-audit class, so it is
 *     asserted on the payload rather than trusted to the SQL.
 *  5. The `top` parameter is validated and capped.
 *  6. Read-only: no counter reset anywhere in the handler.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripComments } from '../../helpers/strip-comments'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
// vi.mock below is hoisted above this import, so the handler resolves the
// doubled request-rls module.
import rawHandler, { redactStatementText } from '../../../server/api/v1/admin/diagnostics/db-performance.get'

/*
 * A targeted, catchable failure for ONE read. Every section opens its own
 * `withRequestRls` transaction, so failing the Nth call fails exactly one
 * section — which is the only way to observe "an unavailable section never
 * blanks its neighbours" from outside the handler. The error carries a real
 * SQLSTATE so it travels through the same classifier a genuine driver fault
 * would.
 */
const inject = vi.hoisted(() => ({ failCall: null as number | null, calls: 0 }))

vi.mock('../../../server/db/request-rls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/db/request-rls')>()
  return {
    ...actual,
    withRequestRls: async (...args: Parameters<typeof actual.withRequestRls>) => {
      inject.calls += 1
      if (inject.failCall !== null && inject.calls === inject.failCall) {
        // 42P01 undefined_table → classified 'relation-missing'.
        throw Object.assign(new Error('relation "pg_statio_user_tables" does not exist'), {
          code: '42P01',
        })
      }
      return actual.withRequestRls(...args)
    },
  }
})

const handler = rawHandler as unknown as (event: unknown) => Promise<DbPerfResp>

/** The response shape, spelled here so a silent change to it fails this file. */
interface ReadAvailability {
  available: boolean
  error?: string
  errorCorrelationId?: string
}
interface DbPerfResp {
  generatedAt: string
  topN: number
  budget: { statementTimeoutMs: number; perReadMs: number; deadlineMs: number; elapsedMs: number }
  statements: {
    extension: { preloaded: boolean | null; installed: boolean | null; ready: boolean; note: string }
    rows: { query: string; calls: number; totalMs: number }[]
  }
  sequentialScans: { table: string; seqScan: number; seqTupRead: number; idxScan: number; liveTuples: number; partitions: number }[]
  cache: { table: string; hitRatio: number | null; partitions: number }[]
  unusedIndexes: { minBytes: number; rows: { index: string; table: string; bytes: number }[] }
  sizes: { table: string; tableBytes: number; indexBytes: number; totalBytes: number; partitions: number }[]
  settings: { name: string; setting: string; display: string; source: string; pendingRestart: boolean }[]
  reads: {
    statements: ReadAvailability
    sequentialScans: ReadAvailability
    cache: ReadAvailability
    unusedIndexes: ReadAvailability
    sizes: ReadAvailability
    settings: ReadAvailability
  }
}

let t: TestDb
let regionId: string
let ouId: string
let devId: string
let adminId: string
let finopsId: string
let platformId: string

/** Minimal h3-shaped event with a query string + injected session. */
function ev(opts: { session: Session; query?: Record<string, string> }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const path = `/api/v1/admin/diagnostics/db-performance${qs}`
  const e = {
    // h3's getQuery reads event.path, NOT node.req.url — a mock without it
    // silently yields an empty query, so every param test would pass vacuously.
    path,
    node: {
      req: {
        method: 'GET',
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof handler>[0]
}

const session = (role: Session['role'], id: () => string, email: string): Session => ({
  teammateId: id(),
  email,
  displayName: role,
  role,
  regionId,
  orgPath: 'dbp.svc',
})
const dev = () => session('developer', () => devId, 'dbp-dev@x.test')
const admin = () => session('admin', () => adminId, 'dbp-admin@x.test')
const finops = () => session('global-finops', () => finopsId, 'dbp-fin@x.test')
const platform = () => session('platform-admin', () => platformId, 'dbp-pa@x.test')

/** A table whose only non-unique index is never scanned and is big enough to matter. */
const PROBE_TABLE = 'dbperf_unused_index_probe'
const PROBE_INDEX = 'dbperf_unused_index_probe_v_idx'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'dbp-r', displayName: 'DBP R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'dbp.svc', code: 'dbp-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const mk = async (role: string, email: string, oid: string) => {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email, role, regionId, orgUnitId: ouId })
      .returning()
    return row!.id
  }
  devId = await mk('developer', 'dbp-dev@x.test', 'oid-dbp-dev')
  adminId = await mk('admin', 'dbp-admin@x.test', 'oid-dbp-admin')
  finopsId = await mk('global-finops', 'dbp-fin@x.test', 'oid-dbp-fin')
  platformId = await mk('platform-admin', 'dbp-pa@x.test', 'oid-dbp-pa')

  // A real unused index, over the handler's 64 KiB floor: 20k rows of a
  // 24-char value. Never queried through the index, so idx_scan stays 0.
  await t.client.unsafe(`CREATE TABLE ${PROBE_TABLE} (id int PRIMARY KEY, v text)`)
  await t.client.unsafe(
    `INSERT INTO ${PROBE_TABLE} SELECT g, 'padpadpadpadpadpadpad' || g FROM generate_series(1, 20000) g`,
  )
  await t.client.unsafe(`CREATE INDEX ${PROBE_INDEX} ON ${PROBE_TABLE} (v)`)
  await t.client.unsafe(`ANALYZE ${PROBE_TABLE}`)
  // Force a sequential pass over the partitioned table so its roll-up carries
  // real counters rather than the zeroes of a table nothing has touched, and
  // over the probe table so it ranks by seq_tup_read instead of tying at zero
  // (a tie decided alphabetically could push it past `top` and make the
  // read-only assertion below compare 0 with 0).
  await t.client.unsafe(`SELECT count(*) FROM attribution_record`)
  await t.client.unsafe(`SELECT count(*) FROM ${PROBE_TABLE}`)
  // PG15+ keeps stats in shared memory and flushes them lazily; without this
  // the counters above may not be visible to the next transaction.
  await t.client.unsafe(`SELECT pg_stat_force_next_flush()`)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(() => {
  inject.failCall = null
  inject.calls = 0
})

describe('GET /admin/diagnostics/db-performance — RBAC', () => {
  it('REJECTS a developer', async () => {
    await expect(handler(ev({ session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('REJECTS a region admin — this names every table and setting in the estate', async () => {
    await expect(handler(ev({ session: admin() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('REJECTS global-finops — the finance super-role is still not an infra role', async () => {
    await expect(handler(ev({ session: finops() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('allows platform-admin', async () => {
    const res = await handler(ev({ session: platform() }))
    expect(res.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('GET /admin/diagnostics/db-performance — every section answers', () => {
  it('returns all six sections, each declaring itself available', async () => {
    const res = await handler(ev({ session: platform() }))
    for (const key of ['statements', 'sequentialScans', 'cache', 'unusedIndexes', 'sizes', 'settings'] as const) {
      expect(res.reads[key], `reads.${key}`).toEqual({ available: true })
    }
    expect(res.sequentialScans.length).toBeGreaterThan(0)
    expect(res.cache.length).toBeGreaterThan(0)
    expect(res.sizes.length).toBeGreaterThan(0)
    // The seven core settings always resolve. The two pg_stat_statements knobs
    // exist in pg_settings only when the library is loaded, so an exact count
    // would pass or fail on the container's configuration rather than on this
    // handler.
    for (const n of [
      'shared_buffers',
      'work_mem',
      'effective_cache_size',
      'max_connections',
      'log_min_duration_statement',
      'track_io_timing',
      'shared_preload_libraries',
    ]) {
      expect(res.settings.map((x) => x.name), `missing setting ${n}`).toContain(n)
    }
  })

  it('reports the seven settings an operator needs, with their restart state', async () => {
    const res = await handler(ev({ session: platform() }))
    expect(res.settings.map((s) => s.name).sort()).toEqual([
      'effective_cache_size',
      'log_min_duration_statement',
      'max_connections',
      'shared_buffers',
      'shared_preload_libraries',
      'track_io_timing',
      'work_mem',
    ])
    const maxConn = res.settings.find((s) => s.name === 'max_connections')!
    // `display` is what SHOW prints; `setting` is the raw value. Both, because
    // shared_buffers reads as 16384 in one and 128MB in the other.
    expect(Number(maxConn.setting)).toBeGreaterThan(0)
    expect(maxConn.display).toBe(maxConn.setting)
    expect(res.settings.every((s) => typeof s.pendingRestart === 'boolean')).toBe(true)
  })

  it('names the never-scanned index that is big enough to matter, and not the primary key', async () => {
    const res = await handler(ev({ session: platform(), query: { top: '50' } }))
    const names = res.unusedIndexes.rows.map((r) => r.index)
    expect(names).toContain(PROBE_INDEX)
    const row = res.unusedIndexes.rows.find((r) => r.index === PROBE_INDEX)!
    expect(row.table).toBe(PROBE_TABLE)
    expect(row.bytes).toBeGreaterThanOrEqual(res.unusedIndexes.minBytes)
    // The primary key is never scanned either, and is never a candidate: it
    // backs a constraint, so listing it would train the reader to ignore this
    // section.
    expect(names.some((n) => n.includes('pkey'))).toBe(false)
  })

  it('caps the reported rows at `top`', async () => {
    const res = await handler(ev({ session: platform(), query: { top: '3' } }))
    expect(res.topN).toBe(3)
    expect(res.sizes.length).toBeLessThanOrEqual(3)
    expect(res.sequentialScans.length).toBeLessThanOrEqual(3)
    expect(res.cache.length).toBeLessThanOrEqual(3)
  })

  it('defaults `top` to 10 and REFUSES a value outside the cap', async () => {
    expect((await handler(ev({ session: platform() }))).topN).toBe(10)
    await expect(handler(ev({ session: platform(), query: { top: '0' } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(handler(ev({ session: platform(), query: { top: '51' } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(handler(ev({ session: platform(), query: { top: 'all' } }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('carries the bounds it was held to, so a timed-out section is interpretable', async () => {
    const res = await handler(ev({ session: platform() }))
    expect(res.budget.statementTimeoutMs).toBeGreaterThan(0)
    // The client race must sit ABOVE the server-side cancel, or the abandoned
    // transaction outlives the bound that was supposed to release it.
    expect(res.budget.perReadMs).toBeGreaterThan(res.budget.statementTimeoutMs)
    // The deadline is the sum of the per-read budgets: no section can be
    // starved by its predecessors.
    expect(res.budget.deadlineMs).toBe(res.budget.perReadMs * 6)
    expect(res.budget.elapsedMs).toBeLessThanOrEqual(res.budget.deadlineMs)
  })
})

describe('GET /admin/diagnostics/db-performance — partition roll-up', () => {
  it('reports attribution_record ONCE, with its partitions summed', async () => {
    const res = await handler(ev({ session: platform(), query: { top: '50' } }))

    const parent = res.sizes.find((s) => s.table === 'attribution_record')
    expect(parent, 'attribution_record missing from sizes').toBeTruthy()
    // A partitioned PARENT stores nothing: pg_total_relation_size on it is 0.
    // A non-zero total is only possible if the partitions were rolled into it.
    expect(parent!.partitions).toBeGreaterThan(0)
    expect(parent!.totalBytes).toBeGreaterThan(0)

    // …and the partitions must not ALSO be listed, or the top-N is one table
    // repeated and the estate's real shape is invisible.
    const leaked = res.sizes.filter((s) => /^attribution_record_/.test(s.table))
    expect(leaked.map((s) => s.table)).toEqual([])
  })

  it('sums the partitions sequential-scan counters onto the parent', async () => {
    const res = await handler(ev({ session: platform(), query: { top: '50' } }))
    const row = res.sequentialScans.find((s) => s.table === 'attribution_record')
    expect(row, 'attribution_record missing from sequentialScans').toBeTruthy()
    expect(row!.partitions).toBeGreaterThan(0)
    // beforeAll ran a count(*) over every partition.
    expect(row!.seqScan).toBeGreaterThanOrEqual(row!.partitions)
    expect(res.sequentialScans.filter((s) => /^attribution_record_/.test(s.table))).toEqual([])
    expect(res.cache.filter((s) => /^attribution_record_/.test(s.table))).toEqual([])
  })
})

describe('GET /admin/diagnostics/db-performance — constraint indexes are not "unused"', () => {
  it('never lists an EXCLUSION-constraint index', async () => {
    /*
     * An exclusion index is enforced on WRITE and is often never scanned, so it
     * is indistinguishable from dead weight in pg_stat. The panel's caption says
     * these cost "every write and their storage for nothing" — true of a
     * genuinely unused index, catastrophic advice about one holding an invariant.
     *
     * THE PRECONDITIONS ARE ASSERTED, not assumed: the query also demands
     * >= 64 KiB, zero scans and a place in the top N, and the estate's own
     * exclusion indexes are all 8 KiB — so without a purpose-built one this
     * test passes whether or not the filter exists.
     */
    // Purpose-built, because the estate's own exclusion indexes are all one
    // page and the query's floor is 64 KiB.
    await t.client.unsafe(`
      CREATE TABLE IF NOT EXISTS excl_probe (
        id int GENERATED ALWAYS AS IDENTITY,
        k text NOT NULL,
        span int4range NOT NULL,
        EXCLUDE USING gist (k WITH =, span WITH &&)
      )`)
    await t.client.unsafe(`
      INSERT INTO excl_probe (k, span)
      SELECT 'k' || g, int4range(g, g + 1) FROM generate_series(1, 4000) g
      ON CONFLICT DO NOTHING`)

    const candidates = [
      ...(await t.client<{ name: string; bytes: string; scans: string }[]>`
        SELECT c.relname AS name,
               pg_relation_size(i.indexrelid)::text AS bytes,
               COALESCE(s.idx_scan, 0)::text AS scans
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
         WHERE i.indisexclusion`),
    ]
    expect(candidates.length, 'no exclusion constraints — this test would be vacuous').toBeGreaterThan(0)

    // At least one must ACTUALLY qualify, or removing the indisexclusion filter
    // would change nothing and this test would prove nothing.
    const qualifying = candidates.filter(
      (r) => Number(r.bytes) >= 65_536 && Number(r.scans) === 0,
    )
    expect(
      qualifying.length,
      `no exclusion index meets the query's own thresholds (>=64KiB, 0 scans); ` +
        `sizes/scans were ${JSON.stringify(candidates)} — the guard below cannot fail`,
    ).toBeGreaterThan(0)

    try {
      const res = await handler(ev({ session: platform(), query: { top: '50' } }))
      const listed = res.unusedIndexes.rows.map((r) => r.index)
      expect(listed.filter((n) => qualifying.some((q) => q.name === n))).toEqual([])
    } finally {
      // The fixture must not survive into the size/scan assertions elsewhere in
      // this file, which read the whole estate.
      await t.client.unsafe('DROP TABLE IF EXISTS excl_probe')
    }
  })
})

describe('GET /admin/diagnostics/db-performance — the observation window', () => {
  /*
   * Every counter on this page is a running total with no denominator of its
   * own. "68,400 sequential scans" is alarming over an hour and unremarkable
   * over a year, and a MAJOR VERSION UPGRADE resets them — so shortly after
   * one, an index used weekly is indistinguishable from a dead one. The window
   * is what makes the rest of the page interpretable rather than suggestive.
   */
  it('reports exactly what the database says the reset time is', async () => {
    const res = await handler(ev({ session: platform() }))
    expect(res.statsWindow).toBeTruthy()

    /*
     * stats_reset is NULLABLE — a database whose statistics have never been
     * reset reports null, which is a real state and not a failure. So this
     * asserts AGREEMENT with the database rather than presence of a value: a
     * "must be truthy" version passed only where the container happened to have
     * been reset, and said nothing about whether the query was right.
     */
    const [row] = [
      ...(await t.client<{ reset: string | null }[]>`
        SELECT stats_reset::text AS reset FROM pg_stat_database WHERE datname = current_database()`),
    ]
    const expected = row?.reset ? new Date(row.reset).toISOString() : null
    expect(res.statsWindow.databaseSince).toEqual(expected)

    /*
     * KNOWN BLIND SPOT, stated rather than papered over. A mutation replacing
     * the query with a hardcoded WRONG instant is caught by the line above. A
     * mutation hardcoding exactly `null` is NOT, whenever the container's own
     * stats_reset is null — which it usually is, since nothing resets it.
     *
     * Closing it would mean calling pg_stat_reset(), which wipes the per-table
     * counters the partition roll-up tests in this same file depend on. Trading
     * a real test for a stronger one is not an improvement, so the gap is
     * documented instead of hidden behind an assertion that looks stronger than
     * it is.
     */

    if (res.statsWindow.databaseSince) {
      // Never ahead of the payload's own clock.
      expect(Date.parse(res.statsWindow.databaseSince)).toBeLessThanOrEqual(Date.parse(res.generatedAt))
    }
    // The statements domain is separate and may be unknown; it must never be
    // silently filled from the database-wide value.
    expect(res.statsWindow.databaseSince).not.toBe(undefined)
    expect(res.statsWindow.available).toBe(true)
  })

  it('rides the settings read rather than adding a seventh transaction', async () => {
    /*
     * The handler deadline is exactly 6 x the per-read budget. A seventh read
     * would silently break that bound, so the window shares the settings
     * transaction — and therefore shares its availability. Pinned because the
     * coupling is invisible in the response.
     */
    const res = await handler(ev({ session: platform() }))
    expect(res.reads.settings.available).toBe(true)
    // The six declared reads, and only six — a seventh would break the
    // deadline bound the handler documents.
    
    expect(Object.keys(res.reads).sort()).toEqual(
      ['cache', 'sequentialScans', 'settings', 'sizes', 'statements', 'unusedIndexes'].sort(),
    )
  })
})

describe('GET /admin/diagnostics/db-performance — ANALYZE freshness', () => {
  /*
   * WHY THIS IS ON THE SCAN ROW and not a separate section: it is the column
   * that explains the one beside it. A table with a matching index and heavy
   * sequential scans looks identical whether the planner chose correctly or had
   * no statistics to choose with — and a MAJOR VERSION UPGRADE leaves it with
   * none until an ANALYZE runs. Without this the operator cannot tell those
   * apart, which is the position this probe existed to end.
   */
  it('reports when each table was last analysed, and how stale that is', async () => {
    const res = await handler(ev({ session: platform(), query: { top: '50' } }))
    const row = res.sequentialScans.find((s) => s.table === 'attribution_record')
    expect(row, 'attribution_record missing from sequentialScans').toBeTruthy()

    // The suite's own setup writes and reads these tables, so SOMETHING must be
    // reported — either an analyze timestamp or an explicit never-analysed count.
    expect(row!.lastAnalyzed !== null || row!.neverAnalyzed > 0).toBe(true)
    if (row!.lastAnalyzed) expect(Number.isNaN(Date.parse(row!.lastAnalyzed))).toBe(false)
    expect(row!.rowsChangedSinceAnalyze).toBeGreaterThanOrEqual(0)
  })

  it('rolls freshness up to the OLDEST partition, never the newest', async () => {
    /*
     * CONSTRUCTS the condition rather than hoping for it. A first version just
     * compared the parent against a MIN query and passed with the probe mutated
     * to MAX — because in a fresh testcontainer every partition is analysed in
     * the same sweep, so MIN and MAX were the same value and the assertion
     * could not tell them apart. Analysing ONE partition here forces them apart.
     */
    const parts = [
      ...(await t.client<{ part: string }[]>`
        SELECT (relid::regclass)::text AS part
          FROM pg_stat_user_tables
         WHERE COALESCE(pg_partition_root(relid), relid) = 'attribution_record'::regclass
           AND relid <> 'attribution_record'::regclass
         ORDER BY 1 LIMIT 2`),
    ]
    expect(parts.length, 'need two partitions to tell MIN from MAX').toBe(2)
    // TWO, sequentially. In a fresh container most partitions have never been
    // analysed at all, and MIN/MAX skip those NULLs — so analysing only one
    // leaves a single non-null value and MIN === MAX. (That is how the first
    // version of this test went vacuous.)
    await t.client.unsafe(`ANALYZE ${parts[0]!.part}`)
    // A gap WIDER THAN A MILLISECOND. Analysing two empty partitions back to
    // back put them 106 MICROseconds apart, and the probe reports ISO strings at
    // millisecond precision — so both rounded to the same instant and the
    // MIN/MAX assertion below could not fail. The API's precision is fine; the
    // test just has to exceed it.
    await t.client.unsafe(`SELECT pg_sleep(0.05)`)
    await t.client.unsafe(`ANALYZE ${parts[1]!.part}`)

    const [times] = [
      ...(await t.client<{ oldest: string | null; newest: string | null }[]>`
        SELECT MIN(GREATEST(last_analyze, last_autoanalyze))::text AS oldest,
               MAX(GREATEST(last_analyze, last_autoanalyze))::text AS newest
          FROM pg_stat_user_tables
         WHERE COALESCE(pg_partition_root(relid), relid) = 'attribution_record'::regclass`),
    ]
    // The precondition itself is asserted, so this test can never quietly go
    // vacuous again the way its first version did.
    expect(times?.oldest, 'no analyze times recorded').toBeTruthy()
    expect(
      Date.parse(times!.newest!) - Date.parse(times!.oldest!),
      'oldest and newest analyze times are identical — the roll-up cannot be tested',
    ).toBeGreaterThan(0)

    const res = await handler(ev({ session: platform(), query: { top: '50' } }))
    const row = res.sequentialScans.find((s) => s.table === 'attribution_record')!
    expect(row.lastAnalyzed).toBeTruthy()
    expect(Date.parse(row.lastAnalyzed!)).toBe(Date.parse(times!.oldest!))
    // The assertion that dies under MAX: a table plans only as well as its
    // least-analysed partition, so a freshly-analysed one must not mask it.
    expect(Date.parse(row.lastAnalyzed!)).not.toBe(Date.parse(times!.newest!))
  })
})

describe('GET /admin/diagnostics/db-performance — pg_stat_statements is a CONFIGURATION fact', () => {
  it('reports the extension as not loaded WITHOUT failing the probe, and says what would enable it', async () => {
    const res = await handler(ev({ session: platform() }))
    // The test container runs no shared_preload_libraries — the case this
    // branch exists for.
    expect(res.statements.extension.preloaded).toBe(false)
    expect(res.statements.extension.ready).toBe(false)
    expect(res.statements.rows).toEqual([])
    // THE POINT: "not configured" is not "the read failed".
    expect(res.reads.statements).toEqual({ available: true })
    expect(res.statements.extension.note).toContain('shared_preload_libraries')
    expect(res.statements.extension.note).toMatch(/restart/i)
    expect(res.statements.extension.note).toContain('CREATE EXTENSION pg_stat_statements')
  })

  it('separates "not preloaded" from "not installed" — creating the extension moves ONE of the two', async () => {
    // Dropped first: the boot step creates this extension, so "starts absent"
    // must be constructed rather than assumed.
    await t.client.unsafe('DROP EXTENSION IF EXISTS pg_stat_statements')
    const before = await handler(ev({ session: platform() }))
    expect(before.statements.extension.installed).toBe(false)

    await t.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')

    const after = await handler(ev({ session: platform() }))
    expect(after.statements.extension.installed).toBe(true)
    // …and the view still cannot be read, because the library is not loaded.
    // One boolean would have collapsed these into one indistinguishable state.
    expect(after.statements.extension.preloaded).toBe(false)
    expect(after.statements.extension.ready).toBe(false)
    expect(after.statements.rows).toEqual([])
    expect(after.reads.statements).toEqual({ available: true })
  })
})

describe('GET /admin/diagnostics/db-performance — an unavailable section never blanks its neighbours', () => {
  it('reports the failed read as unavailable, with a classified reason, and keeps the rest', async () => {
    // Third read = `cache` (statements, sequentialScans, cache, unusedIndexes,
    // sizes, settings — one withRequestRls transaction each, in that order).
    inject.failCall = 3
    const res = await handler(ev({ session: platform() }))

    expect(res.reads.cache.available).toBe(false)
    expect(res.reads.cache.error).toBe('relation-missing')
    // The correlation id is what makes the redaction lossless: it ties this
    // safe reason to the full-fidelity line in the server log.
    expect(res.reads.cache.errorCorrelationId).toMatch(/^[0-9a-f-]{36}$/)
    // An empty section and a FAILED one are the same bytes without the map
    // above — which is exactly why the map exists.
    expect(res.cache).toEqual([])

    for (const key of ['statements', 'sequentialScans', 'unusedIndexes', 'sizes', 'settings'] as const) {
      expect(res.reads[key], `reads.${key} must survive its neighbour's failure`).toEqual({ available: true })
    }
    expect(res.sequentialScans.length).toBeGreaterThan(0)
    expect(res.sizes.length).toBeGreaterThan(0)
    // The seven core settings always resolve. The two pg_stat_statements knobs
    // exist in pg_settings only when the library is loaded, so an exact count
    // would pass or fail on the container's configuration rather than on this
    // handler.
    for (const n of [
      'shared_buffers',
      'work_mem',
      'effective_cache_size',
      'max_connections',
      'log_min_duration_statement',
      'track_io_timing',
      'shared_preload_libraries',
    ]) {
      expect(res.settings.map((x) => x.name), `missing setting ${n}`).toContain(n)
    }
    expect(inject.calls).toBe(6)
  })

  it('does not 500 when the FIRST read fails — the handler still answers', async () => {
    inject.failCall = 1
    const res = await handler(ev({ session: platform() }))
    expect(res.reads.statements.available).toBe(false)
    expect(res.statements.rows).toEqual([])
    // The extension facts were never measured, so they say so rather than
    // claiming "not loaded" — a state the probe did not observe.
    expect(res.statements.extension.preloaded).toBeNull()
    expect(res.statements.extension.installed).toBeNull()
    expect(res.reads.sizes).toEqual({ available: true })
  })
})

describe('statement text — a credential must never travel', () => {
  /*
   * pg_stat_statements normalises constants out of ordinary statements, but
   * UTILITY statements are stored VERBATIM when `track_utility` is on (its
   * default) — and drizzle/provision-app-role.ts issues `ALTER ROLE … PASSWORD
   * '…'` against this very server. Driven through the route this branch is
   * unreachable (the test container loads no extension), which is exactly why
   * it is proven here instead of assumed.
   */
  it('withholds the TEXT of a statement carrying a password, and keeps the row', () => {
    const r = redactStatementText("ALTER ROLE app WITH PASSWORD 'hunter2'", 40)
    expect(r.textWithheld).toBe(true)
    expect(r.query).not.toContain('hunter2')
    expect(r.query).not.toMatch(/ALTER ROLE/)
  })

  it('leaves an ordinary statement alone, and flags truncation separately', () => {
    const q = 'SELECT * FROM attribution_record WHERE teammate_id = $1'
    expect(redactStatementText(q, q.length)).toEqual({ query: q, truncated: false, textWithheld: false })
    expect(redactStatementText(q, 5000).truncated).toBe(true)
  })

  it('does not fire on an identifier that merely CONTAINS the word', () => {
    // `password_hash` is not `password`: a word-boundary rule, so a legitimately
    // slow column lookup keeps its text and stays rankable.
    const q = 'SELECT id FROM account WHERE password_hash = $1'
    expect(redactStatementText(q, q.length).textWithheld).toBe(false)
  })
})

describe('GET /admin/diagnostics/db-performance — read-only', () => {
  it('never resets a counter and never runs EXPLAIN', () => {
    // Comments stripped first: the handler's header NAMES both prohibitions,
    // and a gate that punished the explanation would get the explanation
    // deleted (tests/helpers/strip-comments.ts).
    const src = stripComments(
      readFileSync(
        resolve(__dirname, '../../../server/api/v1/admin/diagnostics/db-performance.get.ts'),
        'utf8',
      ),
    )
    // Not a style preference: a reset would destroy the shared, cumulative
    // history every other operator's next run depends on, and an EXPLAIN of
    // caller-supplied text is arbitrary SQL execution.
    expect(src).not.toMatch(/pg_stat_statements_reset\s*\(/)
    expect(src).not.toMatch(/\bEXPLAIN\b/)
  })

  it('leaves the counters it read alone — two runs, and nothing went backwards', async () => {
    const a = await handler(ev({ session: platform(), query: { top: '50' } }))
    const b = await handler(ev({ session: platform(), query: { top: '50' } }))
    const seqOf = (r: DbPerfResp, table: string) =>
      r.sequentialScans.find((s) => s.table === table)?.seqScan ?? 0
    for (const table of ['attribution_record', PROBE_TABLE]) {
      expect(seqOf(b, table), `${table} seq_scan went backwards`).toBeGreaterThanOrEqual(seqOf(a, table))
    }
  })
})
