/*
 * GithubCopilotClient App-mode unit tests (no DB; resilientFetch fully mocked).
 *
 * Drives the NEW App-mode methods (getUserDailyCredits + consumedLicenses) through a
 * single mocked resilientFetch that routes by URL — covering BOTH the App-auth calls
 * (installation lookup + token exchange, which GithubAppAuth makes through the same
 * resilientFetch) AND the data reads. Asserts the request URLs, the installation-token
 * Authorization, and the pinned X-GitHub-Api-Version on every enterprise surface.
 *
 * The legacy PAT methods are NOT exercised here — their behaviour is unchanged and
 * covered by the existing github tests (back-compat).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

// Mock the shared outbound chokepoint; the client AND GithubAppAuth both call it.
// vi.mock is hoisted above these imports, so they must follow it — the import/first
// rule is disabled for exactly that vitest idiom.
vi.mock('../../../server/utils/resilient-fetch', () => ({
  resilientFetch: vi.fn(),
}))
/* eslint-disable import/first */
import { resilientFetch } from '../../../server/utils/resilient-fetch'
import { GithubCopilotClient } from '../../../server/reconciliation/adapters/github-client'
import { GithubAppAuth } from '../../../server/reconciliation/adapters/github-app-auth'
/* eslint-enable import/first */

const mockFetch = resilientFetch as unknown as ReturnType<typeof vi.fn>

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const base64Pem = Buffer.from(privateKey).toString('base64')
const APP_ID = '424242'
const ENT = 'acme-partner-demo'

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

// A text/NDJSON response (the metrics report's signed download files, and error bodies
// the client reads via res.text() on a non-OK response).
function textRes(status: number, text: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response
}

/*
 * A canned-response router keyed by URL substring. Records every (url, headers) so the
 * assertions can inspect pinned versions + the installation-token Authorization.
 */
interface Recorded {
  url: string
  headers: Record<string, string>
  method?: string
}
function installRouter(routes: { match: string; res: () => Response }[]): Recorded[] {
  const seen: Recorded[] = []
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers as Record<string, string>) ?? {}, method: init?.method })
    const r = routes.find((x) => url.includes(x.match))
    if (!r) throw new Error(`no canned route for ${url}`)
    return r.res()
  })
  return seen
}

const INSTALL_TOKEN = 'ghs_INSTALLATION_TOKEN_DO_NOT_LEAK'
const tokenRoute = {
  match: '/access_tokens',
  res: () => jsonRes(201, { token: INSTALL_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
}

function client(): GithubCopilotClient {
  return GithubCopilotClient.withApp(ENT, new GithubAppAuth(APP_ID, base64Pem))
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('getUserDailyCredits (Enterprise Copilot metrics read)', () => {
  it('resolves the enterprise install, hits users-1-day with the pinned version, downloads the NDJSON, and maps login → ai_credits_used', async () => {
    const ndjson = [
      JSON.stringify({ user_login: 'octocat', user_id: 1, day: '2026-06-29', ai_credits_used: 562.57 }),
      JSON.stringify({ user_login: 'qkfang', day: '2026-06-29', ai_credits_used: 10 }),
      JSON.stringify({ user_login: 'nocredits', day: '2026-06-29' }), // ai_credits_used absent → 0
      JSON.stringify({ user_id: 99, ai_credits_used: 5 }), // no user_login → skipped
      '', // blank line tolerated
      '{ not valid json', // unparseable line skipped, never fatal
    ].join('\n')
    const seen = installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
      tokenRoute,
      {
        match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
        res: () => jsonRes(200, { download_links: ['https://blob.example/report.ndjson?sig=abc'], report_day: '2026-06-29' }),
      },
      { match: 'blob.example/report.ndjson', res: () => textRes(200, ndjson) },
    ])

    const rows = await client().getUserDailyCredits('2026-06-29')
    expect(rows).toEqual([
      { login: 'octocat', credits: 562.57, raw: expect.objectContaining({ user_login: 'octocat', ai_credits_used: 562.57 }) },
      { login: 'qkfang', credits: 10, raw: expect.objectContaining({ user_login: 'qkfang' }) },
      { login: 'nocredits', credits: 0, raw: expect.objectContaining({ user_login: 'nocredits' }) },
    ])

    const reportCall = seen.find((s) => s.url.includes('/metrics/reports/users-1-day'))!
    expect(reportCall.url).toContain(`/enterprises/${ENT}/copilot/metrics/reports/users-1-day`)
    expect(reportCall.url).toContain('day=2026-06-29')
    expect(reportCall.headers.Authorization).toBe(`Bearer ${INSTALL_TOKEN}`)
    expect(reportCall.headers['X-GitHub-Api-Version']).toBe('2026-03-10')

    // The signed download URL is fetched WITHOUT the installation bearer (it can break the
    // pre-signed blob signature).
    const dlCall = seen.find((s) => s.url.includes('blob.example'))!
    expect(dlCall.headers.Authorization).toBeUndefined()
  })

  it('fails loud (502) when the App is not installed on the enterprise', async () => {
    installRouter([{ match: `/enterprises/${ENT}/installation`, res: () => jsonRes(404, {}) }])
    await expect(client().getUserDailyCredits('2026-06-29')).rejects.toMatchObject({ statusCode: 502 })
  })

  it('surfaces the GitHub error body on a non-OK report response', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
      tokenRoute,
      {
        match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
        res: () => textRes(403, '{"message":"Resource not accessible by integration"}'),
      },
    ])
    await expect(client().getUserDailyCredits('2026-06-29')).rejects.toMatchObject({
      statusCode: 502,
      data: { detail: expect.stringContaining('Resource not accessible by integration') },
    })
  })

  it('carries the day forward (not a silent zero) when the report is not ready — no download_links', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
      tokenRoute,
      { match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`, res: () => jsonRes(200, { download_links: [], report_day: '2026-06-29' }) },
    ])
    await expect(client().getUserDailyCredits('2026-06-29')).rejects.toMatchObject({
      statusCode: 502,
      data: { detail: expect.stringContaining('report not ready') },
    })
  })

  it('carries the day forward when report_day != the requested day (anti-mis-dating)', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
      tokenRoute,
      {
        match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
        res: () => jsonRes(200, { download_links: ['https://blob.example/r.ndjson'], report_day: '2026-06-28' }),
      },
    ])
    await expect(client().getUserDailyCredits('2026-06-29')).rejects.toMatchObject({
      statusCode: 502,
      data: { detail: expect.stringContaining('report_day 2026-06-28') },
    })
  })

  it('refuses a non-HTTPS download link (defence in depth — never fetched)', async () => {
    const seen = installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
      tokenRoute,
      {
        match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
        res: () => jsonRes(200, { download_links: ['http://blob.example/r.ndjson'], report_day: '2026-06-29' }),
      },
    ])
    await expect(client().getUserDailyCredits('2026-06-29')).rejects.toMatchObject({
      statusCode: 502,
      data: { detail: expect.stringContaining('non-HTTPS') },
    })
    // The insecure link is never fetched.
    expect(seen.some((s) => s.url.includes('blob.example'))).toBe(false)
  })
})

describe('consumedLicenses (Enterprise administration read)', () => {
  it('hits the enterprise consumed-licenses endpoint and maps login → saml name id', async () => {
    const seen = installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
      tokenRoute,
      {
        match: `/enterprises/${ENT}/consumed-licenses`,
        res: () =>
          jsonRes(200, {
            users: [
              { github_com_login: 'octocat', github_com_saml_name_id: 'veli@example.com' },
              { github_com_login: 'no-sso', github_com_saml_name_id: null }, // skipped
            ],
          }),
      },
    ])

    const ids = await client().consumedLicenses()
    expect(ids).toEqual([{ login: 'octocat', ssoEmail: 'veli@example.com' }])

    const dataCall = seen.find((s) => s.url.includes('/consumed-licenses'))!
    expect(dataCall.url).toContain(`/enterprises/${ENT}/consumed-licenses`)
    expect(dataCall.headers.Authorization).toBe(`Bearer ${INSTALL_TOKEN}`)
    expect(dataCall.headers['X-GitHub-Api-Version']).toBe('2026-03-10')
  })

  it('fails loud when the App is not installed on the enterprise (no identity bridge)', async () => {
    installRouter([{ match: `/enterprises/${ENT}/installation`, res: () => jsonRes(404, {}) }])
    await expect(client().consumedLicenses()).rejects.toMatchObject({ statusCode: 502 })
  })
})

describe('App-mode methods reject a PAT-mode client', () => {
  it('throws a 500 misconfig when called without an App credential', async () => {
    const patClient = GithubCopilotClient.withPat(ENT, 'ghp_classic_pat')
    await expect(patClient.consumedLicenses()).rejects.toMatchObject({ statusCode: 500 })
  })
  it('listOrgCopilotSeats also rejects a PAT-mode client (App-only)', async () => {
    const patClient = GithubCopilotClient.withPat(ENT, 'ghp_classic_pat')
    await expect(patClient.listOrgCopilotSeats('acme-org')).rejects.toMatchObject({ statusCode: 500 })
  })
})

const ORG = 'acme-org'

describe('listOrgCopilotSeats (App mode, per-org Copilot seats)', () => {
  it('resolves the ORG install, pages org copilot seats, returns {login, org} with the org token + pinned version', async () => {
    const seen = installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      {
        match: `/orgs/${ORG}/copilot/billing/seats`,
        res: () => jsonRes(200, { seats: [{ assignee: { login: 'octocat' } }, { assignee: { login: 'qkfang' } }] }),
      },
    ])

    const seats = await client().listOrgCopilotSeats(ORG)
    expect(seats).toEqual([
      { login: 'octocat', org: ORG },
      { login: 'qkfang', org: ORG },
    ])

    const seatsCall = seen.find((s) => s.url.includes('/copilot/billing/seats'))!
    expect(seatsCall.url).toContain(`/orgs/${ORG}/copilot/billing/seats`)
    expect(seatsCall.headers.Authorization).toBe(`Bearer ${INSTALL_TOKEN}`)
    expect(seatsCall.headers['X-GitHub-Api-Version']).toBe('2026-03-10')
  })

  it('skips cleanly (returns []) when the App is not installed on the org — no token minted, no seats call', async () => {
    const seen = installRouter([{ match: `/orgs/${ORG}/installation`, res: () => jsonRes(404, {}) }])
    const seats = await client().listOrgCopilotSeats(ORG)
    expect(seats).toEqual([])
    expect(seen.some((s) => s.url.includes('/access_tokens'))).toBe(false)
    expect(seen.some((s) => s.url.includes('/copilot/billing/seats'))).toBe(false)
  })

  it('fails loud (502) — never the token — on a non-OK seats response', async () => {
    installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      { match: `/orgs/${ORG}/copilot/billing/seats`, res: () => jsonRes(403, {}) },
    ])
    await expect(client().listOrgCopilotSeats(ORG)).rejects.toMatchObject({ statusCode: 502 })
  })
})

describe('listSamlIdentities (App mode, per-org externalIdentities via the org token)', () => {
  it('resolves the ORG install and reads externalIdentities with the org token (login → sso email)', async () => {
    const seen = installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      {
        match: '/graphql',
        res: () =>
          jsonRes(200, {
            data: {
              organization: {
                samlIdentityProvider: {
                  externalIdentities: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      { samlIdentity: { nameId: 'veli@example.com' }, user: { login: 'octocat' } },
                      { samlIdentity: { nameId: null }, user: { login: 'no-sso' } }, // no email → skipped
                    ],
                  },
                },
              },
            },
          }),
      },
    ])

    const ids = await client().listSamlIdentities(ORG)
    expect(ids).toEqual([{ login: 'octocat', ssoEmail: 'veli@example.com' }])

    const gql = seen.find((s) => s.url.includes('/graphql'))!
    expect(gql.headers.Authorization).toBe(`Bearer ${INSTALL_TOKEN}`)
    expect(gql.headers['X-GitHub-Api-Version']).toBe('2026-03-10')
    expect(gql.headers['Content-Type']).toBe('application/json')
  })

  it('skips cleanly (returns []) when the App is not installed on the org — no GraphQL / token call', async () => {
    const seen = installRouter([{ match: `/orgs/${ORG}/installation`, res: () => jsonRes(404, {}) }])
    const ids = await client().listSamlIdentities(ORG)
    expect(ids).toEqual([])
    expect(seen.some((s) => s.url.includes('/graphql'))).toBe(false)
    expect(seen.some((s) => s.url.includes('/access_tokens'))).toBe(false)
  })

  it('throws (degrades to carry-forward) on a GraphQL permission error (FORBIDDEN)', async () => {
    installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      { match: '/graphql', res: () => jsonRes(200, { errors: [{ type: 'FORBIDDEN', message: 'x' }] }) },
    ])
    await expect(client().listSamlIdentities(ORG)).rejects.toMatchObject({ statusCode: 502 })
  })
})
