/*
 * rehome-safety — THE predicate that decides whether a teammate may be moved
 * WITHOUT the admin revoke cascade, as one expression.
 *
 * WHY IT IS A CONTROL, NOT A FILTER. A (re)home can change a teammate's region,
 * and region drives their RLS scope. The admin region-PATCH runs a revoke cascade
 * (revoked_at + end instances + revoke OAuth) for exactly that reason; the
 * automatic lanes do not. So the automatic lanes may only touch a teammate with
 * NO live session to re-scope: a never-adopted `bill:` placeholder with no live
 * emit instance and no live OAuth credential. Anything with a real oid or a live
 * credential is left for the admin worklist. (The #99 review contract.)
 *
 * WHY IT LIVES HERE. Three call sites carried their own copy of it — the
 * re-enrichment worker's candidate query, the bill lane's findTeammateByEmail
 * projection, and now the region re-resolve. Three copies of a safety control is
 * how one of them ends up a clause short, and the failure is silent: a live
 * session gets re-scoped and nobody is told. It is one expression, used as a
 * WHERE clause and as a SELECT projection, because it is a boolean either way.
 *
 * DO NOT WIDEN IT. Adding "…or they have not emitted lately" or any liveness
 * proxy re-opens exactly the case the cascade exists for.
 */
import { sql, type SQL } from 'drizzle-orm'

/**
 * `alias` is the teammate table alias in the caller's query (e.g. sql`t`). The
 * returned expression is a plain boolean over that row.
 */
export function rehomeSafePredicate(alias: SQL): SQL {
  return sql`(
    ${alias}.entra_oid LIKE 'bill:%'
    AND NOT EXISTS (
      SELECT 1 FROM instance_attestation ia
      WHERE ia.teammate_id = ${alias}.id AND ia.ts_actual_end IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM oauth_token o
      WHERE o.teammate_id = ${alias}.id AND o.revoked_at IS NULL
    )
  )`
}
