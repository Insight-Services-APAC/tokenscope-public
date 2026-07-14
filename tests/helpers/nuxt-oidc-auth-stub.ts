/*
 * Vitest stub for nuxt-oidc-auth/runtime/server/utils/session.js.
 *
 * The real module imports Nuxt's `#imports` virtual which only resolves
 * inside a Nuxt build. Tests don't exercise the OIDC decryption path —
 * they use injectTestSession() to pre-populate event.context, and
 * tryAuth()'s fast-path returns the cached session before reaching
 * getUserSession().
 *
 * This stub keeps the module-load chain happy and returns null for any
 * direct call (so a test that DOES reach this code asserts a clean
 * "unauthenticated" path).
 */
export async function getUserSession(): Promise<null> {
  return null
}
