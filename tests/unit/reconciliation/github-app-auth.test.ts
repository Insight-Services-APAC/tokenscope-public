/*
 * GithubAppAuth unit tests (no DB, no live HTTP — injected fetch + clock).
 *
 * Covers the security-load-bearing behaviours from the design + adversarial review:
 *   - the App JWT is RS256, iss=appId, iat=now-60, exp=now+540, and VERIFIES against an
 *     in-test RSA public key (we mint our OWN keypair so the test owns ground truth);
 *   - the multi-line PEM is BASE64-DECODED before use (a raw-PEM input fails; the
 *     base64 form parses);
 *   - the installation token is cached by id and REFRESHED past expires_at (minus skew);
 *   - installation ids resolve via /orgs|enterprises/{x}/installation, NOT /app/installations;
 *   - a suspended install is skipped (null), a 404 is null, other non-OK fails loud;
 *   - the PEM, the App JWT, and the installation token NEVER appear in a thrown error.
 */
import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, createVerify, createPublicKey, type KeyObject } from 'node:crypto'
import { GithubAppAuth, decodePem, type FetchLike } from '../../../server/reconciliation/adapters/github-app-auth'

const APP_ID = '1234567'

// One RSA keypair for the whole file — the App "private key" under test plus the public
// key we verify the JWT against. PKCS#1 PEM is what GitHub issues for an App.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const pubKeyObj: KeyObject = createPublicKey(publicKey)
/** The base64-encoded PEM, as it arrives over the GH-secret pipeline. */
const base64Pem = Buffer.from(privateKey).toString('base64')

/** A minimal Response stub good enough for GithubAppAuth's reads. */
function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Decode a base64url JWT segment to an object. */
function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

/** Verify a compact JWS against our public key (RS256). */
function jwtVerifies(jwt: string): boolean {
  const [h, p, s] = jwt.split('.')
  const v = createVerify('RSA-SHA256')
  v.update(`${h}.${p}`)
  v.end()
  const sig = Buffer.from(s!.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return v.verify(pubKeyObj, sig)
}

describe('decodePem', () => {
  it('base64-decodes the PEM and parses it (the happy path)', () => {
    expect(decodePem(base64Pem)).toBeTruthy()
  })

  it('rejects a RAW (un-base64) PEM — the pipeline always base64s it', () => {
    // Raw PEM base64-decodes to garbage (no PEM armour) → rejected, no leak.
    expect(() => decodePem(privateKey)).toThrow(/not a PEM private key|not valid base64|failed to parse/)
  })

  it('rejects a non-PEM value without leaking the input', () => {
    const garbage = Buffer.from('not-a-key-at-all').toString('base64')
    try {
      decodePem(garbage)
      throw new Error('expected decodePem to throw')
    } catch (e) {
      expect(String(e)).not.toContain('not-a-key-at-all')
    }
  })
})

describe('GithubAppAuth.appJwt (via a token exchange)', () => {
  it('mints an RS256 JWT that verifies, with iss=appId and the documented iat/exp window', async () => {
    const nowMs = 1_700_000_000_000 // fixed clock
    let captured: { url: string; init?: RequestInit } | null = null
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      captured = { url, init }
      return jsonRes(201, { token: 'ghs_INSTALL_TOKEN', expires_at: new Date(nowMs + 3600_000).toISOString() })
    })
    const auth = new GithubAppAuth(APP_ID, base64Pem, fetchImpl, () => nowMs)

    await auth.installationToken(42)

    // The Authorization header carries the App JWT (Bearer <jwt>).
    const authz = (captured!.init!.headers as Record<string, string>).Authorization
    const jwt = authz.replace(/^Bearer /, '')
    expect(jwtVerifies(jwt)).toBe(true)

    const payload = decodeSegment(jwt.split('.')[1]!)
    const header = decodeSegment(jwt.split('.')[0]!)
    expect(header.alg).toBe('RS256')
    expect(payload.iss).toBe(APP_ID)
    const nowSec = Math.floor(nowMs / 1000)
    expect(payload.iat).toBe(nowSec - 60) // clock-skew backdate
    expect(payload.exp).toBe(nowSec + 540) // 9-min lifetime
    // Pinned API version on the App-auth call.
    expect((captured!.init!.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2026-03-10')
    // POST to the token-exchange endpoint.
    expect(captured!.url).toContain('/app/installations/42/access_tokens')
    expect(captured!.init!.method).toBe('POST')
  })
})

describe('GithubAppAuth.installationToken (cache + expires_at refresh)', () => {
  it('caches per installation id and re-fetches only after expires_at minus skew', async () => {
    let clock = 1_700_000_000_000
    const expiresAt = new Date(clock + 60 * 60_000).toISOString() // +1h
    const fetchImpl = vi.fn(async () => jsonRes(201, { token: `tok-${fetchImpl.mock.calls.length}`, expires_at: expiresAt }))
    const auth = new GithubAppAuth(APP_ID, base64Pem, fetchImpl as unknown as FetchLike, () => clock)

    const a = await auth.installationToken(7)
    const b = await auth.installationToken(7) // cached → no new fetch
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // A different installation id is a separate cache entry → a new fetch.
    await auth.installationToken(8)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Advance to just before the refresh boundary (expires - 5min) → still cached.
    clock += 54 * 60_000 // +54m (refresh skew is 5m → boundary at +55m)
    await auth.installationToken(7)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Past the refresh boundary → re-fetch.
    clock += 2 * 60_000 // +56m total
    await auth.installationToken(7)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('treats an unparseable expires_at as immediately stale (never caches unbounded)', async () => {
    const clock = 1_700_000_000_000
    const fetchImpl = vi.fn(async () => jsonRes(201, { token: 'tok', expires_at: 'not-a-date' }))
    const auth = new GithubAppAuth(APP_ID, base64Pem, fetchImpl as unknown as FetchLike, () => clock)
    await auth.installationToken(1)
    await auth.installationToken(1) // refreshAfter=0 (in the past) → re-fetch
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('GithubAppAuth installation-id resolution (DB-enumerated, not /app/installations)', () => {
  it('orgInstallationId hits /orgs/{org}/installation and returns the id', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { id: 555, suspended_at: null }))
    const auth = new GithubAppAuth(APP_ID, base64Pem, fetchImpl as unknown as FetchLike)
    expect(await auth.orgInstallationId('acme-corp')).toBe(555)
    expect((fetchImpl.mock.calls[0]![0] as string)).toContain('/orgs/acme-corp/installation')
    // Must NOT enumerate from /app/installations (cross-enterprise bleed).
    expect((fetchImpl.mock.calls[0]![0] as string)).not.toContain('/app/installations')
  })

  it('enterpriseInstallationId hits /enterprises/{slug}/installation', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { id: 999, suspended_at: null }))
    const auth = new GithubAppAuth(APP_ID, base64Pem, fetchImpl as unknown as FetchLike)
    expect(await auth.enterpriseInstallationId('acme-partner-demo')).toBe(999)
    expect((fetchImpl.mock.calls[0]![0] as string)).toContain('/enterprises/acme-partner-demo/installation')
  })

  it('returns null for a 404 (App not installed) and for a suspended install', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notInstalled = new GithubAppAuth(APP_ID, base64Pem, (async () => jsonRes(404, {})) as FetchLike)
    expect(await notInstalled.orgInstallationId('no-install')).toBeNull()

    const suspended = new GithubAppAuth(
      APP_ID,
      base64Pem,
      (async () => jsonRes(200, { id: 1, suspended_at: '2026-06-01T00:00:00Z' })) as FetchLike,
    )
    expect(await suspended.orgInstallationId('susp-org')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails loud on a non-404 upstream error (e.g. 500)', async () => {
    const auth = new GithubAppAuth(APP_ID, base64Pem, (async () => jsonRes(500, {})) as FetchLike)
    await expect(auth.orgInstallationId('boom-org')).rejects.toMatchObject({ statusCode: 502 })
  })

  it('MEMOIZES the installation id per org — one /installation lookup across repeated calls', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { id: 555, suspended_at: null }))
    const auth = new GithubAppAuth(APP_ID, base64Pem, fetchImpl as unknown as FetchLike)
    // The adapter resolves the same org on every (seat, day) — it must NOT re-query GitHub
    // each time (that doubled request volume + amplified the secondary-rate-limit risk).
    await auth.orgInstallationId('acme-corp')
    await auth.orgInstallationId('acme-corp')
    await auth.orgInstallationId('acme-corp')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await auth.orgInstallationId('beta-team') // distinct cache key → one more lookup
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('GithubAppAuth constructor fails loud', () => {
  it('rejects a non-numeric appId (a bad iss would 401 mid-reconciliation)', () => {
    expect(() => new GithubAppAuth('not-a-number', base64Pem)).toThrow(/numeric/)
  })
})

describe('GithubAppAuth never leaks the PEM / JWT / token', () => {
  it('a token-exchange failure throws WITHOUT the JWT or PEM in the message', async () => {
    const auth = new GithubAppAuth(APP_ID, base64Pem, (async () => jsonRes(403, {})) as FetchLike)
    let thrown: unknown
    try {
      await auth.installationToken(13)
    } catch (e) {
      thrown = e
    }
    const dump = JSON.stringify(thrown ?? {}) + String(thrown)
    expect(dump).not.toContain(base64Pem)
    expect(dump).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(dump).not.toContain('PRIVATE KEY')
    // No bearer JWT material either.
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]+\./)
  })
})
