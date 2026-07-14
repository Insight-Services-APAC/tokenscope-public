/*
 * Bundled enrollment secret — PLACEHOLDER in source, injected at marketplace
 * publish. This is the client half of the emit-on-install gate
 * (docs/design/emit-on-install-provisional-attribution.md §Flows 1): the plugin
 * presents this secret to POST /api/v1/setup/enroll, and the server matches it
 * against NUXT_ENROLLMENT_SECRET / the hashed enrollment_secret accept-list.
 *
 * ┌─ SECURITY — read before editing ──────────────────────────────────────────┐
 * │ This file MUST NEVER contain a live secret in source control. The          │
 * │ committed value is the inert PLACEHOLDER sentinel below. The plugin treats  │
 * │ the placeholder (and any empty value) as "no secret configured" → the      │
 * │ emit-on-install enroll path is a strict NO-OP, so an un-injected dev        │
 * │ checkout never enrolls anyone. The secret is only ever present in the      │
 * │ PUBLISHED artifact, injected by the marketplace build, never in git.       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Injection at publish time (the marketplace build), either mechanism works:
 *   (a) Line substitution — the publish pipeline rewrites the right-hand side of
 *       the `const BUNDLED_ENROLLMENT_SECRET = ...` line below with the real
 *       rotatable Insight enrollment secret, in the PUBLISHED copy only (never
 *       committed). This mirrors how DEFAULT_API_BASE is baked into api-base.mjs,
 *       except the value is a secret so it is kept out of git.
 *   (b) Env injection — set TOKENSCOPE_ENROLLMENT_SECRET in the distributed
 *       environment; it takes precedence over the baked value (also the dev/local
 *       override for testing the real enroll path).
 *
 * Rotation/revocation is entirely server-side (rotate-with-overlap + instant
 * revoke via the enrollment_secret accept-list), so rotating the secret does not
 * brick already-installed plugins during the overlap window.
 */

// Inert sentinel — NEVER a real secret. `resolveEnrollmentSecret` returns '' (=>
// enroll is a no-op) whenever the bundled value still equals this.
const PLACEHOLDER = '__TOKENSCOPE_ENROLLMENT_SECRET__'

// PUBLISH INJECTION POINT (mechanism (a)): the marketplace build replaces the
// right-hand side of THIS line ONLY with a quoted real secret. In source it is
// the inert PLACEHOLDER, so the committed plugin can never enroll.
const BUNDLED_ENROLLMENT_SECRET = PLACEHOLDER

/**
 * Resolve the bundled enrollment secret, or '' when none is configured.
 *
 * Order: TOKENSCOPE_ENROLLMENT_SECRET env override (mechanism (b) / dev) > the
 * baked value (mechanism (a)) — but the inert PLACEHOLDER resolves to '' so an
 * un-injected build is treated as "no secret" and enrolls no one. Exported for
 * unit testing; the env is injectable so tests need not mutate process.env.
 */
export function resolveEnrollmentSecret(env = process.env) {
  const fromEnv = (env?.TOKENSCOPE_ENROLLMENT_SECRET ?? '').trim()
  if (fromEnv) return fromEnv
  const baked = (BUNDLED_ENROLLMENT_SECRET ?? '').trim()
  return baked && baked !== PLACEHOLDER ? baked : ''
}
