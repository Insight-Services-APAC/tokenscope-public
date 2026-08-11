/*
 * freshness — "as fresh as its stalest source", for pages that mix a live lane
 * read with a materialised one.
 *
 * The project surfaces read `v_complete_usage` LIVE for every month figure, but
 * still read `attribution_aggregate` for the 30/90-day series, the model /
 * token-lane mix and the velocity flag (the list/series perf contract, brief
 * §6.5). That aggregate is refreshed by cron, so those panels legitimately lag.
 *
 * The defect this closes is not the lag — it is the SILENCE. A cron-refreshed
 * headline rendered 400px above a live table, with nothing on screen saying so,
 * is what made two numbers on one page look like a bug in the product rather
 * than two clocks. /me/consumption already publishes a worst-of-sources line;
 * these helpers are that same computation, extracted so a second surface cannot
 * implement it differently.
 *
 * ── FRESHNESS IS AN INGESTION CLOCK, NOT AN EVENT CLOCK ─────────────────────
 * Only the aggregate helpers measure freshness. "How stale is this panel" is a
 * question about when the DATA WAS WRITTEN, and `attribution_aggregate.refresh_at`
 * is exactly that — the rollup's own write time.
 *
 * The age of the newest EVENT is a different quantity and is named for what it
 * is ({@link latestUsageEventMinutes}). A reconciliation written thirty seconds
 * ago for yesterday's usage is FRESH data about an old event: reporting it as
 * "a day stale" would be false, and it is why that figure is not folded into
 * the worst-of line. It is published beside it because "the rollup ticked ten
 * minutes ago and the newest thing on the lane is four days old" is a useful,
 * and different, sentence.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import type { AggScope } from './consumption'

type AnyDb = PostgresJsDatabase<typeof schema> | PostgresJsDatabase<Record<string, unknown>>

/** Minutes since the aggregate rollup last wrote a row for this scope; null = never. */
export async function aggregateFreshnessMinutes(
  db: AnyDb,
  scope: AggScope,
  scopeId: string,
): Promise<number | null> {
  const rows = await db.execute<{ minutes: string | null }>(sql`
    SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MAX(refresh_at))) / 60)::text AS minutes
    FROM attribution_aggregate
    WHERE scope_type = ${scope} AND scope_id = ${scopeId}::uuid
  `)
  const raw = [...rows][0]?.minutes
  return raw == null ? null : Number(raw)
}

/** The stalest rollup across a SET of scopes, and how many have never run. */
export interface ScopeSetFreshness {
  /**
   * Minutes since the OLDEST of the scopes was last rolled up — the stalest,
   * not the freshest. null when none of them has ever been rolled up.
   */
  stalestMinutes: number | null
  /**
   * Scopes with NO rollup row at all. Their staleness is UNKNOWN and unbounded;
   * they are counted rather than dropped, because an aggregate over the others
   * hides them behind whichever scope happens to be freshest.
   */
  neverRefreshed: number
}

/**
 * Rollup freshness across MANY scopes, reported by its STALEST member.
 *
 * The contract is "as fresh as its stalest source", so this is a MIN over
 * `refresh_at` (⇒ a MAX over age). A MAX over `refresh_at` is the exact
 * inverse: it reports the freshest scope and hides every project whose rollup
 * is oldest — the ones the disclosure exists for. And a scope with no rollup
 * row is invisible to either aggregate, so it is counted separately instead of
 * being silently excluded from a claim about all of them.
 */
export async function aggregateSetFreshness(
  db: AnyDb,
  scope: AggScope,
  scopeIds: readonly string[],
): Promise<ScopeSetFreshness> {
  if (scopeIds.length === 0) return { stalestMinutes: null, neverRefreshed: 0 }
  const rows = await db.execute<{ minutes: string | null; never_refreshed: string }>(sql`
    SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(agg.refresh_at))) / 60)::text AS minutes,
           COUNT(*) FILTER (WHERE agg.refresh_at IS NULL)::text AS never_refreshed
      FROM unnest(ARRAY[${sql.join(
        scopeIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) AS s(scope_id)
      LEFT JOIN LATERAL (
        SELECT MAX(a.refresh_at) AS refresh_at
          FROM attribution_aggregate a
         WHERE a.scope_type = ${scope} AND a.scope_id = s.scope_id
      ) agg ON TRUE
  `)
  const r = [...rows][0]
  return {
    stalestMinutes: r?.minutes == null ? null : Number(r.minutes),
    neverRefreshed: Number(r?.never_refreshed ?? 0),
  }
}

/**
 * Minutes since the newest §A event on a project's lane; null = no spend.
 *
 * NOT a freshness measure — see the module header. This is the age of the
 * newest EVENT, so a quiet project reads as old even when its data was written
 * seconds ago. Rendered under its own words ("latest usage event"), never as
 * "how stale is this page", and never folded into a worst-of-sources figure.
 *
 * Clamped at 0: the lane can carry future-dated rows (a provider day-grain row
 * bins to 00:00Z of a day still in progress), and a negative age is not a
 * quantity any surface can render honestly.
 */
export async function latestUsageEventMinutes(
  db: AnyDb,
  projectId: string,
): Promise<number | null> {
  const rows = await db.execute<{ minutes: string | null }>(sql`
    -- The CASE is load-bearing: GREATEST() IGNORES nulls, so a bare
    -- GREATEST(0, <null>) turns "this project has no spend" into "0 minutes
    -- ago", which is the most reassuring possible reading of no data at all.
    SELECT CASE WHEN MAX(u.ts_event) IS NULL THEN NULL
                ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MAX(u.ts_event))) / 60))
           END::text AS minutes
    FROM v_complete_usage u
    WHERE u.project_id = ${projectId}::uuid
  `)
  const raw = [...rows][0]?.minutes
  return raw == null ? null : Number(raw)
}

/** The stalest leg, ignoring absent ones. null when nothing is measurable. */
export function worstFreshness(legs: (number | null)[]): number | null {
  const known = legs.filter((m): m is number => m != null)
  return known.length ? Math.max(...known) : null
}
