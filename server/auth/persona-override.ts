/*
 * Persona-override gate — pure decision function for /api/v1/auth/dev-login.
 *
 * Extracted so it's testable without an h3 event mock and without booting
 * Nitro. The handler (server/api/v1/auth/dev-login.post.ts) calls this with
 * the resolved (env + caller-session) state and follows the verdict.
 *
 * ALLOWLIST gate (security contract): demo / act-as features run ONLY when the
 * deployment is demo-capable (env ∈ {local, sandbox}; see shared/env/deploy-env.ts).
 * dev / staging / production / unknown ALL refuse structurally, BEFORE any flag or
 * caller role is consulted — so no single env flag (NUXT_ALLOW_PERSONA_OVERRIDE,
 * NUXT_OIDC_AUTH_DEV_MODE) can re-open impersonation on a pilot-prod env.
 *
 *   FIRST: env not demo-capable                               → 404 (structural floor)
 *   (a) NUXT_OIDC_AUTH_DEV_MODE=true (demo-capable only)       → allowed, mode=dev
 *   (b) NUXT_ALLOW_PERSONA_OVERRIDE=true AND admin/global-finops/platform-admin
 *                                                              → allowed, mode=override
 *   else → refuse:
 *       - override-flag off                                    → 404
 *       - override-flag on but no session                      → 401
 *       - override-flag on but session role mismatched         → 403
 *
 * The per-flag values are still honored (belt-and-suspenders) but only BEHIND the
 * structural floor. `demoCapable` is computed by the caller from the single env
 * classifier (currentServerDeployEnv → isDemoCapableEnv).
 */
import type { Session } from '../utils/auth'

export interface PersonaGateEnv {
  devMode: boolean
  allowOverride: boolean
  /** env ∈ {local, sandbox} — the ONLY envs that may ever be demo-capable. */
  demoCapable: boolean
}

export type PersonaGateVerdict =
  | { allowed: true; mode: 'dev' }
  | {
      allowed: true
      mode: 'override'
      // The OID + email come from the caller's session — caller passes
      // the resolved values in (the session cookie itself doesn't carry
      // OID; the handler joins to teammate to get it).
    }
  | { allowed: false; status: 401 | 403 | 404; reason: string }

export function evaluatePersonaGate(
  env: PersonaGateEnv,
  caller: Pick<Session, 'role' | 'teammateId'> | null,
): PersonaGateVerdict {
  // STRUCTURAL FLOOR (allowlist): only {local, sandbox} may ever be demo-capable.
  // dev / staging / production / unknown refuse here — before any flag or caller
  // role — so flag drift or a dropped env var cannot re-open impersonation.
  if (!env.demoCapable) {
    return { allowed: false, status: 404, reason: 'env-not-demo-capable' }
  }

  if (env.devMode) {
    return { allowed: true, mode: 'dev' }
  }

  if (!env.allowOverride) {
    return { allowed: false, status: 404, reason: 'override-disabled' }
  }

  // Override gate is on. Caller must be authenticated + admin / global-finops
  // / platform-admin (the super-admin can act-as any demo persona too).
  if (!caller) {
    return { allowed: false, status: 401, reason: 'unauthenticated' }
  }
  if (caller.role !== 'admin' && caller.role !== 'global-finops' && caller.role !== 'platform-admin') {
    return { allowed: false, status: 403, reason: 'role-not-admin' }
  }

  return { allowed: true, mode: 'override' }
}
