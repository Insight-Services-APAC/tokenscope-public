/*
 * sql-like — the ONE escaper for a caller-supplied LIKE/ILIKE search term.
 *
 * THE TRAP THIS EXISTS TO PREVENT: the escape character must be bound as a
 * PARAMETER, never written as a literal inside the SQL template. A literal
 * `ESCAPE '\'` inside a JS/drizzle tagged template collapses to `ESCAPE ''`
 * before Postgres ever sees it — the backslash is consumed by the JS string
 * (and drizzle's `sql` template does not re-escape it), and an empty string
 * is a syntactically valid — but silently NO-OP — escape clause. The
 * pattern's own escaping then matches nothing, which is worse than no
 * escaping: it *looks* defended while quietly under-reporting every LIKE
 * that contains a literal `%` or `_`. Always write:
 *
 *   sql`... LIKE ${escapeLikeLiteral(term)} ESCAPE ${LIKE_ESCAPE} ...`
 *
 * never:
 *
 *   sql`... LIKE ${term} ESCAPE '\' ...`                          // BROKEN
 *
 * Originally lived only in server/storage/pg-kv-driver.ts (the oidc session
 * store's key-prefix scan); every other ILIKE/LIKE site should import this
 * rather than re-deriving its own copy — a second escaper beside this one is
 * the exact failure mode this file exists to close off.
 */

/** The bound-parameter escape character every LIKE/ILIKE clause in this codebase agrees on. */
export const LIKE_ESCAPE = '\\'

/**
 * Escape LIKE/ILIKE metacharacters (`%`, `_`, and the escape character
 * itself) in a literal search term. Pair with `ESCAPE ${LIKE_ESCAPE}` bound
 * as a parameter — see the module comment for why the escape character must
 * never be inlined as `ESCAPE '\'`.
 */
export function escapeLikeLiteral(s: string): string {
  return s.replace(/([%_\\])/g, `${LIKE_ESCAPE}$1`)
}
