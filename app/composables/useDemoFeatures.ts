/*
 * useDemoFeatures — the CLIENT-side gate for persona / demo / act-as UI.
 *
 * Cosmetic defense-in-depth ONLY: the server (server/auth/persona-override.ts +
 * server/utils/auth.ts) is authoritative and refuses these features off a
 * demo-capable env regardless of what the client renders. Hiding the controls
 * just stops them being presented/probed on a pilot-prod surface.
 *
 * Uses the SAME classifier as the server (shared/env/deploy-env.ts), pinning
 * nodeEnv:'production' so a MISSING public.deployEnv classifies to 'unknown'
 * (fails CLOSED — controls hidden) rather than back to 'local'. The browser has no
 * real NODE_ENV, so local dev is signalled explicitly by public.authDevMode
 * (NUXT_OIDC_AUTH_DEV_MODE, hard-false on every deployed env) → treated as
 * deployEnv:'local'. This flag matters ONLY on the cosmetic client; the server's
 * classifier consults no flag at all.
 */
import { computed } from 'vue'
import { useRuntimeConfig } from '#imports'
import { classifyDeployEnv, isDemoCapableEnv } from '#shared/env/deploy-env'

export function useDemoFeatures() {
  const config = useRuntimeConfig()
  const env = computed(() =>
    classifyDeployEnv({
      // authDevMode (local dev) → explicit 'local'; otherwise the deployed mirror.
      deployEnv: config.public.authDevMode ? 'local' : (config.public.deployEnv as string),
      nodeEnv: 'production', // pin → missing deployEnv fails closed to 'unknown'
    }),
  )
  /** env ∈ {local, sandbox} — may show persona-switch / demo controls. */
  const demoCapable = computed(() => isDemoCapableEnv(env.value))
  /** env === 'local' — pre-Entra demo persona login (must NOT leak onto sandbox). */
  const localOnly = computed(() => env.value === 'local')
  return { deployEnv: env, demoCapable, localOnly }
}
