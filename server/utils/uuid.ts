/*
 * Canonical UUID validation. Several modules historically inlined this same
 * regex (server/auth/oauth.ts, server/utils/tag-session.ts,
 * server/utils/require-uuid-param.ts) — prefer importing from here; those
 * copies can adopt this over time.
 *
 * Matches any RFC-4122 textual UUID, case-insensitive — which is exactly what
 * Postgres's `::uuid` cast accepts. Deliberately NOT v4-specific: external /
 * fixture ids are not guaranteed to be v4.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True iff `s` is a textual UUID; narrows the type so a `::uuid` cast is safe. */
export function isUuid(s: string | undefined | null): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}
