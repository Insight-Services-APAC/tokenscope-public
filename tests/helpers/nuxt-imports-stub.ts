/*
 * Vitest stub for Nuxt's `#imports` virtual module.
 *
 * `#imports` only resolves inside a Nuxt build. Two consumers reach it from
 * plain Vitest: app/composables/useDemoFeatures.ts, and nuxt-oidc-auth's
 * runtime (since 1.0.0-beta.12, `utils/redirect.js` imports it for the
 * withAppBase() helper — see tests/unit/server/oidc-callback-redirect.test.ts,
 * which deep-imports that module on purpose).
 *
 * Only the members those consumers load at module scope need to exist. A test
 * that actually depends on runtime-config VALUES must stub them itself.
 */
export function useRuntimeConfig(): Record<string, unknown> {
  return { app: { baseURL: '/' }, public: {} }
}
