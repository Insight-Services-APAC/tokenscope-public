/*
 * report_access_grant (mig 0129) — per-teammate, per-permission report-access
 * grants, replacing the three-mode report-visibility policy (mig 0087,
 * dropped in the same migration). Mirrors cou_owner's shape (mig 0048,
 * identity.ts:106-118) — soft-revoke, 1..n grants per teammate (one per
 * permission), active = revoked_at IS NULL AND (expires_at IS NULL OR
 * expires_at > now()).
 *
 * CONSTRAINTS LIVE IN THE MIGRATION (0129), NOT this model: the `permission`
 * CHECK, the revoke-shape CHECK and the RLS policies are hand-written SQL
 * Drizzle can't render. Migrations here are hand-authored and applied by
 * drizzle/migrate.ts — do NOT `drizzle-kit generate` against this model and
 * ship its output, or those guarantees are silently dropped.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { teammate } from './identity'

export const reportAccessGrant = pgTable('report_access_grant', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  permission: text('permission').notNull(),
  grantedBy: uuid('granted_by').references(() => teammate.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => teammate.id),
})
