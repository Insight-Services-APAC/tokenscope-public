/*
 * Activity list — the ONE union read behind `GET /me/activity` and its CSV
 * (design: docs/design/developer-pages-consolidation/04-fix-sprint-design.md
 * §F4, D17-D20). The contract, and why the list holds both row kinds, is
 * documented on `shared/schemas/activity.ts`; this module is the mechanism.
 *
 * ONE SORT KEY, AND IT IS THE UTC DAY (D18). The two kinds have different
 * natural grains — a conversation is an instant, a provider-recorded day is a
 * bucket — so the only key they can BOTH honestly answer is the UTC day. Within
 * a day the order is completed by a rank (sessions before the day-level record)
 * and, for sessions only, their last event; the day-level rows sort among
 * themselves on their id. Every leg is a real, stored value: nothing is
 * synthesised to make the sort work, which is the whole point.
 *
 * KEYSET, NOT OFFSET. The sort tuple is `(day, rank, ts, id)`, ALL DESCENDING —
 * deliberately uniform, so the resumption predicate is one Postgres row-value
 * comparison (`(...) < (...)`) rather than four hand-rolled OR-chains that drift.
 * The tuple is total: `id` is unique within a kind and `rank` separates the
 * kinds, so no two rows tie and no row can be skipped or repeated across pages.
 *
 * BOTH SIDES BOUNDED — A WORK BOUND, NOT A FAIRNESS ONE. Each branch applies the
 * SAME keyset predicate and its own `LIMIT n+1` before the union; the union then
 * re-sorts and takes n+1. Taking the global top-n from the per-branch top-n is
 * EXACT — it is the same page an unbounded union would produce, which is the
 * whole point: the bound changes what is READ, never what is RETURNED.
 *
 * So it is not a fairness device and this module does not claim one. A teammate
 * whose newest n records are all sessions gets a first page of all sessions, and
 * their provider-recorded days appear further down the SAME descending-day
 * order, exactly where the day they belong to falls. That is the ordering
 * contract, not starvation: nothing is dropped, and a walk of the pages reaches
 * every row of both kinds. A guarantee that each page held some of each kind
 * would be a different (and dishonest) list — it would have to reorder records
 * away from the one sort key they can both answer.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { z } from 'zod'
import { conversationKeyExpr } from '../db/conversation-key'
import { endedProjectExpr } from '../db/project-predicates'
import { timePhase } from '../observability/request-timing'
import { breakdownFields, fetchBreakdownCells, groupCells } from './breakdowns'
import {
  isRealUtcDay,
  type ActivityFilters,
  type ActivityProviderDayRow,
  type ActivityRow,
  type ActivitySessionRow,
} from '../../shared/schemas/activity'
import { ownDeviceNames } from '../utils/device-names'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * Within one UTC day, sessions sort ABOVE the provider-recorded day. Both legs
 * are DESC, so the session rank is the higher number. The rank also keeps the
 * `ts` leg from ever comparing across kinds — a provider day's `ts` is the empty
 * string (it has no instant), and that value is a sort placeholder that never
 * reaches the payload.
 */
const RANK_SESSION = 1
const RANK_PROVIDER_DAY = 0

/**
 * The instant format used for BOTH the session sort leg and the `ts_last` the
 * client renders — one expression, so the value the list is ordered on and the
 * value the reader sees can never be different instants.
 */
const TS_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)

export interface ActivityCursor {
  day: string
  rank: number
  ts: string
  id: string
}

const CursorTuple = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealUtcDay),
  z.number().int().min(0).max(1),
  z.string().max(64),
  z.string().max(256),
])

export function encodeActivityCursor(c: ActivityCursor): string {
  return Buffer.from(JSON.stringify([c.day, c.rank, c.ts, c.id]), 'utf8').toString('base64url')
}

/** Returns null for anything that is not a cursor this module minted. */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  try {
    const parsed = CursorTuple.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
    if (!parsed.success) return null
    const [day, rank, ts, id] = parsed.data
    return { day, rank, ts, id }
  } catch {
    return null
  }
}

/** The row-value comparison that resumes the scan. One predicate, both branches. */
function keysetPredicate(dayExpr: SQL, rank: number, tsExpr: SQL, idExpr: SQL, c: ActivityCursor): SQL {
  return sql`(${dayExpr}, ${sql.raw(String(rank))}::int, ${tsExpr}, ${idExpr})
             < (${c.day}::date, ${c.rank}::int, ${c.ts}::text, ${c.id}::text)`
}

interface UnionRow extends Record<string, unknown> {
  kind: string
  id: string
  sort_day: string
  sort_rank: number
  sort_ts: string
  day: string
  tool: string
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  activity: string | null
  /** NULL only on a provider day the provider reported no token quantity for. */
  tokens: string | null
  cost_usd: string
  attributed: boolean
  ts_last: string | null
  ts_first: string | null
  instance_id: string | null
  partly_ended: boolean | null
  ended_project_code: string | null
  dismissed: boolean | null
}

/** The page's ranked conversation keys; `legacyIds` are the instance-keyed ones. */
interface SessionKeys {
  ids: string[]
  legacyIds: string[]
}

function sessionWhere(teammateId: string, f: ActivityFilters): SQL[] {
  const where: SQL[] = [sql`ar.teammate_id = ${teammateId}::uuid`]
  if (f.tool) where.push(sql`ar.tool = ${f.tool}`)
  return where
}

/**
 * Phase 1: the newest n conversation keys, in list order. `sinceDay` bounds the
 * rows read; null reads the teammate's whole history.
 */
async function rankSessionKeysSince(
  tx: Tx,
  teammateId: string,
  f: ActivityFilters,
  c: ActivityCursor | null,
  n: number,
  sinceDay: string | null,
): Promise<{ id: string; legacy: boolean }[]> {
  const key = conversationKeyExpr('ar')
  const dayExpr = sql`(MAX(ar.ts_event) AT TIME ZONE 'UTC')::date`
  const tsExpr = sql`to_char(MAX(ar.ts_event) AT TIME ZONE 'UTC', ${TS_FORMAT})`

  const where = sessionWhere(teammateId, f)
  if (sinceDay) where.push(sql`ar.ts_event >= ${sinceDay}::timestamptz`)

  const having: SQL[] = []
  if (f.from) having.push(sql`${dayExpr} >= ${f.from}::date`)
  if (f.to) having.push(sql`${dayExpr} <= ${f.to}::date`)
  // A conversation can span projects; it matches a project filter if ANY of its
  // rows is on that project — the same "touched it" reading the row's own
  // project column already has.
  if (f.project) having.push(sql`bool_or(p.code = ${f.project})`)
  if (f.tagged === 'tagged') having.push(sql`bool_or(ar.project_id IS NOT NULL)`)
  if (f.tagged === 'untagged') having.push(sql`bool_or(ar.project_id IS NULL)`)
  if (c) having.push(keysetPredicate(dayExpr, RANK_SESSION, tsExpr, key, c))

  const rows = await tx.execute<{ id: string; legacy: boolean }>(sql`
    SELECT ${key} AS id, bool_or(ar.claude_session_id IS NULL) AS legacy
    FROM attribution_record ar
    ${f.project ? sql`LEFT JOIN project p ON p.id = ar.project_id` : sql``}
    WHERE ${sql.join(where, sql` AND `)}
    GROUP BY ${key}
    ${having.length ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``}
    -- The final sort minus its rank leg: rank is constant on this branch,
    -- so these three legs ARE the full order (§F6).
    ORDER BY ${dayExpr} DESC, ${tsExpr} DESC, ${key} DESC
    LIMIT ${n}
  `)
  return [...rows]
}

/**
 * The recent windows tried in turn, before reading the whole history (#593).
 * #611: 3 days first. A busy teammate fills a page well inside 3 days, and phase
 * 1 aggregates every row in its window, so the first window sets the cost of the
 * common page. A quiet teammate pays one more small read before the 14-day one.
 */
const RECENT_WINDOW_DAYS = [3, 14, 56] as const

function minusDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Phase 1, reading as little of the history as the answer allows (#593).
 *
 * THE WINDOW IS EXACT, NOT AN APPROXIMATION. A conversation with any row inside
 * the window has its true MAX(ts_event) inside it, because only older rows are
 * left out; a conversation with no row inside it ends before the window, so it
 * ranks below every conversation that has one. So a window that yields a full
 * page holds the same page an unbounded read would give.
 *
 * A window short of a full page proves nothing about what lies below it, so the
 * read widens once and then falls back to the whole history. The one shortcut:
 * when the `from` bound is inside the window, nothing older could match anyway.
 *
 * Project and tagged filters skip the window: their bool_or must see every row
 * of a conversation, and a window would let a row outside it change the answer.
 * Without `today` (no request clock) it reads the whole history.
 */
async function rankSessionKeys(
  tx: Tx,
  teammateId: string,
  f: ActivityFilters,
  c: ActivityCursor | null,
  n: number,
  today: string | undefined,
): Promise<SessionKeys> {
  const needsWholeConversation = Boolean(f.project) || f.tagged === 'tagged' || f.tagged === 'untagged'
  let ranked: { id: string; legacy: boolean }[] | null = null
  if (today && !needsWholeConversation) {
    // Any anchor gives an exact page; the earliest of these gives the smallest read.
    const anchor = [today, f.to, c?.day].filter((d): d is string => Boolean(d)).sort()[0]!
    for (const days of RECENT_WINDOW_DAYS) {
      const sinceDay = minusDays(anchor, days)
      const rows = await rankSessionKeysSince(tx, teammateId, f, c, n, sinceDay)
      if (rows.length >= n || (f.from && f.from >= sinceDay)) {
        ranked = rows
        break
      }
    }
  }
  ranked ??= await rankSessionKeysSince(tx, teammateId, f, c, n, null)
  return { ids: ranked.map((r) => r.id), legacyIds: ranked.filter((r) => r.legacy).map((r) => r.id) }
}

/**
 * The OTel-observed conversations. Grouped on the shared conversation key, so a
 * subagent never becomes its own row and a legacy instance-keyed conversation
 * still appears. The sort day is the day of the conversation's LAST event —
 * the same instant the row displays, so the order can never look random.
 *
 * TWO PHASES (docs/design/request-floor-performance.md §F6, #593). The from/to
 * bounds and the keyset cursor compare against MAX(ts_event), so they can only
 * live in HAVING. Phase 1 (`rankSessionKeys`) ranks conversation keys with the
 * slimmest aggregate that can answer the HAVING + ORDER BY and takes the page's
 * n keys. Phase 2 (this statement) builds the full row shape for only those
 * keys, so each conversation's totals are whole. Both phases apply the same
 * WHERE quals and group on the same key, so the output is row-identical to the
 * single aggregate it replaces.
 *
 * NOT FOLDED WITH THE CELLS (#611). PR 622 read the page's rows once in a CTE
 * and built both these totals and fetchBreakdownCells' model cells from it. On
 * dev that one statement took about 480 ms against about 300 + 115 for the two
 * separate reads, so the cells are read apart again (`act-breakdowns`).
 */
function sessionsStatement(teammateId: string, f: ActivityFilters, keys: SessionKeys, n: number): SQL {
  const key = conversationKeyExpr('ar')
  const dayExpr = sql`(MAX(ar.ts_event) AT TIME ZONE 'UTC')::date`
  const tsExpr = sql`to_char(MAX(ar.ts_event) AT TIME ZONE 'UTC', ${TS_FORMAT})`

  const where = sessionWhere(teammateId, f)
  const idList = sql.join(keys.ids.map((id) => sql`${id}`), sql`, `)
  // The OR-of-two-equalities shape conversation-key.ts documents, never
  // COALESCE(...) IN (...). The legacy arm (pre-0016 rows only) is written only
  // when this page has a legacy conversation: an OR with a cast arm cannot use
  // the session index, so it would walk all the teammate's rows for nothing.
  const legacyArm = keys.legacyIds.length
    ? sql`OR (ar.claude_session_id IS NULL AND ar.instance_id::text IN (${sql.join(
        keys.legacyIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`
    : sql``
  const rankedKeyFilter = sql`(ar.claude_session_id IN (${idList}) ${legacyArm})`

  return sql`
    SELECT * FROM (
      SELECT
        'session'::text                       AS kind,
        ${key}                                AS id,
        ${dayExpr}                            AS sort_day,
        ${sql.raw(String(RANK_SESSION))}::int AS sort_rank,
        ${tsExpr}                             AS sort_ts,
        ${dayExpr}::text                      AS day,
        MAX(ar.tool)                          AS tool,
        /*
         * ONE project, picked ONCE. A conversation can span projects, and three
         * independent MAX()es picked three times: MAX(project_id) ranks by uuid
         * TEXT while MAX(code)/MAX(display_name) rank by code, so a two-project
         * conversation could return one project's id beside another's code --
         * a tuple naming no project that exists. It reaches the card, the CSV
         * and (worse) the re-tag dialog, which pre-selects project_id.
         *
         * So all three read the SAME ordering and therefore the SAME row:
         * greatest p.code among the projects this conversation actually touched.
         * project.code is UNIQUE (drizzle/schema/projects.ts), so the order is
         * total and the pick is deterministic, not merely usually-consistent.
         * The FILTER drops the untagged rows -- their p.* are NULL, and DESC
         * sorts NULLS FIRST, which would otherwise hand back "no project" for a
         * conversation that has one.
         *
         * The "touched it" project FILTER above is unchanged and still means
         * what it says: a row matching project=X may display project Y, because
         * the conversation is on both. One record cannot name two projects.
         */
        (array_agg(ar.project_id::text ORDER BY p.code DESC)
           FILTER (WHERE ar.project_id IS NOT NULL))[1]   AS project_id,
        (array_agg(p.code ORDER BY p.code DESC)
           FILTER (WHERE ar.project_id IS NOT NULL))[1]   AS project_code,
        (array_agg(p.display_name ORDER BY p.code DESC)
           FILTER (WHERE ar.project_id IS NOT NULL))[1]   AS project_display_name,
        MAX(ar.activity)                      AS activity,
        SUM(ar.tokens)::text                  AS tokens,
        SUM(ar.cost_usd)::text                AS cost_usd,
        bool_or(ar.project_id IS NOT NULL)    AS attributed,
        ${tsExpr}                             AS ts_last,
        MIN(ar.ts_event)::text                AS ts_first,
        MAX(ar.instance_id::text)             AS instance_id,
        (bool_or(${endedProjectExpr('p')})
         AND bool_or(NOT (${endedProjectExpr('p')}))) AS partly_ended,
        MAX(p.code) FILTER (WHERE ${endedProjectExpr('p')}) AS ended_project_code,
        NULL::boolean                         AS dismissed
      FROM attribution_record ar
      LEFT JOIN project p ON p.id = ar.project_id
      -- The teammate and tool quals of phase 1, WITHOUT its recent window, so
      -- each ranked key regroups every row of that conversation. Every HAVING
      -- fact phase 1 established still holds and is not re-checked here (§F6).
      WHERE ${sql.join(where, sql` AND `)}
        AND ${rankedKeyFilter}
      GROUP BY ${key}
    ) s
    ORDER BY s.sort_day DESC, s.sort_rank DESC, s.sort_ts DESC, s.id DESC
    LIMIT ${n}
  `
}

/**
 * The two branches' rows in the one list order. Each branch arrives already in
 * that order, and a session and a provider day never tie: on one day their
 * ranks differ. So a stable sort on day then rank interleaves them exactly as
 * the single ORDER BY over their UNION did, without comparing ids in JS (whose
 * order could differ from the database's collation).
 */
function mergeBranches(sessions: UnionRow[], days: UnionRow[], n: number): UnionRow[] {
  return [...sessions, ...days]
    .sort((a, b) => {
      const da = a.sort_day.slice(0, 10)
      const db = b.sort_day.slice(0, 10)
      if (da !== db) return da < db ? 1 : -1
      return Number(b.sort_rank) - Number(a.sort_rank)
    })
    .slice(0, n)
}

/**
 * The provider-recorded days — EVERY one of them, tagged or not, dismissed or
 * not. That is the fix: `unaccounted_usage` rows leave the worklist the moment
 * they are decided, and before this list existed that made them unfindable.
 *
 * WHAT COUNTS AS A RECORD: money OR tokens. `cost_usd` and `tokens` are two
 * INDEPENDENT residuals — the writer takes `GREATEST(0, api − otel)` of each
 * separately (unaccounted-reconciliation.ts), so a day whose dollars are fully
 * corroborated while its token count is not lands as `cost_usd = 0,
 * tokens > 0`. That is a provider-recorded day with a measured quantity on it,
 * and the previous `cost_usd > 0` alone silently dropped it from a list whose
 * whole claim is that it holds every provider-recorded day — the NULL-vs-0
 * defect wearing the other axis. Both zero stays out: that is the reconciliation
 * artefact (an orphan the reconciler zeroed but kept for its tagging decision),
 * a record of nothing the teammate did.
 */
function providerDaysBranch(teammateId: string, f: ActivityFilters, c: ActivityCursor | null, n: number): SQL {
  const where: SQL[] = [sql`u.teammate_id = ${teammateId}::uuid`, sql`(u.cost_usd > 0 OR u.tokens > 0)`]
  if (f.tool) where.push(sql`u.tool = ${f.tool}`)
  if (f.from) where.push(sql`u.day >= ${f.from}::date`)
  if (f.to) where.push(sql`u.day <= ${f.to}::date`)
  if (f.project) where.push(sql`p.code = ${f.project}`)
  if (f.tagged === 'tagged') where.push(sql`u.project_id IS NOT NULL`)
  if (f.tagged === 'untagged') where.push(sql`u.project_id IS NULL`)
  if (c) where.push(keysetPredicate(sql`u.day`, RANK_PROVIDER_DAY, sql`''::text`, sql`u.id::text`, c))

  return sql`
    SELECT
      'provider-day'::text                        AS kind,
      u.id::text                                  AS id,
      u.day                                       AS sort_day,
      ${sql.raw(String(RANK_PROVIDER_DAY))}::int  AS sort_rank,
      ''::text                                    AS sort_ts,
      u.day::text                                 AS day,
      u.tool                                      AS tool,
      u.project_id::text                          AS project_id,
      p.code                                      AS project_code,
      p.display_name                              AS project_display_name,
      u.activity                                  AS activity,
      -- NULL = "the provider never reported a token quantity for this day",
      -- which is not the same fact as zero. See the api CTE below.
      CASE WHEN api.tokens_reported IS FALSE THEN NULL ELSE u.tokens::text END AS tokens,
      u.cost_usd::text                            AS cost_usd,
      (u.project_id IS NOT NULL)                  AS attributed,
      NULL::text                                  AS ts_last,
      NULL::text                                  AS ts_first,
      NULL::text                                  AS instance_id,
      NULL::boolean                               AS partly_ended,
      NULL::text                                  AS ended_project_code,
      (u.dismissed_at IS NOT NULL)                AS dismissed
    FROM unaccounted_usage u
    LEFT JOIN project p ON p.id = u.project_id
    /*
     * DID THE PROVIDER MEASURE TOKENS FOR THIS KEY AT ALL?
     * (No backticks in this literal: one inside a SQL comment closes the
     * template and the parse error points at the wrong line entirely.)
     *
     * unaccounted_usage.tokens is NOT NULL DEFAULT 0, and the writer feeds it
     * COALESCE(api_tokens, 0) -- so the "no quantity was ever reported" fact is
     * already flattened by the time it is stored. For Copilot that is EVERY row:
     * v_teammate_usage_daily's GitHub arm is literally
     *   NULL::bigint AS tokens -- copilot is metered in ai-credits, not tokens
     * (mig 0101), because ai_credit/usage reports no token quantity. Shipping
     * the stored 0 puts a measured-looking zero on the wire for something never
     * measured, and the reader cannot tell it from a real zero.
     *
     * So the ONE source the residual was computed FROM is asked the one question
     * the residual cannot answer. bool_or over the (teammate, day, tool) key:
     * FALSE = backed, and no arm reported tokens, so the wire says null. TRUE or
     * NULL (no backing row -- an orphan the reconciler has not yet reached)
     * keeps the stored value: a residual that WAS measured, or a zeroed orphan,
     * and inventing "unknown" for those would be the same fabrication mirrored.
     *
     * An aggregate with no GROUP BY always returns exactly one row, so this
     * LATERAL can never drop a day. Both source tables are keyed on
     * (teammate, date, ...) and neither carries RLS, so it is an index lookup
     * per row of a page already bounded to n + 1.
     */
    LEFT JOIN LATERAL (
      SELECT bool_or(d.tokens IS NOT NULL) AS tokens_reported
        FROM v_teammate_usage_daily d
       WHERE d.teammate_id = u.teammate_id AND d.day = u.day AND d.tool = u.tool
    ) api ON TRUE
    WHERE ${sql.join(where, sql` AND `)}
    -- The id leg as TEXT, as the keyset predicate and the list's sort compare
    -- it: this branch's order is now the list's order within a day (#611).
    ORDER BY u.day DESC, u.id::text DESC
    LIMIT ${n}
  `
}

function toRow(r: UnionRow): ActivityRow {
  const cursor = encodeActivityCursor({
    day: r.sort_day.slice(0, 10),
    rank: Number(r.sort_rank),
    ts: r.sort_ts ?? '',
    id: r.id,
  })
  const base = {
    id: r.id,
    day: r.day,
    tool: r.tool,
    project_id: r.project_id,
    project_code: r.project_code,
    project_display_name: r.project_display_name,
    activity: r.activity,
    // `Number(null)` is 0 — the exact coercion this column exists to avoid.
    tokens: r.tokens === null ? null : Number(r.tokens),
    cost_usd: Number(r.cost_usd).toFixed(2),
    attributed: r.attributed,
    cursor,
  }
  if (r.kind === 'session') {
    return {
      ...base,
      kind: 'session',
      // Both non-null by construction on this branch — the union widened the
      // columns. A session's tokens are OTel-observed: always a measurement.
      tokens: Number(r.tokens),
      ts_last: r.ts_last!,
      ts_first: r.ts_first ?? r.ts_last!,
      instance_id: r.instance_id,
      device_name: null,
      partly_ended: r.partly_ended ?? false,
      ended_project_code: r.ended_project_code,
    } satisfies ActivitySessionRow
  }
  return {
    ...base,
    kind: 'provider-day',
    dismissed: r.dismissed ?? false,
  } satisfies ActivityProviderDayRow
}

/**
 * One page of Activity. `limit` is the page size; the read asks for one extra
 * row to answer `has_more` without a second count query (and without ever
 * claiming a total, which this list does not have — D19).
 *
 * `withBreakdowns` adds the per-conversation model mix for the SESSION rows on
 * the page (bounded by the page size). The CSV does not need it.
 */
export async function fetchActivityPage(
  tx: Tx,
  teammateId: string,
  f: ActivityFilters,
  opts: {
    limit: number
    cursor?: string | null
    withBreakdowns?: boolean
    withDeviceNames?: boolean
    /** The request clock's UTC day; it anchors the recent-window read (#593). */
    today?: string
  },
): Promise<{ rows: ActivityRow[]; hasMore: boolean; nextCursor: string | null }> {
  const cursor = opts.cursor ? decodeActivityCursor(opts.cursor) : null
  if (opts.cursor && !cursor) throw new Error('activity-list: invalid cursor')

  const probe = opts.limit + 1
  let sessions: UnionRow[] = []
  let days: UnionRow[] = []
  let legacyIds: string[] = []
  if (f.kind === 'all' || f.kind === 'session') {
    const sessionKeys = await timePhase('act-rank', () =>
      rankSessionKeys(tx, teammateId, f, cursor, probe, opts.today),
    )
    legacyIds = sessionKeys.legacyIds
    if (sessionKeys.ids.length) {
      sessions = [
        ...(await timePhase('act-sessions', () =>
          tx.execute<UnionRow>(sessionsStatement(teammateId, f, sessionKeys, probe)),
        )),
      ]
    }
  }
  if (f.kind === 'all' || f.kind === 'provider-day') {
    // A statement of its own (it was the other half of a UNION), so its time is
    // named apart from the sessions' (#611). The route's repeatable-read
    // transaction gives both statements one snapshot, as the UNION had.
    days = [...(await timePhase('act-days', () => tx.execute<UnionRow>(providerDaysBranch(teammateId, f, cursor, probe))))]
  }

  const all = mergeBranches(sessions, days, probe)
  const hasMore = all.length > opts.limit
  const page = all.slice(0, opts.limit).map(toRow)

  if (opts.withBreakdowns) {
    const convIds = page.filter((r) => r.kind === 'session').map((r) => r.id)
    if (convIds.length) {
      const legacy = new Set(legacyIds)
      const cells = groupCells(
        await timePhase('act-breakdowns', () =>
          fetchBreakdownCells(tx, teammateId, convIds, convIds.filter((id) => legacy.has(id))),
        ),
      )
      for (const r of page) {
        if (r.kind === 'session') Object.assign(r, breakdownFields(cells.get(r.id) ?? []))
      }
    }
  }

  /*
   * The caller's own device names (#576) for the page's sessions. The page read
   * only: the CSV export never asks, so a name cannot reach a file.
   */
  if (opts.withDeviceNames) {
    const names = await timePhase('act-names', () =>
      ownDeviceNames(
        tx,
        teammateId,
        page.map((r) => (r.kind === 'session' ? r.instance_id : null)),
      ),
    )
    for (const r of page) {
      if (r.kind === 'session' && r.instance_id) r.device_name = names.get(r.instance_id) ?? null
    }
  }

  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && page.length ? (page[page.length - 1]!.cursor ?? null) : null,
  }
}

/**
 * Every row matching the filters, up to `limit`, for the CSV. Walks the SAME
 * keyset the page does rather than re-implementing a bulk query, so "the CSV
 * matches what you are looking at" (D20) is true by construction and not by
 * two queries agreeing.
 */
export async function fetchActivityForExport(
  tx: Tx,
  teammateId: string,
  f: ActivityFilters,
  limit: number,
  today?: string,
): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: string | null = null
  // Page size is capped so one enormous export cannot become one enormous query.
  const step = 500
  while (out.length < limit) {
    const page: Awaited<ReturnType<typeof fetchActivityPage>> = await fetchActivityPage(tx, teammateId, f, {
      limit: Math.min(step, limit - out.length),
      cursor,
      today,
    })
    out.push(...page.rows)
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }
  return out
}
