/*
 * resolveMyEmails — the caller's Claude/client email identities, lowercased +
 * de-duped: the primary teammate.email plus teammate_identity_map email rows.
 *
 * Lowercasing is load-bearing (adversarial-review R1 #9): identities are stored
 * lowercased, but teammate.email and the Claude-stamped per-event user.email may
 * be mixed-case. The reader pairs this with KQL `in~` (case-insensitive) so a
 * session can't silently fail to match and drop the user's spend.
 *
 * R1 #1 (noted, by design): map rows are included regardless of verified_at.
 * Unverified self-links are trusted for attribution per the trust-the-developer
 * posture (uniqueness on (system,identifier) blocks claiming an already-linked
 * identity; every link is audited; the poller / over-attribution flag is the
 * reconciliation backstop). Hard-gating ownership on verified_at awaits a
 * verification flow and is tracked as a Phase-4 follow-up.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

export async function resolveMyEmails(
  db: PostgresJsDatabase<typeof schema>,
  teammateId: string,
): Promise<string[]> {
  const rows = await db.execute<{ email: string }>(sql`
    SELECT lower(email) AS email FROM teammate WHERE id = ${teammateId}::uuid
    UNION
    SELECT lower(identifier) AS email FROM teammate_identity_map
      WHERE teammate_id = ${teammateId}::uuid AND identifier_kind = 'email'
  `)
  return [...rows].map((r) => r.email).filter(Boolean)
}
