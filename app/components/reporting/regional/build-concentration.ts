/*
 * build-concentration — the Region width's spend-concentration stats, from the
 * `axis=teammate` driver rows.
 *
 * WHY CLIENT-SIDE. The whole-company drivers endpoint returns a server-computed
 * `concentration` block; the Regional one returns only the ranked rows.
 * Concentration is a pure function of per-teammate spend, so it is derived here
 * from a dedicated teammate fetch — no new endpoint, and axis-stable (switching
 * the drivers table's axis never blanks the card).
 *
 * WHAT CHANGED, AND WHY IT MATTERED. This file used to carry its OWN cohort
 * maths: `Math.ceil` cut points and four bespoke cohorts labelled "Power (top
 * 10%)" / "Heavy (10–25%)" / "Typical (25–50%)" / "Light (bottom 50%)". Both
 * halves of that were wrong.
 *
 *   - The ARITHMETIC diverged from the whole-company width, which cuts with
 *     `Math.max(1, Math.round(n × p))`. Two widths answered "what share does the
 *     top 10% hold" differently, and nothing could see it because the two cards
 *     also had different shapes.
 *   - The LABELS name PEOPLE ("Power users"), which the prototype calls out as
 *     the defect — a spend distribution is not a taxonomy of humans.
 *
 * It now calls the ONE shared implementation, so both widths publish the same
 * distribution cut the same way, and the Region width renders the same card.
 *
 * NOTE: the fair home for this is a server `concentration` block on the Regional
 * drivers endpoint (mirroring Across). Computing it here stays the interim path
 * — but it is now the same FUNCTION the server would call, so the interim can no
 * longer drift from the destination.
 */
import { computeConcentration, type ConcentrationStats } from '#shared/reports/concentration'
import type { DriverRow } from '#shared/reports/types'

export type { ConcentrationStats }

/**
 * Concentration stats from teammate driver rows. Returns null when there is no
 * positive spend (⇒ the card is hidden). Rows need not be pre-sorted — the
 * shared implementation requires a DESCENDING cost array, which is built here.
 */
export function buildConcentration(rows: DriverRow[]): ConcentrationStats | null {
  const costsDesc = rows
    .filter((r) => r.usd > 0)
    .map((r) => r.usd)
    .sort((a, b) => b - a)
  if (costsDesc.length === 0) return null
  const stats = computeConcentration(costsDesc)
  return stats.totalUsd > 0 ? stats : null
}
