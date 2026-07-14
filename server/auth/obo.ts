/*
 * Azure Monitor ingest bearer (Shape A, ADR-0003).
 *
 * The bearer Claude puts on its OTLP requests is an AZURE Entra token —
 * audience `https://monitor.azure.com/.default`, authorized by the
 * container app's user-assigned Managed Identity holding the
 * `Monitoring Metrics Publisher` role on the DCR. It is NOT the TokenScope
 * session token (Azure never sees that). `/bearer` (bearer.get.ts) gates
 * issuance on the session token, then calls this to mint the Azure token.
 *
 * STRIDE (telemetry): the token is write-only + narrow-scope (ingest to one
 * DCR) — can't read/exfiltrate, can't escalate; leakage is at worst capped
 * ingest noise. So an app-MI token handed to the client is acceptable for
 * telemetry; we do NOT need per-dev Azure OAuth/RBAC. See
 * docs/development/claude-code-telemetry-contract.md.
 *
 * Modes (NUXT_AZURE_MONITOR_AUTH):
 *   - 'mi'     → real: ManagedIdentityCredential.getToken(scope). Works only on
 *                Azure-hosted compute (IMDS) — sandbox ACA, not local/this box.
 *   - 'static' → return NUXT_AZURE_MONITOR_STATIC_BEARER verbatim. A local /
 *                test seam ONLY: lets the full plugin → /bearer → Claude → Azure
 *                loop run off-Azure by injecting a pre-minted Azure token (e.g.
 *                from the operator's `az` login). Keeps this module az-CLI-free.
 *   - else     → deterministic mock (local dev / tests).
 */
import { createHmac } from 'node:crypto'
import { areStaticBearerAllowed } from '../../shared/env/deploy-env'

export interface ObOResult {
  bearer: string
  expiresInSeconds: number
}

export type AccessTokenLike = { token: string; expiresOnTimestamp: number }
export type GetTokenFn = (scope: string) => Promise<AccessTokenLike>

const AZURE_MONITOR_INGEST_SCOPE =
  process.env.NUXT_AZURE_MONITOR_INGEST_SCOPE ?? 'https://monitor.azure.com/.default'

/*
 * Guard the load-bearing control (docs/design/telemetry-query-network-posture.md
 * §4). The bearer this module hands to clients is minted from the app MI, which
 * ALSO holds `Log Analytics Reader`. The ONLY thing keeping that bearer
 * publish-only — and therefore safe to expose to a client / over the OTLP wire —
 * is that we request the narrow Azure Monitor INGEST audience. A misconfigured
 * NUXT_AZURE_MONITOR_INGEST_SCOPE (the Log Analytics QUERY audience
 * `https://api.loganalytics.io/.default`, ARM, or any broad scope) would
 * silently hand every client a READ-capable token. There is no other guardrail.
 * So fail CLOSED (refuse to mint) rather than emit a leaky credential.
 *
 * Allows the commercial host and sovereign-cloud variants (`monitor.azure.us`,
 * `monitor.azure.cn`) via the `monitor.azure.<tld>` shape; rejects everything
 * else. Pure + exported for direct unit testing.
 */
export function assertAzureMonitorIngestScope(scope: string): void {
  let url: URL
  try {
    url = new URL(scope)
  } catch {
    throw new Error(`NUXT_AZURE_MONITOR_INGEST_SCOPE is not a valid URL: "${scope}"`)
  }
  const ok =
    url.protocol === 'https:' &&
    /^monitor\.azure\.[a-z]{2,}$/.test(url.hostname) &&
    url.pathname === '/.default'
  if (!ok) {
    throw new Error(
      'Refusing to mint a client Azure Monitor bearer: NUXT_AZURE_MONITOR_INGEST_SCOPE must be the ' +
        `ingest audience (https://monitor.azure.<tld>/.default), got "${scope}". A non-ingest scope ` +
        'would hand clients a read-capable token (the app MI also holds Log Analytics Reader).',
    )
  }
}

// The MI token is app-level (same for every session), so one shared cache
// serves all /bearer calls. Refresh well before expiry so a stale token
// never reaches Claude's 29-min helper window.
const REFRESH_SKEW_MS = 5 * 60 * 1000
let cached: { bearer: string; expiresAtMs: number } | null = null
// Single-flight: collapse concurrent cold-start refreshes onto ONE getToken
// call so racing /bearer requests don't each mint (and clobber the cache with)
// a different token, leaving some sessions holding an invalidated one. R1 #6.
let inFlight: Promise<{ bearer: string; expiresAtMs: number }> | null = null

/** Test seam + reset for unit tests. */
export function _resetAzureMonitorBearerCache(): void {
  cached = null
  inFlight = null
}

// Best-effort JWT `exp` (seconds) → ms, or null if the token isn't a JWT.
function jwtExpMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

async function managedIdentityGetToken(scope: string): Promise<AccessTokenLike> {
  // Dynamic import keeps @azure/identity out of local dev / the test bundle.
  const { ManagedIdentityCredential } = await import('@azure/identity')
  const clientId = process.env.NUXT_AZURE_MI_CLIENT_ID
  const cred = clientId
    ? new ManagedIdentityCredential({ clientId })
    : new ManagedIdentityCredential()
  const tok = await cred.getToken(scope)
  if (!tok) throw new Error('ManagedIdentityCredential.getToken returned null (no MI on this compute?)')
  return { token: tok.token, expiresOnTimestamp: tok.expiresOnTimestamp }
}

function mockBearer(opts: { principalOid: string; sessionId: string }): ObOResult {
  const seed = `${opts.principalOid}|${opts.sessionId}`
  const bearer =
    'mock-monitor-bearer-' +
    createHmac('sha256', 'tokenscope-obo-mock').update(seed).digest('hex').slice(0, 32)
  return { bearer, expiresInSeconds: 3600 }
}

export async function mintAzureMonitorBearer(opts: {
  principalOid: string
  sessionId: string
  /** Injected for tests; defaults to the MI credential. */
  getToken?: GetTokenFn
  now?: number
}): Promise<ObOResult> {
  const now = opts.now ?? Date.now()

  if (process.env.NUXT_AZURE_MONITOR_AUTH === 'static') {
    // static mode hands an operator-minted REAL Azure token to every attested
    // client — a local / test seam ONLY. ALLOWLIST gate (shared/env/deploy-env.ts):
    // permitted only on a demo-capable env ({local, sandbox}). Bare local + CI/vitest
    // (no NUXT_DEPLOY_ENV, NODE_ENV !== 'production') classify to 'local' so the seam
    // still works with zero flags; any DEPLOYED env (dev/staging/production/unknown)
    // refuses unless the explicit NUXT_ALLOW_STATIC_BEARER=1 controlled-test override.
    // This replaces the old NODE_ENV==='production' denylist (NODE_ENV is 'production'
    // on every deployed container, so it failed to refuse dev/staging too).
    if (!areStaticBearerAllowed() && process.env.NUXT_ALLOW_STATIC_BEARER !== '1') {
      throw new Error(
        'NUXT_AZURE_MONITOR_AUTH=static is refused off a demo-capable env (set NUXT_ALLOW_STATIC_BEARER=1 to override for a controlled test)',
      )
    }
    const bearer = process.env.NUXT_AZURE_MONITOR_STATIC_BEARER
    if (!bearer) throw new Error('NUXT_AZURE_MONITOR_AUTH=static but NUXT_AZURE_MONITOR_STATIC_BEARER is unset')
    const expMs = jwtExpMs(bearer)
    const expiresInSeconds = expMs ? Math.max(1, Math.floor((expMs - REFRESH_SKEW_MS - now) / 1000)) : 600
    return { bearer, expiresInSeconds }
  }
  if (process.env.NUXT_AZURE_MONITOR_AUTH !== 'mi') {
    return mockBearer(opts)
  }
  // 'mi' mode mints a REAL Azure token from the app MI — assert the scope is
  // the ingest audience before any getToken, so a misconfigured override can
  // never produce a read-capable client bearer (fail closed; see the guard's
  // docstring). Cheap; any cached token was minted under the same assertion.
  assertAzureMonitorIngestScope(AZURE_MONITOR_INGEST_SCOPE)
  if (cached && now < cached.expiresAtMs) {
    return { bearer: cached.bearer, expiresInSeconds: Math.max(1, Math.floor((cached.expiresAtMs - now) / 1000)) }
  }
  // Single-flight (R1 #6): one in-flight refresh shared by all concurrent waiters.
  if (!inFlight) {
    const getToken = opts.getToken ?? managedIdentityGetToken
    inFlight = (async () => {
      const { token, expiresOnTimestamp } = await getToken(AZURE_MONITOR_INGEST_SCOPE)
      const expiresAtMs = Math.max(now + 1000, expiresOnTimestamp - REFRESH_SKEW_MS)
      cached = { bearer: token, expiresAtMs }
      return cached
    })().finally(() => {
      inFlight = null
    })
  }
  const fresh = await inFlight
  return { bearer: fresh.bearer, expiresInSeconds: Math.max(1, Math.floor((fresh.expiresAtMs - now) / 1000)) }
}
