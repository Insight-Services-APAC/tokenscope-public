/*
 * Email + Teams DM stubs — log-only in local dev. Per docs/build/mvp-lite-epic.md
 * §Epic 7: "payloads logged, not delivered". Real deliverers wire in at
 * Epic 10 (Azure Communication Services for email; Teams Bot Framework).
 *
 * Both functions update the inbox row's email_sent_at / teams_sent_at
 * marker so downstream code can tell a delivery was attempted.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'

const log = consola.withTag('inbox-deliver')

export async function deliverEmailStub(
  db: PostgresJsDatabase<typeof schema>,
  opts: { inboxItemId: string; recipientEmail: string; subject: string; body: unknown },
): Promise<void> {
  log.info('[email-stub] would send', {
    to: opts.recipientEmail,
    subject: opts.subject,
    inbox_item_id: opts.inboxItemId,
  })
  await db.execute(sql`
    UPDATE inbox_item SET email_sent_at = NOW()
    WHERE id = ${opts.inboxItemId}::uuid
  `)
}

export async function deliverTeamsStub(
  db: PostgresJsDatabase<typeof schema>,
  opts: { inboxItemId: string; recipientTeammateId: string; subject: string; body: unknown },
): Promise<void> {
  log.info('[teams-stub] would DM', {
    to_teammate: opts.recipientTeammateId,
    subject: opts.subject,
    inbox_item_id: opts.inboxItemId,
  })
  await db.execute(sql`
    UPDATE inbox_item SET teams_sent_at = NOW()
    WHERE id = ${opts.inboxItemId}::uuid
  `)
}
