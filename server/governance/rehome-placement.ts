/*
 * rehome-placement — when an admin corrects where a person sits, move what they
 * already spent with them.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * `bulk-place` can re-home hundreds of teammates in one call. It wrote
 * `teammate.org_unit_id` and touched NO spend row, and every read takes the
 * stamp written when the row was created — so a corrected person kept reporting
 * under the wrong region and Business Unit forever. The only remedy was to
 * rebuild the database.
 *
 * ── THE RULE (owner, 2026-08-10) ─────────────────────────────────────────────
 * WHO changed the placement decides whether history follows. The data cannot
 * tell a reorg from a correction, but the system always knows who made the
 * change:
 *
 *   directory / graph sync  the person genuinely moved team. History STAYS —
 *                           a reorg must not hand February's consumption to
 *                           March's Business Unit.
 *   admin manual move       a human correcting a mis-placement. History
 *                           FOLLOWS — the BU that consumed it was misidentified,
 *                           and the record was always wrong.
 *
 * The exclusion is asserted, not assumed: a gate fails if anything under
 * `server/reconciliation/**` or `server/workers/**` imports this module.
 *
 * ── WHY server/governance/ ───────────────────────────────────────────────────
 * The reporting lane firewall forbids `attribution_record` and `actual_spend`
 * anywhere under `server/reporting/**`, and this writes both. Same reason
 * `rehome-spend.ts` lives here — a lesson learned by tripping that gate.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ──────────────────────────────────────
 *   region_id                             both doors are intra-region by
 *                                         construction; cross-region moves go
 *                                         through the region PATCH.
 *   attribution_record.cost_owning_unit_id  that column is the PROJECT's BU and
 *                                         is Migrate's axis. Writing it here
 *                                         would silently re-home project spend
 *                                         on a person move.
 *   provider_usage_fact                   the billed lane. §B homing is its own
 *                                         decision, not a side effect.
 *
 * `actual_spend.cost_owning_unit_id` and `reconciliation_record.cost_owning_unit_id`
 * ARE written: on those tables the column is the TEAMMATE's nearest cost-owning
 * unit at ingest, so a teammate correction owns it.
 *
 * ── PHASE 2 IS A PREREQUISITE ────────────────────────────────────────────────
 * `unaccounted_usage` used to refresh placement from CURRENT placement on every
 * recompute over a trailing 35-day window. Without that fixed first, a
 * date-floored correction here is silently undone within the hour.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/*
 * The loose schema generic, matching `place-teammate.ts` — its transaction is
 * the one this runs inside, and every statement here is raw `sql` anyway.
 */
type Tx = PostgresJsDatabase<Record<string, unknown>>

/** All recorded history, or everything from a day forward. */
export type RehomePlacementRange = { from: 'all' } | { from: string }

export interface RehomePlacementResult {
  attributionRows: number
  unaccountedRows: number
  overEmissionRows: number
  actualSpendRows: number
  reconciliationRows: number
  rollupRows: number
}

const SENTINEL = '00000000-0000-0000-0000-000000000000'

/** One Business Unit this teammate's recorded history currently sits under. */
export interface PlacementSpanSource {
  orgUnitId: string | null
  displayName: string | null
  usd: number
  firstDay: string
  lastDay: string
}

export interface PlacementSpan {
  /** Distinct Business Units the selected history spans, largest first. */
  sources: PlacementSpanSource[]
  usd: number
  /** True when the history sits under more than one BU — see below. */
  spansMultipleUnits: boolean
}

/**
 * What an admin correction WOULD move, read-only.
 *
 * Reads `v_complete_usage` — the §A lane the Business Units page itself reads —
 * so the figure previewed is the figure that will move on the page the operator
 * is looking at. Not `attribution_record`: that is one of three arms, and a
 * preview covering a third of the money would understate the correction.
 *
 * MONEY AND DAYS, NOT ROWS. The view fans one key into several rows (0123-0125
 * remainders), so a row count would be an artefact of the fan-out. Dollar totals
 * are invariant across it; row counts are not.
 *
 * `spansMultipleUnits` is the operator's actual warning. Somebody whose history
 * already sits under three BUs was probably moved legitimately in the past, and
 * "all history" collapses those three into one — which is right for a correction
 * and wrong for a reorg. The product cannot tell which from the data, so it
 * shows the span and lets the human decide.
 */
export async function planRehomePlacement(
  tx: Tx,
  opts: { teammateId: string; range: RehomePlacementRange },
): Promise<PlacementSpan> {
  const floor = opts.range.from === 'all' ? null : opts.range.from
  const since = floor === null ? sql`TRUE` : sql`(v.ts_event AT TIME ZONE 'UTC')::date >= ${floor}::date`

  const rows = [
    ...(await tx.execute<{
      org_unit_id: string | null
      display_name: string | null
      usd: string
      first_day: string
      last_day: string
    }>(sql`
      SELECT v.org_unit_id::text                                   AS org_unit_id,
             ou.display_name                                       AS display_name,
             COALESCE(SUM(v.cost_usd), 0)::text                    AS usd,
             MIN((v.ts_event AT TIME ZONE 'UTC')::date)::text      AS first_day,
             MAX((v.ts_event AT TIME ZONE 'UTC')::date)::text      AS last_day
        FROM v_complete_usage v
        LEFT JOIN org_unit ou ON ou.id = v.org_unit_id
       WHERE v.teammate_id = ${opts.teammateId}::uuid AND ${since}
       GROUP BY 1, 2
       -- By the NUMERIC sum, not the ::text projection: text orders "9" above
       -- "10", which would put the smallest BU at the top of the warning.
       ORDER BY SUM(v.cost_usd) DESC NULLS LAST`)),
  ]

  const sources = rows.map((r) => ({
    orgUnitId: r.org_unit_id,
    displayName: r.display_name,
    usd: Number(r.usd),
    firstDay: r.first_day,
    lastDay: r.last_day,
  }))

  return {
    sources,
    usd: sources.reduce((a, s) => a + s.usd, 0),
    spansMultipleUnits: sources.length > 1,
  }
}

/**
 * Move a teammate's recorded placement onto `toOrgUnitId`.
 *
 * MUST run inside the caller's transaction, alongside the `UPDATE teammate`
 * that motivated it: a re-home that commits without its move (or the reverse)
 * leaves the ledger disagreeing with the org.
 */
export async function rehomePlacement(
  tx: Tx,
  opts: { teammateId: string; toOrgUnitId: string; range: RehomePlacementRange },
): Promise<RehomePlacementResult> {
  const { teammateId, toOrgUnitId, range } = opts
  const floor = range.from === 'all' ? null : range.from
  const since = (col: string) => (floor === null ? sql`TRUE` : sql`${sql.raw(col)} >= ${floor}::date`)

  /*
   * `IS DISTINCT FROM` on every predicate: a row already on the target is not a
   * change, and counting it would inflate what the operator is told moved.
   */
  const notAlready = sql`org_unit_id IS DISTINCT FROM ${toOrgUnitId}::uuid`

  /*
   * ── attribution_record — EVERY ROW THAT EXISTS ─────────────────────────────
   * This used to skip days below the archive floor, on the reasoning that the
   * raw rows were gone there and the rollup carried the history instead. That
   * reasoning was wrong in the case that matters: the floor says when a day
   * BECOMES eligible for archiving, not that it HAS been archived. Archiving
   * can be disabled, or simply not have run for the partition yet — and arm 1
   * of `v_complete_usage` reads `attribution_record` directly. So a skipped row
   * that still exists means the rollup says the new Business Unit while every
   * §A report says the old one, permanently.
   *
   * An UPDATE that matches nothing costs nothing, so there is no reason to
   * guess. `ts_recorded` is bumped so the aggregate worker's incremental window
   * notices and rebuilds those days from raw — writing the same values this
   * just wrote.
   */
  const attribution = await tx.execute<{ id: string }>(sql`
    UPDATE attribution_record
       SET org_unit_id = ${toOrgUnitId}::uuid, ts_recorded = now()
     WHERE teammate_id = ${teammateId}::uuid
       AND ${since('ts_event')} AND ${notAlready}
    RETURNING id::text AS id`)

  const unaccounted = await tx.execute<{ id: string }>(sql`
    UPDATE unaccounted_usage SET org_unit_id = ${toOrgUnitId}::uuid
     WHERE teammate_id = ${teammateId}::uuid AND ${since('day')} AND ${notAlready}
    RETURNING id::text AS id`)

  const overEmission = await tx.execute<{ id: string }>(sql`
    UPDATE over_emission SET org_unit_id = ${toOrgUnitId}::uuid
     WHERE teammate_id = ${teammateId}::uuid AND ${since('day')} AND ${notAlready}
    RETURNING id::text AS id`)

  /*
   * ── THE COST-OWNING UNIT IS NOT ALWAYS THE TARGET ──────────────────────────
   * `PATCH .../org-unit` uses the `any-active-unit` target policy on purpose —
   * placing somebody on a plain team node is legitimate. But
   * `cost_owning_unit_id` means "the unit this money bills to", and a plain team
   * node bills to nothing: writing the target there would invent a Business Unit
   * that no report clamps on and no owner can see.
   *
   * So it resolves to the NEAREST ACTIVE COST-OWNING ANCESTOR of the target,
   * which is the same walk the ingest path does — `@>` on the ltree, ordered by
   * depth, closest first. NULL when the ancestry has none, which is exactly what
   * the diagnostics page's `no-cost-owning-ancestor` bucket is for; inventing a
   * value would hide the gap it exists to report.
   */
  const nearestCostOwning = sql`(
    SELECT anc.id FROM org_unit anc, org_unit tgt
     WHERE tgt.id = ${toOrgUnitId}::uuid
       AND anc.path @> tgt.path
       AND anc.region_id = tgt.region_id
       AND anc.is_cost_owning_unit
       AND anc.retired_at IS NULL
     ORDER BY nlevel(anc.path) DESC
     LIMIT 1)`

  /*
   * `dimension_source` records that a human moved this, not the directory —
   * the same way `legacy-current-placement` records rows whose point-in-time
   * evidence never existed.
   */
  const actualSpend = await tx.execute<{ id: string }>(sql`
    UPDATE actual_spend
       SET org_unit_id = ${toOrgUnitId}::uuid,
           cost_owning_unit_id = ${nearestCostOwning},
           dimension_source = 'admin-correction'
     WHERE teammate_id = ${teammateId}::uuid AND ${since('date')} AND ${notAlready}
    RETURNING id::text AS id`)

  const reconciliation = await tx.execute<{ id: string }>(sql`
    UPDATE reconciliation_record
       SET org_unit_id = ${toOrgUnitId}::uuid, cost_owning_unit_id = ${nearestCostOwning}
     WHERE teammate_id = ${teammateId}::uuid AND ${since('period_date')} AND ${notAlready}
    RETURNING id::text AS id`)

  /*
   * ── spend_rollup_daily — A MERGE, NOT AN UPDATE ────────────────────────────
   * `org_unit_id` is part of its unique grain (0053), so a plain
   * `SET org_unit_id = X` raises a unique violation the moment the teammate
   * already has a row for the same grain under the TARGET unit — which happens
   * after any partial or repeated correction. So: insert-with-add onto the
   * target grain, then delete the source rows. Two statements, in that order.
   *
   * ALL DAYS, including archived ones: unlike Migrate's project axis, the
   * column here is present on both tables, so cold history can be corrected
   * honestly. "All history" means all history.
   *
   * ── AND THE SOURCE IS AGGREGATED FIRST ─────────────────────────────────────
   * Without the GROUP BY, a teammate with rows under TWO historical Business
   * Units on the same (day, project, model, …) grain feeds two source rows into
   * one target key, and Postgres aborts the whole statement with "ON CONFLICT DO
   * UPDATE command cannot affect row a second time" — rolling back the entire
   * correction, placement included. That is not exotic: it is what any second
   * correction of the same person produces. Collapsing the sources first makes
   * one target row out of however many arrive.
   */
  await tx.execute(sql`
    INSERT INTO spend_rollup_daily (
      period_start, project_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id,
      tool, model, token_type, activity, query_source,
      total_tokens, total_cost_usd, indicative_cost_usd, record_count, refresh_at)
    SELECT period_start, project_id, teammate_id, region_id, ${toOrgUnitId}::uuid, cost_owning_unit_id,
           tool, model, token_type, activity, query_source,
           SUM(total_tokens), SUM(total_cost_usd), SUM(indicative_cost_usd), SUM(record_count), now()
      FROM spend_rollup_daily
     WHERE teammate_id = ${teammateId}::uuid AND ${since('period_start')} AND ${notAlready}
     GROUP BY period_start, project_id, teammate_id, region_id, cost_owning_unit_id,
              tool, model, token_type, activity, query_source
    ON CONFLICT (period_start, COALESCE(project_id, ${SENTINEL}::uuid), teammate_id, region_id, org_unit_id,
                 COALESCE(cost_owning_unit_id, ${SENTINEL}::uuid), tool, model, token_type,
                 COALESCE(activity, ''), COALESCE(query_source, ''))
    DO UPDATE SET
      total_tokens        = spend_rollup_daily.total_tokens        + EXCLUDED.total_tokens,
      total_cost_usd      = spend_rollup_daily.total_cost_usd      + EXCLUDED.total_cost_usd,
      indicative_cost_usd = spend_rollup_daily.indicative_cost_usd + EXCLUDED.indicative_cost_usd,
      record_count        = spend_rollup_daily.record_count        + EXCLUDED.record_count,
      refresh_at          = now()`)

  const rollupDeleted = await tx.execute<{ id: string }>(sql`
    DELETE FROM spend_rollup_daily
     WHERE teammate_id = ${teammateId}::uuid AND ${since('period_start')} AND ${notAlready}
    RETURNING id::text AS id`)

  return {
    attributionRows: [...attribution].length,
    unaccountedRows: [...unaccounted].length,
    overEmissionRows: [...overEmission].length,
    actualSpendRows: [...actualSpend].length,
    reconciliationRows: [...reconciliation].length,
    // The SOURCE rows, not the merged targets: `ON CONFLICT DO UPDATE RETURNING`
    // hands back the final target aggregate including what was already there, so
    // summing it would overstate the correction. The delete counts exactly what
    // moved.
    rollupRows: [...rollupDeleted].length,
  }
}
