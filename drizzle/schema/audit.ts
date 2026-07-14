import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  customType,
} from 'drizzle-orm/pg-core'
import { teammate } from './identity'

const inet = customType<{ data: string }>({
  dataType() {
    return 'inet'
  },
})

export const auditEvent = pgTable('audit_event', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  eventType: text('event_type').notNull(),
  actorTeammateId: uuid('actor_teammate_id').references(() => teammate.id),
  actorSystem: text('actor_system'),
  subjectKind: text('subject_kind'),
  subjectId: uuid('subject_id'),
  payload: jsonb('payload').notNull(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  tsRecorded: timestamp('ts_recorded', { withTimezone: true }).notNull().defaultNow(),
})
