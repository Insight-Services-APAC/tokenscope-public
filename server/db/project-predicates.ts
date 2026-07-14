/*
 * Shared project end_date predicates — so the read sites that must hide or flag
 * ENDED projects cannot diverge. A site that drops the `IS NULL` arm or flips
 * the comparison is a $0-leak / mis-routing bug, so the predicate lives in one
 * place (same rationale as server/auth/allocation-scope.ts).
 *
 * `tableRef` is the table name or alias the calling query uses for the project
 * row (e.g. 'p', or 'project'/'px' for an unaliased / differently-aliased FROM).
 * It is a code constant, never user input.
 */
import { sql, type SQL } from 'drizzle-orm'

// `tableRef` is interpolated via sql.raw (no parameter binding), so it MUST be a
// bare SQL identifier. Every caller passes a literal ('p' / 'project' / 'px'),
// but this is a shared util — assert the shape so a future caller can't turn a
// dynamic / user-derived alias into an injection. Belt-and-braces, not a today-bug.
function rawColumn(tableRef: string, column: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableRef)) {
    throw new Error(`project-predicates: unsafe tableRef ${JSON.stringify(tableRef)}`)
  }
  return sql.raw(`${tableRef}.${column}`)
}

/** A project is ACTIVE: no end date, or it's still in the future. */
export function activeProjectPredicate(tableRef = 'p'): SQL {
  const endDate = rawColumn(tableRef, 'end_date')
  return sql`(${endDate} IS NULL OR ${endDate} > now())`
}

/** A project has ENDED: end date set and at/before now. The negation of active. */
export function endedProjectExpr(tableRef = 'p'): SQL {
  const endDate = rawColumn(tableRef, 'end_date')
  return sql`(${endDate} IS NOT NULL AND ${endDate} <= now())`
}
