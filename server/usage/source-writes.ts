/*
 * The §A source-write inventory — ONE definition, two readers.
 *
 * A day is a candidate for recomputation when any table feeding
 * `v_complete_usage` was written for it more recently than that day's rollup
 * was built. Both the rollup worker (deciding what to recompute) and the read
 * gate (deciding whether the rollup may be trusted) need exactly that set, and
 * they need it to mean the same thing: the gate's safety rests on covering
 * every source the worker covers, so two hand-maintained copies of this list
 * is one §A source away from a gate that silently accepts stale money.
 *
 * So the arms live here and both callers parameterise them. Adding a source to
 * the lane means adding an arm HERE, and both readers get it.
 *
 * A note on what the timestamps can and cannot prove: these columns default to
 * now(), which PostgreSQL evaluates at TRANSACTION START, so a source
 * transaction that opens before a recompute and commits after it carries an
 * instant the recompute could not have seen. Both readers inherit that blind
 * spot equally. See docs/design/usage-rollup-lane.md for what would close it.
 */
import { sql, type SQL } from 'drizzle-orm'

export interface SourceWriteScope {
  /** Only writes at or after this instant. */
  since: SQL
  /** Restrict to one teammate; omitted = every teammate (the worker's view). */
  teammateId?: string
  /** Inclusive day bounds, when the reader only cares about part of history. */
  days?: { from: SQL; toInclusive: SQL }
}

/**
 * The `writes` relation: one row per (day, latest write instant) per arm.
 *
 * Wrapped by callers in their own `cand`/aggregation, because the worker wants
 * every day estate-wide while the gate wants an existence check for one
 * teammate inside one window.
 */
export function sourceWritesSql(scope: SourceWriteScope): SQL {
  const t = scope.teammateId
  const mine = (col: SQL) => (t ? sql` AND ${col} = ${t}::uuid` : sql``)
  const dayRange = (col: SQL) =>
    scope.days ? sql` AND ${col} >= ${scope.days.from} AND ${col} <= ${scope.days.toInclusive}` : sql``
  const lb = scope.since
  return sql`
    SELECT (ar.ts_event AT TIME ZONE 'UTC')::date AS day, MAX(ar.ts_recorded) AS w
      FROM attribution_record ar
     WHERE ar.ts_recorded >= ${lb}${mine(sql`ar.teammate_id`)}${dayRange(sql`(ar.ts_event AT TIME ZONE 'UTC')::date`)}
     GROUP BY 1
    UNION ALL
    SELECT a.date, MAX(a.pulled_at) FROM actual_spend a
     WHERE a.pulled_at >= ${lb}${mine(sql`a.teammate_id`)}${dayRange(sql`a.date`)}
     GROUP BY 1
    UNION ALL
    SELECT f.date, MAX(f.pulled_at) FROM provider_usage_fact f
     WHERE f.pulled_at >= ${lb}${mine(sql`f.teammate_id`)}${dayRange(sql`f.date`)}
     GROUP BY 1
    UNION ALL
    SELECT r.period_date, MAX(r.computed_at) FROM reconciliation_record r
     WHERE r.provider = 'github' AND r.scope = 'teammate'
       AND r.computed_at >= ${lb}${mine(sql`r.teammate_id`)}${dayRange(sql`r.period_date`)}
     GROUP BY 1
    UNION ALL
    SELECT uu.day, MAX(GREATEST(uu.computed_at, COALESCE(uu.tagged_at, uu.computed_at)))
      FROM unaccounted_usage uu
     WHERE GREATEST(uu.computed_at, COALESCE(uu.tagged_at, uu.computed_at)) >= ${lb}${mine(sql`uu.teammate_id`)}${dayRange(sql`uu.day`)}
     GROUP BY 1
  `
}

/**
 * The arms this inventory covers, by table name.
 *
 * Exported so a test can assert the list and the SQL agree — the failure this
 * module exists to prevent is a source being added to the lane and to only one
 * of the two readers, which no type can catch.
 */
export const SOURCE_WRITE_TABLES = [
  'attribution_record',
  'actual_spend',
  'provider_usage_fact',
  'reconciliation_record',
  'unaccounted_usage',
] as const
