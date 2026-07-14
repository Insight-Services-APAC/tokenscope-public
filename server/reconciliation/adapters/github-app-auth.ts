/*
 * GitHub-App authentication — the App-JWT → installation-token minter for the
 * Copilot-reconciliation App-credential path
 * (docs/design/github-pat-to-github-app-transition.md).
 *
 * One GithubAppAuth instance is bound to ONE registered GitHub App (its numeric
 * appId + decoded PEM private key). It mints:
 *   - a short-lived App JWT (RS256, iss=appId) — used ONLY to call the App-auth
 *     endpoints below; never sent to a billing/identity surface;
 *   - per-installation INSTALLATION ACCESS TOKENS (IATs) via
 *     POST /app/installations/{id}/access_tokens — these are what the billing/seats/
 *     identity reads actually carry.
 *
 * It also RESOLVES installation ids by account, from the DB-enumerated orgs (never
 * from GET /app/installations — that would bleed across enterprises; requirement 2):
 *   - orgInstallationId(org)        → GET /orgs/{org}/installation
 *   - enterpriseInstallationId(slug) → GET /enterprises/{slug}/installation
 *
 * SECURITY (requirements 3 + 5, enforced here):
 *   - The PEM is multi-line and arrives BASE64-ENCODED at the GitHub-secret boundary
 *     (raw newlines don't survive GH-secret → bicep → KV → container-env). `decodePem`
 *     base64-DECODES it and ASSERTS it parses via crypto.createPrivateKey before use.
 *   - NOTHING here ever logs/throws the PEM, the App JWT, or an installation token.
 *     Errors carry only the surface + HTTP status (the worker logs scope separately).
 *   - JWT timing: iat = now-60 (clock-skew guard), exp = now+540 (9 min — GitHub caps
 *     at 10), alg RS256. Minted FRESH per token-exchange (never cached).
 *   - Only the INSTALLATION token is cached, keyed by installationId, honouring the
 *     response `expires_at` with a ~5-min refresh skew.
 *
 * Injectable `fetch` (defaults to the repo's resilientFetch) so tests inject canned
 * responses with no live GitHub calls.
 */
import { createSign, createPrivateKey, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { createError } from 'h3'
import { resilientFetch } from '../../utils/resilient-fetch'

const API_BASE = 'https://api.github.com'
// Pin the org/enterprise App-mode endpoints to the version verified against the
// App-permission docs on 2026-06-30. Matches github-client.ts's pin convention.
const APP_API_VERSION = '2026-03-10'

// JWT timing (GitHub's documented constraints): iat backdated 60 s to absorb clock
// skew; exp = iat + 540 s (9 min, under GitHub's 10-min hard cap).
const JWT_IAT_SKEW_SEC = 60
const JWT_LIFETIME_SEC = 540
// Refresh an installation token this long BEFORE its expires_at, so a token never
// expires mid-request. GitHub IATs live ~1 h; ~5 min skew is comfortable headroom.
const IAT_REFRESH_SKEW_MS = 5 * 60 * 1000

/** A minimal fetch signature — the real global fetch and resilientFetch both satisfy it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

// POST /app/installations/{id}/access_tokens response (only the fields we consume).
const InstallationTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(), // ISO-8601 UTC
})

// GET /orgs/{org}/installation and /enterprises/{slug}/installation (the id + suspend state).
const InstallationSchema = z
  .object({
    id: z.number(),
    suspended_at: z.string().nullable().optional(),
  })
  .passthrough()

interface CachedToken {
  token: string
  /** epoch ms at which we treat the token as expired (real expiry minus refresh skew). */
  refreshAfter: number
}

/** base64url with no padding — JWT segment encoding. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/*
 * Decode + validate the App private key. The env value is a BASE64-encoded PEM (see
 * the module header + credentials.ts). We base64-DECODE it, then ASSERT it parses as
 * an RSA private key. On any failure we throw a NON-LEAKING error (the PEM/decoded
 * bytes are never included) — a malformed key must fail loudly, not silently produce
 * unsigned/garbage JWTs.
 */
export function decodePem(base64Pem: string): KeyObject {
  let pem: string
  try {
    pem = Buffer.from(base64Pem, 'base64').toString('utf8')
  } catch {
    // Never surface the input — only that it failed to decode.
    throw new Error('github-app-auth: App private key is not valid base64')
  }
  // A real PEM has the BEGIN/END armour; reject obvious non-PEM early with a
  // non-leaking message (a base64-of-base64 mistake, or a raw PAT pasted by error).
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new Error('github-app-auth: decoded App key is not a PEM private key (missing armour)')
  }
  try {
    return createPrivateKey(pem)
  } catch {
    throw new Error('github-app-auth: App private key failed to parse (crypto.createPrivateKey rejected it)')
  }
}

export class GithubAppAuth {
  private readonly key: KeyObject
  /** installationId → cached IAT (refresh-skew honoured). Cleared lazily on expiry. */
  private readonly tokenCache = new Map<number, CachedToken>()
  /** In-flight token exchanges, keyed by installationId — dedups concurrent cold-cache mints. */
  private readonly tokenInflight = new Map<number, Promise<string>>()
  // Installation-id lookups are MEMOIZED per account: the adapter resolves the same org/
  // enterprise on every (seat, day), so re-querying /installation each time would double
  // the request volume + amplify the secondary-rate-limit risk. Cache the RESULT (incl.
  // null = not-installed/suspended); dedup concurrent cold lookups; never cache a
  // rejection (a transient failure must be retryable on the next sweep).
  private readonly installIdCache = new Map<string, number | null>()
  private readonly installIdInflight = new Map<string, Promise<number | null>>()

  constructor(
    private readonly appId: string,
    /** The App private key, BASE64-encoded PEM (decoded + asserted here). */
    base64Pem: string,
    private readonly fetchImpl: FetchLike = resilientFetch,
    /** Injected clock (ms) for deterministic JWT timing + cache tests. */
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    // Fail loud at construction (matches the PEM treatment): a non-numeric appId would
    // mint a JWT with a bad `iss` and 401 mid-reconciliation rather than a clear error.
    if (!/^\d+$/.test(appId)) {
      throw new Error('github-app-auth: appId must be a numeric GitHub App id')
    }
    // Assert the key parses at CONSTRUCTION (fail-loud) — not lazily on first sign,
    // which would defer a misconfiguration to mid-reconciliation.
    this.key = decodePem(base64Pem)
  }

  // Never leak token/JWT/PEM — only the surface + status (worker logs scope separately).
  private fail(surface: string, status: number): never {
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      data: {
        type: 'https://tokenscope.example.com/errors/github-app-upstream',
        title: 'GitHub App auth call failed',
        status: 502,
        detail: `${surface} returned HTTP ${status}`,
      },
    })
  }

  /*
   * Mint a fresh App JWT (RS256, iss=appId). PRIVATE: it authenticates ONLY the
   * App-auth endpoints (installation lookup + token exchange), never a data read.
   * Minted fresh every call — cheap, and avoids caching a credential that outlives a
   * single exchange. The signature input is the base64url header+payload; the PEM is
   * never serialised into any string we return or log.
   */
  private appJwt(): string {
    const now = Math.floor(this.nowMs() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = b64url(
      JSON.stringify({
        iat: now - JWT_IAT_SKEW_SEC,
        exp: now + JWT_LIFETIME_SEC,
        iss: this.appId,
      }),
    )
    const signingInput = `${header}.${payload}`
    const signer = createSign('RSA-SHA256')
    signer.update(signingInput)
    signer.end()
    const signature = b64url(signer.sign(this.key))
    return `${signingInput}.${signature}`
  }

  /** Headers for an App-JWT-authenticated request (the App-auth endpoints only). */
  private appJwtHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.appJwt()}`,
      Accept: 'application/vnd.github+json',
      // Verified against the App-permission docs on 2026-06-30.
      'X-GitHub-Api-Version': APP_API_VERSION,
      'User-Agent': 'tokenscope-reconciliation',
    }
  }

  /*
   * Memoized installation-id resolution (per account key). Caches the RESULT (incl.
   * null), dedups concurrent cold lookups, and never caches a rejection — this is what
   * stops the adapter's per-(seat,day) loop from re-querying /installation each time.
   */
  private async resolveInstallationId(key: string, fetchFn: () => Promise<number | null>): Promise<number | null> {
    const cached = this.installIdCache.get(key)
    if (cached !== undefined) return cached
    const inflight = this.installIdInflight.get(key)
    if (inflight) return inflight
    const p = fetchFn()
      .then((id) => {
        this.installIdCache.set(key, id)
        this.installIdInflight.delete(key)
        return id
      })
      .catch((err) => {
        this.installIdInflight.delete(key) // don't cache failures — allow a retry
        throw err
      })
    this.installIdInflight.set(key, p)
    return p
  }

  /*
   * Resolve an ORG's installation id: GET /orgs/{org}/installation (App-JWT auth).
   * Returns null when the App is NOT installed on the org (404) or its install is
   * SUSPENDED (logged carry-forward) — the caller then skips that org rather than
   * failing the whole sweep. Other non-OK statuses fail loud (transient upstream).
   * MEMOIZED per org (see resolveInstallationId) — one lookup per org per process tick.
   */
  async orgInstallationId(org: string): Promise<number | null> {
    return this.resolveInstallationId(`org:${org}`, async () => {
      const res = await this.fetchImpl(`${API_BASE}/orgs/${encodeURIComponent(org)}/installation`, {
        headers: this.appJwtHeaders(),
      })
      if (res.status === 404) return null // App not installed on this org
      if (!res.ok) this.fail('orgs/{org}/installation', res.status)
      const inst = InstallationSchema.parse(await res.json())
      if (inst.suspended_at) {
        // Suspended install → skip (carry-forward), don't error. Logged so a persistently
        // suspended org is visible, not a silent zero.
        console.warn(`[github-app-auth] org installation for '${org}' is suspended — skipping`)
        return null
      }
      return inst.id
    })
  }

  /*
   * Resolve the ENTERPRISE's installation id (for consumed-licenses identity):
   * GET /enterprises/{slug}/installation (App-JWT auth). Same null/skip semantics as
   * orgInstallationId; memoized per slug.
   */
  async enterpriseInstallationId(slug: string): Promise<number | null> {
    return this.resolveInstallationId(`ent:${slug}`, async () => {
      const res = await this.fetchImpl(`${API_BASE}/enterprises/${encodeURIComponent(slug)}/installation`, {
        headers: this.appJwtHeaders(),
      })
      if (res.status === 404) return null // App not installed on the enterprise
      if (!res.ok) this.fail('enterprises/{slug}/installation', res.status)
      const inst = InstallationSchema.parse(await res.json())
      if (inst.suspended_at) {
        console.warn(`[github-app-auth] enterprise installation for '${slug}' is suspended — skipping`)
        return null
      }
      return inst.id
    })
  }

  /*
   * Get a (cached) installation access token for one installation id:
   * POST /app/installations/{id}/access_tokens (App-JWT auth). The token is cached
   * keyed by installationId and reused until IAT_REFRESH_SKEW_MS before its expires_at;
   * a fresh App JWT is minted for each exchange. Concurrent cold-cache calls share one
   * exchange (in-flight dedup). The token value is never logged.
   */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId)
    if (cached && this.nowMs() < cached.refreshAfter) return cached.token
    const inflight = this.tokenInflight.get(installationId)
    if (inflight) return inflight

    const p = (async () => {
      const res = await this.fetchImpl(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: this.appJwtHeaders(),
      })
      if (!res.ok) this.fail('app/installations/{id}/access_tokens', res.status)
      const body = InstallationTokenSchema.parse(await res.json())
      const expiresMs = Date.parse(body.expires_at)
      // If GitHub ever returns an unparseable expires_at, treat the token as immediately
      // stale (refreshAfter in the past) so we never cache an unbounded credential.
      const refreshAfter = Number.isFinite(expiresMs) ? expiresMs - IAT_REFRESH_SKEW_MS : 0
      this.tokenCache.set(installationId, { token: body.token, refreshAfter })
      return body.token
    })().finally(() => this.tokenInflight.delete(installationId))
    this.tokenInflight.set(installationId, p)
    return p
  }
}
