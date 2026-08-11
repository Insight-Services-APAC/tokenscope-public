/*
 * The ONE canonical form of an email address used by billing-lane
 * classification (docs/design/emitting-identity-and-subscription-type.md §2).
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE `.trim().toLowerCase()`:
 *
 * The billing lane is decided by set membership —
 * `canon(emitting_email) ∈ canon(enterprise address set)`. Set membership is
 * the one comparison shape where a mismatch between how the two sides were
 * prepared is silent AND total: it does not misclassify one record, it
 * misclassifies every record of every teammate whose address happens to differ
 * in case or padding, and the result (self-billed) looks exactly like a real
 * verdict. The producers genuinely disagree today:
 *
 *   - Entra JIT stores `claims.email` verbatim (server/auth/jit-teammate.ts) —
 *     whatever case the IdP sent.
 *   - The analytics path explicitly expects mixed case
 *     (server/workers/analytics-poller.ts).
 *   - The Log Analytics optional-field reader neither trims nor lowercases
 *     (server/azure/reader.ts).
 *
 * So: one exported function, applied to BOTH operands of every comparison and
 * at storage time for `attribution_record.emitting_email`.
 *
 * SCOPE, stated honestly. This is case- and whitespace-folding, nothing more.
 * It deliberately does NOT:
 *   - strip `+tags` or dots (provider-specific mailbox semantics; folding them
 *     would merge addresses an enterprise may treat as distinct people)
 *   - resolve domain aliases. An acquired-company or vanity domain that still
 *     routes SSO is legitimate enterprise mail that fails equality here, for
 *     everyone on that domain at once. §2 names this as the likely real-world
 *     failure and its remedy is the `teammate_identity_map.is_enterprise` flag,
 *     not a cleverer canonicaliser.
 *   - validate that the input looks like an email. A non-address string
 *     canonicalises to itself and simply fails to match the set.
 *
 * NOTE for a future cleanup (deliberately NOT done in this change): roughly
 * eight call sites across server/ open-code `.trim().toLowerCase()` on an email
 * (server/auth/confirm-instance.ts, server/api/v1/setup/enroll.post.ts,
 * server/api/v1/me/identities.post.ts, …). They agree with this function today.
 * Converting them is a scope-widening refactor with its own blast radius
 * (unique indexes, claim-jacking rules) and belongs in its own change.
 */

/**
 * Canonicalise an email address for comparison or storage: trim surrounding
 * whitespace, then lowercase.
 *
 * Returns `''` for null/undefined/blank input — callers MUST treat an empty
 * result as "no address" (billing lane `unknown`) rather than as an address
 * that failed to match, because the two mean different things: a blank is the
 * absence of evidence, a non-match is evidence of a different account.
 */
export function canonicaliseEmail(raw: string | null | undefined): string {
  if (raw == null) return ''
  return raw.trim().toLowerCase()
}
