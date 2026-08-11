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
 * RICH INSTALLATION DETAIL (Workstream D, coverage detection — design §6). The two
 * methods above collapse 404 (not installed) and a suspended installation to the
 * SAME `null`, which is exactly the gap that made an org we cannot see indistinguishable
 * from an org that spent nothing. `orgInstallationDetail` / `enterpriseInstallationDetail`
 * are the rich, backward-compatible siblings: they return a discriminated
 * {@link InstallationDetail} distinguishing 'not-found' | 'suspended' | 'different-app'
 * | 'active', by additionally comparing the installation's own `app_id` against this
 * instance's configured appId — a defensive verification that the installation
 * returned truly belongs to the App we authenticated as, not an assumption. The
 * existing `orgInstallationId` / `enterpriseInstallationId` are now THIN WRAPPERS over
 * these (collapsing 'not-found' | 'suspended' | 'different-app' to `null`, exactly as
 * before, plus the new different-app case — which the old code would have silently
 * treated as a hit and later failed at token-mint time anyway, so this is strictly
 * safer, never a behaviour regression for a caller that only wants an id-or-null).
 * BOTH throw exactly as before on a genuine transport/upstream failure (never
 * swallowed into a discriminated state) — that failure classification belongs to the
 * CALLER (coverage-compute.ts's OrgInstallationState carries the 'probe-failed' case
 * this module deliberately does not).
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
 *   - Installation DETAIL/id lookups (both rich and thin) are cached only for a
 *     short, BOUNDED TTL (default 60s, `installDetailTtlMs`), never indefinitely —
 *     unlike the installation TOKEN cache above (which is bounded by GitHub's own
 *     `expires_at`), nothing bounds a naive "cache forever" install-state cache, and a
 *     coverage sweep/recheck must see a permission revocation or a suspension within
 *     one short window, not "until the process restarts". A transient probe failure is
 *     NEVER cached as success, and — going further than "don't cache it" — ACTIVELY
 *     invalidates any prior cached success for that same key, so a current failure can
 *     never be shadowed by a stale "it was fine N seconds ago" read.
 *
 * Injectable `fetch` (defaults to the repo's resilientFetch) so tests inject canned
 * responses with no live GitHub calls.
 */
import { createSign, createPrivateKey, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { createError } from 'h3'
import { consola } from 'consola'
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

// Default bound for the installation-DETAIL cache (module header). Short on purpose —
// this is not a "cache forever" primitive like the installation TOKEN cache above
// (which is bounded by GitHub's own expires_at); it exists only to dedupe a burst of
// calls for the SAME org within one sweep/recheck tick, not to survive across ticks.
const DEFAULT_INSTALL_DETAIL_TTL_MS = 60_000

/** A minimal fetch signature — the real global fetch and resilientFetch both satisfy it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

// POST /app/installations/{id}/access_tokens response (only the fields we consume).
const InstallationTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(), // ISO-8601 UTC
})

// GET /orgs/{org}/installation and /enterprises/{slug}/installation (the id + suspend
// state + owning app id). app_id is OPTIONAL in the schema (defensive: an absent field
// must never fabricate a mismatch) but is present on GitHub's real Installation
// resource — read so orgInstallationDetail/enterpriseInstallationDetail can verify the
// installation returned truly belongs to THIS App, not assume it from the endpoint's
// (documented, but unverified-per-call) app-scoping alone.
const InstallationSchema = z
  .object({
    id: z.number(),
    app_id: z.number().optional(),
    suspended_at: z.string().nullable().optional(),
  })
  .passthrough()

/*
 * Rich, backward-compatible installation-detail result (Workstream D — design §6).
 * Four clean, mutually-exclusive outcomes; a genuine transport/upstream failure is
 * NEVER folded in here — it still throws (module header), exactly as
 * orgInstallationId/enterpriseInstallationId always have.
 */
export type InstallationDetail =
  | { status: 'not-found' }
  | { status: 'suspended'; installationId: number; appId: number | null }
  | { status: 'different-app'; installationId: number; appId: number }
  | { status: 'active'; installationId: number; appId: number | null }

interface CachedToken {
  token: string
  /** epoch ms at which we treat the token as expired (real expiry minus refresh skew). */
  refreshAfter: number
}

interface CachedDetail {
  detail: InstallationDetail
  /** epoch ms at which this cached SUCCESS is treated as expired (bounded TTL). */
  expiresAt: number
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
  /*
   * Installation-DETAIL lookups are memoized per account key ('org:<login>' /
   * 'ent:<slug>') for a short, BOUNDED TTL (installDetailTtlMs) — NOT indefinitely
   * (module header): a coverage sweep/recheck must observe a permission revocation or a
   * fresh suspension within one short window, never "until the process restarts". Dedups
   * concurrent cold lookups; a transient failure is NEVER cached as success, and actively
   * invalidates (deletes) any prior cached success for the same key.
   */
  private readonly detailCache = new Map<string, CachedDetail>()
  private readonly detailInflight = new Map<string, Promise<InstallationDetail>>()

  constructor(
    private readonly appId: string,
    /** The App private key, BASE64-encoded PEM (decoded + asserted here). */
    base64Pem: string,
    private readonly fetchImpl: FetchLike = resilientFetch,
    /** Injected clock (ms) for deterministic JWT timing + cache tests. */
    private readonly nowMs: () => number = () => Date.now(),
    /** Bound on the installation-detail cache (ms). Default 60s; tests pass a tiny
     *  value (or 0) to exercise expiry deterministically without waiting. */
    private readonly installDetailTtlMs: number = DEFAULT_INSTALL_DETAIL_TTL_MS,
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

  /**
   * Drop every cached installation-detail entry immediately — used by a caller (the
   * admin recheck route) that needs to GUARANTEE a fresh probe rather than rely on the
   * TTL having elapsed. Never throws; a no-op cache is a no-op to clear.
   */
  clearInstallationDetailCache(): void {
    this.detailCache.clear()
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
   * Memoized installation-DETAIL resolution (per account key), bounded by
   * installDetailTtlMs (module header + class doc). Dedups concurrent cold lookups.
   * A transient failure (the fetchFn REJECTS) is never cached as success — and
   * actively DELETES any prior cached success for the same key, so a current failure
   * can never be shadowed by a stale "it was fine N seconds ago" read. A resolved
   * detail (not-found / suspended / different-app / active) is cached for the bound.
   */
  private async resolveInstallationDetail(
    key: string,
    fetchFn: () => Promise<InstallationDetail>,
  ): Promise<InstallationDetail> {
    const cached = this.detailCache.get(key)
    if (cached && this.nowMs() < cached.expiresAt) return cached.detail
    const inflight = this.detailInflight.get(key)
    if (inflight) return inflight
    const p = fetchFn()
      .then((detail) => {
        this.detailCache.set(key, { detail, expiresAt: this.nowMs() + this.installDetailTtlMs })
        this.detailInflight.delete(key)
        return detail
      })
      .catch((err) => {
        // Never cache a rejection as success, and SUPPRESS any prior cached success —
        // a current failed probe must invalidate stale good news, not merely fail to
        // update it (it would otherwise keep being served until the old TTL elapsed).
        this.detailCache.delete(key)
        this.detailInflight.delete(key)
        throw err
      })
    this.detailInflight.set(key, p)
    return p
  }

  /**
   * Rich installation detail for an ORG's installation: GET /orgs/{org}/installation
   * (App-JWT auth). Distinguishes 'not-found' (404), 'suspended', 'different-app' (the
   * installation returned does not carry THIS App's own appId — a defensive check, not
   * an assumption from the endpoint's documented scoping), and 'active'. Throws exactly
   * as before (module header) on a genuine transport/upstream failure — that never
   * becomes a discriminated state here. MEMOIZED per org for a short bounded TTL (see
   * resolveInstallationDetail).
   */
  async orgInstallationDetail(org: string): Promise<InstallationDetail> {
    return this.resolveInstallationDetail(`org:${org}`, async () => {
      const res = await this.fetchImpl(`${API_BASE}/orgs/${encodeURIComponent(org)}/installation`, {
        headers: this.appJwtHeaders(),
      })
      if (res.status === 404) return { status: 'not-found' }
      if (!res.ok) this.fail('orgs/{org}/installation', res.status)
      const inst = InstallationSchema.parse(await res.json())
      const appId = inst.app_id ?? null
      if (appId !== null && Number(this.appId) !== appId) {
        // An installation exists, but it belongs to a DIFFERENT App than the one we
        // authenticated as. Logged (never the token/key) — this is a config anomaly an
        // operator should be able to see, not a silent success.
        consola.warn(
          `[github-app-auth] org installation for '${org}' belongs to app_id=${appId}, not our configured appId=${this.appId} — treating as unclassifiable`,
        )
        return { status: 'different-app', installationId: inst.id, appId }
      }
      if (inst.suspended_at) {
        // Suspended install → a distinct, reportable state (never folded into 404).
        consola.warn(`[github-app-auth] org installation for '${org}' is suspended`)
        return { status: 'suspended', installationId: inst.id, appId }
      }
      return { status: 'active', installationId: inst.id, appId }
    })
  }

  /**
   * Rich installation detail for the ENTERPRISE's installation: GET
   * /enterprises/{slug}/installation (App-JWT auth). Same discrimination as
   * orgInstallationDetail; memoized per slug.
   */
  async enterpriseInstallationDetail(slug: string): Promise<InstallationDetail> {
    return this.resolveInstallationDetail(`ent:${slug}`, async () => {
      const res = await this.fetchImpl(`${API_BASE}/enterprises/${encodeURIComponent(slug)}/installation`, {
        headers: this.appJwtHeaders(),
      })
      if (res.status === 404) return { status: 'not-found' }
      if (!res.ok) this.fail('enterprises/{slug}/installation', res.status)
      const inst = InstallationSchema.parse(await res.json())
      const appId = inst.app_id ?? null
      if (appId !== null && Number(this.appId) !== appId) {
        consola.warn(
          `[github-app-auth] enterprise installation for '${slug}' belongs to app_id=${appId}, not our configured appId=${this.appId} — treating as unclassifiable`,
        )
        return { status: 'different-app', installationId: inst.id, appId }
      }
      if (inst.suspended_at) {
        consola.warn(`[github-app-auth] enterprise installation for '${slug}' is suspended`)
        return { status: 'suspended', installationId: inst.id, appId }
      }
      return { status: 'active', installationId: inst.id, appId }
    })
  }

  /*
   * Resolve an ORG's installation id: GET /orgs/{org}/installation (App-JWT auth).
   * THIN WRAPPER (Workstream D) over orgInstallationDetail — returns null when the App
   * is NOT installed on the org (404), its install is SUSPENDED, or the installation
   * found belongs to a DIFFERENT App (a case the old code never checked for and would
   * have silently treated as a hit, later failing at token-mint time anyway — so
   * returning null here is strictly safer, not a behaviour regression). Every existing
   * caller that only wants "an id, or null to skip this org" is unaffected.
   */
  async orgInstallationId(org: string): Promise<number | null> {
    const detail = await this.orgInstallationDetail(org)
    return detail.status === 'active' ? detail.installationId : null
  }

  /*
   * Resolve the ENTERPRISE's installation id (for consumed-licenses identity):
   * GET /enterprises/{slug}/installation (App-JWT auth). THIN WRAPPER over
   * enterpriseInstallationDetail — same null/skip semantics as orgInstallationId.
   */
  async enterpriseInstallationId(slug: string): Promise<number | null> {
    const detail = await this.enterpriseInstallationDetail(slug)
    return detail.status === 'active' ? detail.installationId : null
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
