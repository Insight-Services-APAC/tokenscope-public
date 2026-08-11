/*
 * Mounts the durable, SHARED session store that nuxt-oidc-auth reads through.
 *
 * nuxt-oidc-auth keeps every signed-in user's persistent session in
 * `useStorage('oidc')`. Nothing in this app ever mounted a driver for that key,
 * so it resolved to Nitro's default IN-MEMORY driver — which means the store
 * dies with the container (every deploy signs everyone out) and is invisible to
 * sibling replicas (a session created on replica A is a 401 on replica B, so the
 * user bounces to /login, signs in again on whichever replica answers, and
 * loops). Both were always true; running a single replica merely hid it, until
 * dev scaled to two on 2026-07-26. See mig 0097 for the incident note and for
 * why the backing store is Postgres rather than Redis.
 *
 * WHY A RUNTIME PLUGIN AND NOT `nitro.storage` IN nuxt.config. The config route
 * was tried and reverted: Nitro resolves a non-builtin driver named in
 * `nitro.storage` by IMPORTING IT AT BUILD TIME, and an extensionless absolute
 * path to a .ts module fails to resolve ("Cannot find module .../pg-kv-driver").
 * Mounting at runtime keeps the driver in TypeScript and lets it import
 * `server/db` for the app's existing pool instead of opening its own.
 *
 * ORDERING. Nitro runs plugins synchronously, in registration order, before the
 * server accepts its first request (nitropack's `runNitroPlugins`), so every
 * request-path read of `useStorage('oidc')` is already routed here. The mount
 * call is deliberately synchronous for that reason: nitropack does NOT await a
 * plugin's returned promise, so anything awaited before `mount()` would leave a
 * window where requests resolve against the in-memory default.
 */
import { defineNitroPlugin, useStorage } from 'nitropack/runtime'
import { installOidcSessionStore } from '../storage/mount-oidc-session-store'

/*
 * Everything of substance lives in installOidcSessionStore, so that it can be
 * driven by an integration test against a real Postgres — a Nitro plugin itself
 * is reachable only from a built, booted server, and code that no test can reach
 * is exactly where a silent fallback would hide. What is left here is the one
 * thing that genuinely cannot be tested without a build: the registration.
 *
 * `installOidcSessionStore` mounts SYNCHRONOUSLY (throwing here aborts startup)
 * and returns the boot probe's promise, which is intentionally not awaited — see
 * ORDERING above.
 */
export default defineNitroPlugin(() => {
  void installOidcSessionStore(useStorage())
})
