/*
 * enrollment_secret — the bundled-secret accept-list for the emit-on-install
 * enroll path (mig 0058; emit-on-install + provisional attribution, slice 3).
 *
 * POST /api/v1/setup/enroll is GATED on a bundled Insight enrollment secret. This
 * table is the durable, rotatable accept-list (rotate-with-overlap via the
 * [not_before, not_after) windows + instant revoke via revoked_at). A bootstrap
 * secret from env NUXT_ENROLLMENT_SECRET is accepted IN ADDITION (so dev works
 * before any row is seeded) — but the table is the durable mechanism.
 *
 * Secrets discipline (mirrors oauth_client.client_secret_hash / emit_handoff):
 * only the HMAC-SHA-256 hash of the raw secret is stored (hashSessionToken), never
 * the plaintext. The presented secret is hashed and looked up by hash.
 */
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const enrollmentSecret = pgTable('enrollment_secret', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // HMAC hash of the raw bundled secret; the raw value lives only in the plugin.
  secretHash: text('secret_hash').notNull().unique(),
  label: text('label'),
  // Rotation window — a row is "live" when now() is within [not_before, not_after)
  // (NULL bound = unbounded on that side) AND revoked_at IS NULL.
  notBefore: timestamp('not_before', { withTimezone: true }),
  notAfter: timestamp('not_after', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
