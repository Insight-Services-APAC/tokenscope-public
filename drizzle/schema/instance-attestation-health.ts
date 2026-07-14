import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core'
import { instanceAttestation } from './instance-attestation'

export const instanceAttestationHealth = pgTable('instance_attestation_health', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  instanceId: uuid('instance_id')
    .notNull()
    .references(() => instanceAttestation.instanceId),
  status: text('status').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  expectedSpanCount: integer('expected_span_count'),
  actualSpanCount: integer('actual_span_count'),
  payload: jsonb('payload'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})
