-- 0097: kv_store — durable, SHARED backing for Nitro storage mounts.
--
-- WHY. nuxt-oidc-auth keeps every signed-in user's persistent session in
-- `useStorage('oidc')`. Nothing ever mounted a driver for that key, so it has
-- always resolved to Nitro's default IN-MEMORY driver, which means:
--
--   * every deploy logs every user out (the store dies with the container), and
--   * the moment the container app runs more than ONE replica, a session
--     created on replica A is invisible to replica B — the user is bounced to
--     /login, logs in again on whichever replica answers, and loops.
--
-- Both were always true; dev simply ran a single replica, which hid it. On
-- 2026-07-26 dev scaled to two and the loop surfaced (nuxt-oidc-auth logging
-- "Persistent user session not found, clearing stale session" on every miss).
--
-- WHY POSTGRES AND NOT REDIS. Redis is the reflexive answer and the wrong one
-- here: it is unprovisioned in dev (its private endpoint was never finished with
-- the network team), it is real recurring cost, and a session cache for a pilot
-- of ~12 people needs durability, not microseconds. Postgres is already
-- provisioned, already reachable over a working private endpoint, already where
-- every other piece of truth lives, and is idle enough that session traffic does
-- not register. No new infra, no new dependency, no network-team lead time.
--
-- WHAT LANDS HERE. Whatever a mounted Nitro storage puts here — today only the
-- `oidc` mount. Session rows hold nuxt-oidc-auth's persistent session: the
-- refresh/id tokens inside it are ENCRYPTED by the module before it ever calls
-- the driver (NUXT_OIDC_TOKEN_KEY), so this table stores ciphertext, not bearer
-- material in the clear.
--
-- NO RLS, deliberately. Every other table is RLS-guarded because it is read
-- through user-scoped queries; this one is not reachable that way at all. It is
-- read by the framework BEFORE a session exists (that is its entire job), so a
-- policy keyed on app.user_* could only ever deny the one caller that must
-- succeed. Access control here is "the app's own DB role", same as the storage
-- driver's process boundary.

CREATE TABLE kv_store (
  -- The Nitro mount this key belongs to ('oidc'). Namespacing means a second
  -- mount can share the table later without key collisions.
  mount      TEXT NOT NULL,
  -- unstorage's key, mount-relative (colon-separated).
  key        TEXT NOT NULL,
  -- unstorage stringifies before calling the driver, so the value is TEXT.
  value      TEXT NOT NULL,
  -- NULL = never expires. Expired rows read as absent and are swept lazily.
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kv_store_pkey PRIMARY KEY (mount, key)
);

COMMENT ON TABLE kv_store IS
  'Durable backing for Nitro storage mounts (mig 0097). Currently the nuxt-oidc-auth `oidc` session store: shared across replicas and surviving deploys, which the in-memory default is not. Values are opaque strings; session tokens inside them are encrypted by the auth module.';

-- The sweep deletes by expiry across all mounts; partial because rows without
-- an expiry are never its business.
CREATE INDEX kv_store_expires_idx ON kv_store (expires_at) WHERE expires_at IS NOT NULL;
