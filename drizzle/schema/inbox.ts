import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const inboxItem = pgTable('inbox_item', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  recipientTeammateId: uuid('recipient_teammate_id')
    .notNull()
    .references(() => teammate.id),
  category: text('category').notNull(),
  severity: text('severity').notNull().default('info'),
  subject: text('subject').notNull(),
  body: jsonb('body').notNull(),
  relatedEntityKind: text('related_entity_kind'),
  relatedEntityId: uuid('related_entity_id'),
  ackState: text('ack_state').notNull().default('unread'),
  ackAt: timestamp('ack_at', { withTimezone: true }),
  ackBy: uuid('ack_by').references(() => teammate.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
  teamsSentAt: timestamp('teams_sent_at', { withTimezone: true }),
})
