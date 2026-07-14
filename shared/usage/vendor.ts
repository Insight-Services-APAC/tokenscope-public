/*
 * vendor — the single definition of how an emit `tool` maps to a billing VENDOR
 * lane (claude / copilot / other) and the SQL that splits a cost column over
 * those lanes. Both the JS mapper and the SQL FILTER fragments had been copied
 * inline across the rollups (practice/[ouId], org-tree); a drift in the
 * `NOT IN (...) OR IS NULL` "other" predicate silently drops spend from the
 * vendor total, so it lives here once.
 *
 * Pure TS (only drizzle's `sql` tag — not a server-only import), so it sits in
 * `shared/` and is reachable from both the server rollups and any client code.
 */
import { sql, type SQL } from 'drizzle-orm'

export type Vendor = 'claude' | 'copilot' | 'other'

/**
 * Map an emit `tool` to its vendor lane: `claude-code` → claude, `copilot-cli`
 * → copilot, anything else (incl. NULL from a reconciliation delta) → other.
 * Mirrors the SQL bucketing in {@link vendorCostSql} exactly.
 */
export function toolToVendor(tool: string | null): Vendor {
  return tool === 'claude-code' ? 'claude' : tool === 'copilot-cli' ? 'copilot' : 'other'
}

/**
 * The three per-vendor cost-split expressions over `costCol`, each a
 * `COALESCE(SUM(...) FILTER (WHERE tool = ...), 0)` that buckets spend to a
 * vendor lane. `costCol` and the derived `tool` column reference are code
 * constants (never user input) — `costCol` defaults to `ar.cost_usd` and the
 * tool column is taken from its table qualifier (e.g. `ar.cost_usd` →
 * `ar.tool`). The `other` lane uses `NOT IN (...) OR IS NULL` so NOTHING
 * vanishes from the vendor total.
 */
export function vendorCostSql(costCol = 'ar.cost_usd'): { claude: SQL; copilot: SQL; other: SQL } {
  // Derive the sibling `tool` column from the cost column's table qualifier so a
  // caller passing `es.cost_usd` filters on `es.tool`, not a hard-coded `ar.tool`.
  const qualifier = costCol.includes('.') ? costCol.slice(0, costCol.lastIndexOf('.') + 1) : ''
  const cost = sql.raw(costCol)
  const tool = sql.raw(`${qualifier}tool`)
  return {
    claude: sql`COALESCE(SUM(${cost}) FILTER (WHERE ${tool} = 'claude-code'), 0)`,
    copilot: sql`COALESCE(SUM(${cost}) FILTER (WHERE ${tool} = 'copilot-cli'), 0)`,
    other: sql`COALESCE(SUM(${cost}) FILTER (WHERE ${tool} NOT IN ('claude-code', 'copilot-cli') OR ${tool} IS NULL), 0)`,
  }
}
