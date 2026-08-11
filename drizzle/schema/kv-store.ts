/*
 * kv_store — durable backing for Nitro storage mounts (mig 0097).
 *
 * Today it holds exactly one mount: `oidc`, nuxt-oidc-auth's persistent session
 * store. It exists because the in-memory default is per-replica and dies with
 * the container, which signs every user out on every deploy and produces a
 * /login loop as soon as more than one replica serves traffic.
 *
 * Written and read ONLY by server/storage/pg-kv-driver.ts — never by feature
 * code. Values are opaque strings (unstorage stringifies before the driver sees
 * them); tokens inside a session row are already encrypted by the auth module.
 *
 * Besides sessions, each replica writes a short-ttl boot-probe row at startup
 * (`__tokenscope__:boot-probe:<uuid>`, see
 * server/storage/mount-oidc-session-store.ts). It is the evidence that the mount
 * is really bound to Postgres rather than having silently fallen back to
 * in-memory storage, which is invisible from the outside. The key is unique per
 * probe so concurrently-booting replicas cannot overwrite each other's row (and
 * so read back a stamp they did not write); the ttl is what bounds them.
 */
import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, index, primaryKey } from 'drizzle-orm/pg-core'

export const kvStore = pgTable(
  'kv_store',
  {
    /** The Nitro mount this key belongs to ('oidc'). */
    mount: text('mount').notNull(),
    /** unstorage's mount-relative, colon-separated key. */
    key: text('key').notNull(),
    value: text('value').notNull(),
    /** NULL = never expires. Expired rows read as absent and are swept lazily. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'kv_store_pkey', columns: [t.mount, t.key] }),
    // PARTIAL, matching mig 0097: the sweep only ever deletes by expiry, so rows
    // that never expire are not its business and do not belong in the index.
    // Mirrored here rather than left as a plain index so this file does not
    // describe an index the database does not actually have.
    index('kv_store_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
  ],
)
