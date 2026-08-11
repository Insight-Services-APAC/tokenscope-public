/*
 * teammate-drill-facts — THE one way a §A/§B reporting query attaches the drill
 * facts to a row that names a person (developer pages D29/D34/D38).
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * `teammateDrillAdmission` (shared/auth/report-visibility.ts) takes three
 * subject conjuncts. Two of them — `is_active` and `provisional` — are facts
 * about the TEAMMATE ROW that NO client can infer from a figure, so every server
 * producer of a teammate-named row has to carry them. Three review rounds each
 * found ANOTHER producer that did not:
 *
 *   r3-H2  the drivers axes            (engine/drivers.ts, cost-centres.ts)
 *   r4-H2  the project reports depth   (project-depth.ts)
 *   r5-H1  the regional signals strip  (regional.ts fetchRegionalExceptions)
 *          + the cost-centre soft-cap card (engine/over-soft-cap.ts)
 *          + the finance overage drivers (finance.ts fetchOverageDrivers)
 *
 * Every one of them was the SAME defect with the SAME shape: a hand-rolled
 * `bool_or(...)` pair in one query and none in the next, so "did this producer
 * remember?" was a per-query judgement nothing could check. The omission is
 * silent and it fails OPEN — a missing fact reaches the client as `undefined`,
 * `undefined === 'true'` is `false`, and `isProvisional: false` ADMITS the
 * drill. An unconfirmed shadow identity therefore renders as a live link onto a
 * page that 403s (a dead button), and worse, names an unauthenticated email
 * claim as a person on an audited governance surface.
 *
 * So the facts are no longer something a query decides to add. They come from
 * the two SQL fragments below, are read back through {@link teammateDrillFacts}
 * / {@link foldTeammateDrillFacts}, and reach a `DriverRow` through
 * {@link teammateDrillDims}. `tests/unit/server/teammate-drill-facts-contract.test.ts`
 * enumerates the producers and FAILS on a new one that hand-rolls its own — the
 * same static-scan discipline as the lane firewall.
 *
 * ── THE TEAMMATE RELATION MUST BE ALIASED `t` ────────────────────────────────
 * Both fragments address `t.is_active` / `t.provisional` directly. That is
 * deliberate, and it is the same trick engine/over-soft-cap.ts's clamp uses: a
 * producer that aliases the teammate relation as anything else raises
 * `missing FROM-clause entry for table "t"` at the first execution rather than
 * silently answering a different question. One loud failure beats a silent one.
 *
 * ── WHY THE ROW STAYS AND ONLY THE DOOR CLOSES ───────────────────────────────
 * These fragments do NOT filter. A decomposition axis foots to a headline the
 * rest of the page states (engine/drivers.ts's teammate axis writes the argument
 * out in full), so dropping a provisional subject to close a door would trade a
 * dead link for a broken sum-back. The money stays; the NAME stops being a door.
 * Where a surface is not a decomposition and CAN drop the row (the project
 * reports depth folds it into the remainder), that is the surface's own decision
 * — it still reads its input from here.
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * The two fact columns, for a GROUPED producer (one teammate spanning several
 * result rows — the `(teammate × tool × provenance)` grain every drivers axis
 * uses). Aggregated with `bool_or` so the grain of the query cannot change the
 * answer.
 *
 * `COALESCE(..., FALSE)` on BOTH: a LEFT JOIN onto `teammate` yields NULL for an
 * unresolved actor, and `NULL` reaching the client is `undefined`, which the
 * admission rule reads as "not provisional" — fail-open. FALSE for `is_active`
 * fails closed (plain text); FALSE for `provisional` is correct because a row
 * with no teammate at all is `unidentified-subject`, refused a step earlier.
 */
export const TEAMMATE_DRILL_FACTS_AGG: SQL = sql`bool_or(COALESCE(t.is_active, FALSE)) AS drill_is_active,
             bool_or(COALESCE(t.provisional, FALSE)) AS drill_is_provisional`

/**
 * The same two columns for an UNGROUPED producer — one result row per teammate
 * already (the regional signals strip, the soft-cap roster). Identical
 * semantics, no aggregate, so it is legal in a plain SELECT list.
 */
export const TEAMMATE_DRILL_FACTS: SQL = sql`COALESCE(t.is_active, FALSE) AS drill_is_active,
             COALESCE(t.provisional, FALSE) AS drill_is_provisional`

/** The row shape either fragment produces. Producers extend their own row type with it. */
export interface TeammateDrillFactRow {
  drill_is_active: boolean | null
  drill_is_provisional: boolean | null
}

/** The two conjuncts, resolved — the shape both the wire and the client rule take. */
export interface TeammateDrillFacts {
  /** `teammate.is_active` — D34 conjunct 2. A deactivated subject 403s at the drill. */
  isActive: boolean
  /**
   * `teammate.provisional` — D34 conjunct 3 (r3-H2). A shadow minted by the
   * unauthenticated enrol path: ACTIVE, but its email is an unproven claim.
   */
  isProvisional: boolean
}

/** Plain-text fallback facts — what an unidentified / missing subject resolves to. */
export const NO_TEAMMATE_DRILL_FACTS: TeammateDrillFacts = { isActive: false, isProvisional: false }

/** Read one row's fact columns. `null` (no joined teammate) resolves to fail-closed. */
export function teammateDrillFacts(row: TeammateDrillFactRow): TeammateDrillFacts {
  return {
    isActive: row.drill_is_active === true,
    isProvisional: row.drill_is_provisional === true,
  }
}

/**
 * Fold a GROUPED result set (several rows per teammate) down to one fact pair
 * per key. Both facts OR across the group: they are per-teammate constants, so
 * the OR is a merge rather than a policy — but written as an OR so a producer
 * that changes its grain cannot start reporting whichever row sorted first.
 *
 * Rows whose key is null are skipped: they name no subject, so there is no drill
 * to admit or refuse.
 */
export function foldTeammateDrillFacts<R extends TeammateDrillFactRow>(
  rows: Iterable<R>,
  keyOf: (row: R) => string | null,
): Map<string, TeammateDrillFacts> {
  const out = new Map<string, TeammateDrillFacts>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    const prev = out.get(key) ?? NO_TEAMMATE_DRILL_FACTS
    const next = teammateDrillFacts(row)
    out.set(key, {
      isActive: prev.isActive || next.isActive,
      isProvisional: prev.isProvisional || next.isProvisional,
    })
  }
  return out
}

/**
 * The facts as `DriverRow.dims` — the ONLY spelling of these two dim keys.
 *
 * `dims` is `Record<string, string>` on the wire, so the values are the STRINGS
 * `'true'` / `'false'`; the client compares `=== 'true'`. Producing them here
 * means a producer cannot ship `teammate_provisonal` (sic) and have every reader
 * silently read `undefined` — a typo is now one place, not five.
 */
export function teammateDrillDims(facts: TeammateDrillFacts): {
  teammate_active: string
  teammate_provisional: string
} {
  return {
    teammate_active: String(facts.isActive),
    teammate_provisional: String(facts.isProvisional),
  }
}
