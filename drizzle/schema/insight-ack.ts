/*
 * insight_ack (mig 0046) — per-(teammate, finding, month) dismissal of an
 * "Observed in your usage" insight card. Month-scoped (PO decision, brief
 * §7): a dismissed insight stays hidden for the calendar month and may
 * resurface next month if the pattern persists. RLS: teammate-self.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const insightAck = pgTable(
  'insight_ack',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    teammateId: uuid('teammate_id')
      .notNull()
      .references(() => teammate.id),
    findingId: text('finding_id').notNull(),
    month: text('month').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('insight_ack_unique').on(t.teammateId, t.findingId, t.month)],
)
