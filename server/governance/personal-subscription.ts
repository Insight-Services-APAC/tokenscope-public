import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

export function personalSubscriptionLockKey(args: { teammateId: string; tool: string }): string {
  return `${args.teammateId}:${args.tool}`
}

export async function hasActivePersonalSubscription(
  db: Db,
  args: { teammateId: string; tool: string },
): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM personal_subscription_declaration
      WHERE teammate_id = ${args.teammateId}::uuid
        AND tool = ${args.tool}
        AND revoked_at IS NULL
    ) AS exists
  `)
  return rows[0]?.exists ?? false
}

export async function resolvePersonalSubscriptionPrompts(
  db: Db,
  args: { teammateId: string; tool: string },
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
    SET ack_state = 'resolved', ack_at = now(), ack_by = ${args.teammateId}::uuid
    WHERE recipient_teammate_id = ${args.teammateId}::uuid
      AND category = 'personal-subscription-prompt'
      AND body ->> 'tool' = ${args.tool}
      AND ack_state IN ('unread', 'read', 'acknowledged')
    RETURNING id::text AS id
  `)
  return rows.length
}
