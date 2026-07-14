/*
 * Deploy-environment classifier — the SINGLE source of truth for "is this
 * deployment allowed to run demo / act-as / impersonation features?".
 *
 * Security contract (allowlist, not denylist): demo-capable means the env is
 * EXPLICITLY one of {local, sandbox}. Everything else — dev, staging,
 * production, and `unknown` (an unrecognized or dropped env identity) — is
 * structurally refused, regardless of any per-flag like NUXT_ALLOW_PERSONA_OVERRIDE.
 * This replaces the old denylist that refused only the literal string
 * 'production', which left dev/staging/'' failing OPEN.
 *
 * The allowlist membership lives in EXACTLY ONE place: DEMO_CAPABLE_ENVS below.
 * The server persona gate, the identity resolver (cookie read), the obo
 * static-bearer seam, the admin-settings endpoint, the client UI composable,
 * and the seed scripts all import isDemoCapableEnv — there is no second copy of
 * the {local, sandbox} list anywhere.
 *
 * The pure functions read NO process.env (callers inject), so this module runs
 * identically on the server and in the browser bundle. `currentServerDeployEnv`
 * / `areStaticBearerAllowed` are the only env-reading conveniences and are
 * server-only call sites.
 */

export type DeployEnv = 'local' | 'sandbox' | 'dev' | 'staging' | 'production' | 'unknown'

/** Envs that may EVER enable demo / act-as / impersonation surfaces. The one allowlist. */
const DEMO_CAPABLE_ENVS: ReadonlySet<DeployEnv> = new Set<DeployEnv>(['local', 'sandbox'])

/** Recognized DEPLOYED env identities (a named env always wins over devMode). */
const NAMED_ENVS: ReadonlySet<string> = new Set(['local', 'sandbox', 'dev', 'staging', 'production'])

export interface ClassifyInput {
  /** NUXT_DEPLOY_ENV (the deployed-env identity). */
  deployEnv?: string | null
  /** NODE_ENV — used ONLY to fail closed when deployEnv is empty. */
  nodeEnv?: string | null
}

/**
 * Classify a deployment into a DeployEnv.
 *
 * NO single flag can make a deployed container demo-capable — the classification
 * keys ONLY on the deploy-env identity and NODE_ENV, never on a feature flag.
 *
 * Precedence (deliberate):
 *   1. A recognized non-empty `deployEnv` WINS — `dev`/`staging`/`production`
 *      classify literally, so a deployed env is always itself.
 *   2. An UNRECOGNIZED non-empty `deployEnv` → `unknown` (fail closed).
 *   3. Empty/absent `deployEnv` → `local` ONLY on a genuine developer box
 *      (NODE_ENV is NOT 'production' — i.e. `nuxt dev` / vitest). A DEPLOYED
 *      container (NODE_ENV='production') that loses its NUXT_DEPLOY_ENV var
 *      classifies to `unknown` and refuses demo — a dropped env var (with or
 *      without any flag drift) can NEVER fail OPEN to `local`. A local
 *      production-mode build that must stay demo-capable sets NUXT_DEPLOY_ENV=local
 *      explicitly rather than inferring it from a flag.
 */
export function classifyDeployEnv({ deployEnv, nodeEnv }: ClassifyInput): DeployEnv {
  let raw = (deployEnv ?? '').trim().toLowerCase()
  if (raw === 'prod') raw = 'production'

  if (raw) {
    return NAMED_ENVS.has(raw) ? (raw as DeployEnv) : 'unknown'
  }

  // Empty/unset deploy env: 'local' only on a non-production NODE_ENV (dev box /
  // vitest). NODE_ENV='production' with no deploy-env → 'unknown' (fail closed).
  const node = (nodeEnv ?? '').trim().toLowerCase()
  return node !== 'production' ? 'local' : 'unknown'
}

/** THE allowlist check — the only place {local, sandbox} membership is decided. */
export function isDemoCapableEnv(env: DeployEnv): boolean {
  return DEMO_CAPABLE_ENVS.has(env)
}

/** Server-side: classify THIS container from process.env. The only server env read here. */
export function currentServerDeployEnv(): DeployEnv {
  // NODE_ENV alone distinguishes a local/CI box from a deployed container on the
  // server, so no dev-mode flag is consulted here (that would be the single-flag
  // re-open path we eliminate). The persona gate reads NUXT_OIDC_AUTH_DEV_MODE
  // separately, but only AFTER this allowlist floor passes.
  return classifyDeployEnv({
    deployEnv: process.env.NUXT_DEPLOY_ENV,
    nodeEnv: process.env.NODE_ENV,
  })
}

/**
 * Whether the obo static / mock real-credential seam may be used. Same allowlist
 * as everything else: bare local/test (no NUXT_DEPLOY_ENV, NODE_ENV !== 'production')
 * classifies to 'local' → allowed, preserving the genuine local + CI/vitest seam;
 * any named deployed env refuses (unless the explicit NUXT_ALLOW_STATIC_BEARER override).
 */
export function areStaticBearerAllowed(): boolean {
  return isDemoCapableEnv(currentServerDeployEnv())
}
