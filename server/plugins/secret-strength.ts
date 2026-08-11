/*
 * server/plugins/secret-strength.ts — boot-time WARN (never throw) when
 * nuxt-oidc-auth's three encryption/signing secrets fall below their
 * strength floors.
 *
 * WARN-ONLY IS DELIBERATE FOR THIS SPRINT. The measurement that justified
 * "zero test churn" for the entropy floor (server/auth/key-strength.ts)
 * covered the 13 in-repo test secrets only — the DEPLOYED
 * NUXT_OIDC_SESSION_SECRET / NUXT_OIDC_AUTH_SESSION_SECRET /
 * NUXT_OIDC_TOKEN_KEY (Key Vault `oidc-session-secret` / `oidc-auth-session-secret`
 * / `oidc-token-key`, infra/modules/container-app.bicep:430-432) have never
 * been scored. A throw shipped before those deployed values are probed
 * would take every environment down on the next boot at once —
 * iron-webcrypto@1.2.1 uses PBKDF2 with `iterations: 1`, so raw entropy IS
 * the entire margin (there is no per-boot key-stretching to fall back on).
 * Flipping this to a throw is deliberate follow-up operator work (`UF-2`),
 * not this sprint.
 *
 * Floors mirror the intended contract already documented at
 * infra/modules/keyvault-secrets.bicep:129-146 (S11 owns that file; this
 * plugin only reads the same numbers, it does not enforce them there):
 *   - NUXT_OIDC_SESSION_SECRET / NUXT_OIDC_AUTH_SESSION_SECRET: >= 48 chars
 *   - NUXT_OIDC_TOKEN_KEY: base64-encoded 32 bytes == 44 chars
 * Entropy floor is the shared default (>= 3.5 bits/byte,
 * server/auth/key-strength.ts) for all three — "do not invent a new
 * threshold" applies here too.
 *
 * Unset is NOT a warning: without these vars nuxt-oidc-auth mints a random
 * per-boot value itself (see the bicep comment) — a real, if separately
 * documented, session-invalidation-on-restart trade-off, but not a WEAK
 * secret. This plugin only flags a secret that IS set but scores below the
 * floor.
 */
import { defineNitroPlugin } from 'nitropack/runtime'
import { consola } from 'consola'
import { checkEnvKeyStrength } from '../auth/key-strength'

const CHECKS: ReadonlyArray<{ name: string; minLength: number }> = [
  { name: 'NUXT_OIDC_SESSION_SECRET', minLength: 48 },
  { name: 'NUXT_OIDC_AUTH_SESSION_SECRET', minLength: 48 },
  { name: 'NUXT_OIDC_TOKEN_KEY', minLength: 44 },
]

export default defineNitroPlugin(() => {
  for (const { name, minLength } of CHECKS) {
    if (!process.env[name]) continue // unset → module-generated random value, not this check's concern
    const result = checkEnvKeyStrength(name, { minLength })
    if (!result.ok) {
      consola.warn(`[secret-strength] ${result.message}`)
    }
  }
})
