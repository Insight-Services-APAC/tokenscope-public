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

/*
 * rawUserDailyCreditsPage — the DIAGNOSTIC two-step read behind the wire-shape
 * probe's 'github-user-daily-credits' surface.
 *
 * Two properties are load-bearing and both are asserted below:
 *   1. It is BOUNDED and reports its bound. One report, one link, a line cap —
 *      and linksAvailable/linksRead/linesCapped so a sample cannot read as a
 *      census.
 *   2. The SIGNED LINK never escapes through TEXT THIS METHOD BUILDS. download_links
 *      values are capability URLs, and the failure paths are where one escapes:
 *      a blob store's error body and a transport error's message both quote the
 *      request URL. `envelope.body` is a deliberate exception — it is the report
 *      verbatim, which is the point of a raw accessor, and it is the shape
 *      summariser's key denylist that withholds those values from the report an
 *      operator reads (proved in provider-wire-probe-two-step.test.ts and
 *      provider-wire-shape.test.ts, not here).
 */

/*
 * UserMetricsRecordSchema's declared dimensions (task #48).
 *
 * The schema is not exported, so every assertion here drives it through the REAL
 * consumer (`getUserDailyCredits`), which is where the risk actually lives: that
 * method parses each NDJSON line inside a try/catch that SKIPS the line, so a
 * declaration that fails on a shape surprise silently costs a user-day's credits.
 * A test against the exported schema object could not see that at all.
 */
describe('the declared dimensions never cost a record its credits (#48)', () => {
  const day = '2026-08-01'
  const routes = (ndjson: string) => [
    { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
    tokenRoute,
    {
      match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
      res: () => jsonRes(200, { download_links: ['https://blob.example/r.ndjson'], report_day: day }),
    },
    { match: 'blob.example/r.ndjson', res: () => textRes(200, ndjson) },
  ]

  it('parses the model dimension and the CLI token sums onto the record', async () => {
    /*
     * The shapes are the OBSERVED ones —
     * docs/design/provider-wire-captures/2026-08-02-provider-wire-shape.json.
     * MUTATION: drop `totals_by_model_feature` from UserMetricsRecordSchema →
     * `.passthrough()` still carries the value, but it is `unknown` rather than
     * the declared array, and the typed read below stops compiling; delete the
     * field from the FIXTURE instead and the first expect goes red.
     */
    installRouter(
      routes(
        JSON.stringify({
          user_login: 'octocat',
          day,
          ai_credits_used: 100,
          totals_by_model_feature: [
            { model: 'gpt-5', feature: 'chat', user_initiated_interaction_count: 7 },
            { model: 'gpt-5', feature: 'agent', user_initiated_interaction_count: 3 },
          ],
          totals_by_cli: { prompt_count: 4, token_usage: { prompt_tokens_sum: 900, output_tokens_sum: 100 } },
        }),
      ),
    )

    const [row] = await client().getUserDailyCredits(day)
    const raw = row!.raw as {
      totals_by_model_feature?: Array<{ model?: string | null; user_initiated_interaction_count?: number | null }>
      totals_by_cli?: { token_usage?: { prompt_tokens_sum?: number | null } | null }
    }
    expect(raw.totals_by_model_feature).toHaveLength(2)
    expect(raw.totals_by_model_feature![0]!.model).toBe('gpt-5')
    expect(raw.totals_by_model_feature![0]!.user_initiated_interaction_count).toBe(7)
    expect(raw.totals_by_cli!.token_usage!.prompt_tokens_sum).toBe(900)
    // Undeclared engagement fields still ride through .passthrough().
    expect((row!.raw as { totals_by_cli: { prompt_count: number } }).totals_by_cli.prompt_count).toBe(4)
  })

  it('parses the Copilot App token sums as a surface distinct from the CLI', async () => {
    /*
     * `totals_by_copilot_app` is the second harness surface (capture 2026-08-19,
     * 2/74 records). Both subtrees carry the same token_usage shape, so the risk
     * is reading one and silently attributing it to the other.
     *
     * A ROUND-TRIP check only: the root schema is `.passthrough()`, so this passes
     * with or without the declaration. What the declaration buys is pinned by the
     * wrong-shape test below — do not read this one as proving it exists.
     */
    installRouter(
      routes(
        JSON.stringify({
          user_login: 'octocat',
          day,
          ai_credits_used: 100,
          totals_by_cli: { token_usage: { prompt_tokens_sum: 900, output_tokens_sum: 100 } },
          totals_by_copilot_app: {
            session_count: 1,
            token_usage: { prompt_tokens_sum: 40, output_tokens_sum: 60 },
          },
        }),
      ),
    )

    const [row] = await client().getUserDailyCredits(day)
    const raw = row!.raw as Record<string, { token_usage?: { prompt_tokens_sum?: number | null } }>
    expect(raw.totals_by_cli!.token_usage!.prompt_tokens_sum).toBe(900)
    expect(raw.totals_by_copilot_app!.token_usage!.prompt_tokens_sum).toBe(40)
  })

  it('keeps the credits AND normalises the subtree to absent when Copilot App arrives in the WRONG SHAPE', async () => {
    /*
     * Two mutations, and the pair is the point — either alone leaves a hole:
     *   - remove `.catch(undefined)` → the record fails to parse, the line is
     *     skipped, and this user-day's credits vanish. First assertion goes red.
     *   - delete the `totals_by_copilot_app` declaration outright → the root
     *     `.passthrough()` carries the bad array through verbatim, so the subtree
     *     is NOT normalised to absent. Last assertion goes red.
     * Without the second assertion the declaration can be deleted with every test
     * still green (measured), because passthrough hides its absence.
     */
    installRouter(
      routes(
        JSON.stringify({
          user_login: 'octocat',
          day,
          ai_credits_used: 100,
          totals_by_copilot_app: ['not', 'an', 'object'],
        }),
      ),
    )

    const rows = await client().getUserDailyCredits(day)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.credits).toBe(100)
    expect((rows[0]!.raw as Record<string, unknown>).totals_by_copilot_app).toBeUndefined()
  })

  it('keeps the credits when a declared dimension arrives in the WRONG SHAPE', async () => {
    /*
     * The hazard #48 introduces, in its sharpest form. `totals_by_cli` as an
     * ARRAY and `totals_by_model_feature` as a STRING are both type violations
     * of the new declarations. Without `.catch(undefined)` on each field the
     * record fails to parse, `getUserDailyCredits` skips the line, and this
     * user's whole day of AI credits disappears from reconciliation — a money
     * loss caused by wanting to read a dimension.
     *
     * MUTATION: remove `.catch(undefined)` from either field → the record is
     * dropped and `rows` is empty, so this goes red on the first assertion.
     */
    installRouter(
      routes(
        JSON.stringify({
          user_login: 'octocat',
          day,
          ai_credits_used: 562.57,
          totals_by_model_feature: 'not-an-array',
          totals_by_cli: [{ token_usage: 'also-wrong' }],
        }),
      ),
    )

    const rows = await client().getUserDailyCredits(day)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.login).toBe('octocat')
    expect(rows[0]!.credits).toBe(562.57)
    // The dimension degrades to absent — never a fabricated empty array.
    expect((rows[0]!.raw as { totals_by_model_feature?: unknown }).totals_by_model_feature).toBeUndefined()
    expect((rows[0]!.raw as { totals_by_cli?: unknown }).totals_by_cli).toBeUndefined()
  })

  it('tolerates a record carrying neither dimension (the ordinary case — 153/200 have no CLI subtree)', async () => {
    installRouter(routes(JSON.stringify({ user_login: 'qkfang', day, ai_credits_used: 10 })))
    const rows = await client().getUserDailyCredits(day)
    expect(rows).toEqual([{ login: 'qkfang', credits: 10, raw: expect.objectContaining({ user_login: 'qkfang' }) }])
  })

  it('parses the W0b engagement fields onto the record (D7 — LOC sums, activity counts, language arrays)', async () => {
    /*
     * The observed shapes (2026-08-02 capture: the scalars are "number, 100%";
     * the language arrays inventory model/language keys). The per-entry
     * interaction count on the language arrays is the D9 CANDIDATE measure —
     * declared nullish, so a wire that sends it gets typed weights and a wire
     * that does not still parses (the ladder degrades read-side).
     *
     * MUTATION: drop any engagement scalar from UserMetricsRecordSchema → it
     * still rides .passthrough(), so delete it from the FIXTURE and the typed
     * expect goes red; drop `totals_by_language_model` from the schema and the
     * declared-entry expects stop compiling.
     */
    installRouter(
      routes(
        JSON.stringify({
          user_login: 'octocat',
          day,
          ai_credits_used: 100,
          loc_added_sum: 120,
          loc_deleted_sum: 30,
          loc_suggested_to_add_sum: 200,
          loc_suggested_to_delete_sum: 40,
          code_generation_activity_count: 15,
          code_acceptance_activity_count: 9,
          user_initiated_interaction_count: 33,
          totals_by_language_model: [
            { language: 'typescript', model: 'gpt-5', user_initiated_interaction_count: 21 },
            { language: 'python', model: 'gpt-5' }, // measure absent — must still parse
          ],
          totals_by_language_feature: [
            { language: 'typescript', feature: 'chat', user_initiated_interaction_count: 18 },
          ],
        }),
      ),
    )

    const [row] = await client().getUserDailyCredits(day)
    const raw = row!.raw as {
      loc_added_sum?: number | null
      loc_deleted_sum?: number | null
      loc_suggested_to_add_sum?: number | null
      loc_suggested_to_delete_sum?: number | null
      code_generation_activity_count?: number | null
      code_acceptance_activity_count?: number | null
      user_initiated_interaction_count?: number | null
      totals_by_language_model?: Array<{
        language?: string | null
        model?: string | null
        user_initiated_interaction_count?: number | null
      }>
      totals_by_language_feature?: Array<{
        language?: string | null
        feature?: string | null
        user_initiated_interaction_count?: number | null
      }>
    }
    expect(raw.loc_added_sum).toBe(120)
    expect(raw.loc_deleted_sum).toBe(30)
    expect(raw.loc_suggested_to_add_sum).toBe(200)
    expect(raw.loc_suggested_to_delete_sum).toBe(40)
    expect(raw.code_generation_activity_count).toBe(15)
    expect(raw.code_acceptance_activity_count).toBe(9)
    expect(raw.user_initiated_interaction_count).toBe(33)
    expect(raw.totals_by_language_model).toHaveLength(2)
    expect(raw.totals_by_language_model![0]!.language).toBe('typescript')
    expect(raw.totals_by_language_model![0]!.user_initiated_interaction_count).toBe(21)
    // The measure-less entry parses with the candidate measure absent.
    expect(raw.totals_by_language_model![1]!.user_initiated_interaction_count).toBeUndefined()
    expect(raw.totals_by_language_feature![0]!.user_initiated_interaction_count).toBe(18)
  })

  it('keeps the credits when the W0b engagement fields arrive in the WRONG SHAPE (the #48 catch discipline)', async () => {
    /*
     * Same hazard as the model/CLI test above, for every field W0b declares: a
     * string where a number is declared, an object where an array is declared.
     * Without `.catch(undefined)` on EACH the record fails to parse,
     * getUserDailyCredits skips the line, and the day's credits vanish because
     * we wanted to read an engagement dimension.
     *
     * MUTATION: remove `.catch(undefined)` from any engagement field → the
     * record is dropped and the first assertion goes red.
     */
    installRouter(
      routes(
        JSON.stringify({
          user_login: 'octocat',
          day,
          ai_credits_used: 77.5,
          loc_added_sum: 'not-a-number',
          loc_suggested_to_add_sum: { nested: true },
          code_generation_activity_count: 'nope',
          user_initiated_interaction_count: [1, 2],
          totals_by_language_model: 'not-an-array',
          totals_by_language_feature: { language: 'ts' },
        }),
      ),
    )

    const rows = await client().getUserDailyCredits(day)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.credits).toBe(77.5)
    const raw = rows[0]!.raw as Record<string, unknown>
    // Every wrongly-shaped dimension degrades to ABSENT — never a fabricated value.
    expect(raw.loc_added_sum).toBeUndefined()
    expect(raw.loc_suggested_to_add_sum).toBeUndefined()
    expect(raw.code_generation_activity_count).toBeUndefined()
    expect(raw.user_initiated_interaction_count).toBeUndefined()
    expect(raw.totals_by_language_model).toBeUndefined()
    expect(raw.totals_by_language_feature).toBeUndefined()
  })
})

describe('rawUserDailyCreditsPage (wire-shape probe two-step read)', () => {
  const LINK_A = 'https://blob.example/report-a.ndjson?sig=SIGNED_A&exp=1'
  const LINK_B = 'https://blob.example/report-b.ndjson?sig=SIGNED_B&exp=1'
  const envelopeRoute = (body: unknown) => ({
    match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
    res: () => textRes(200, JSON.stringify(body)),
  })
  const installRoutes = [
    { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 77, suspended_at: null }) },
    tokenRoute,
  ]

  it('reads the envelope and ONE file unparsed, and states every bound it applied', async () => {
    const lines = [
      // An UNDECLARED field on the first record. Zod would keep it (passthrough)
      // but getUserDailyCredits throws the record away bar two fields, which is
      // exactly why the probe needs its own accessor.
      JSON.stringify({ user_login: 'a', day: '2026-06-29', ai_credits_used: 1, ai_adoption_phase: 'power' }),
      JSON.stringify({ user_login: 'b', day: '2026-06-29', ai_credits_used: 2 }),
      '',
      '{ not json',
      JSON.stringify({ user_login: 'd', day: '2026-06-29', ai_credits_used: 4 }),
    ].join('\n')
    const seen = installRouter([
      ...installRoutes,
      envelopeRoute({ download_links: [LINK_A, LINK_B], report_day: '2026-06-29' }),
      { match: 'report-a.ndjson', res: () => textRes(200, lines) },
      { match: 'report-b.ndjson', res: () => textRes(200, 'SECOND FILE SHOULD NEVER BE READ') },
    ])

    const raw = await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })

    expect(raw.envelope.ok).toBe(true)
    if (!raw.envelope.ok) return
    // The envelope arrives UNPARSED — MetricsReportSchema would have dropped any
    // key it does not declare, and the probe exists to see those.
    expect(raw.envelope.body).toMatchObject({ report_day: '2026-06-29' })
    expect(raw.path).toBe(`/enterprises/${ENT}/copilot/metrics/reports/users-1-day`)
    expect(raw.params).toEqual([['day', '2026-06-29']])

    const nd = raw.ndjson!
    expect(nd.linksAvailable).toBe(2)
    // ONE link followed, not both — the second file's marker proves it.
    expect(nd.linksRead).toBe(1)
    expect(seen.some((s) => s.url.includes('report-b.ndjson'))).toBe(false)
    // Three non-blank lines consumed of four, then the cap stopped the read.
    expect(nd.lineLimit).toBe(3)
    expect(nd.linesRead).toBe(3)
    expect(nd.linesCapped).toBe(true)
    expect(nd.linesUnparseable).toBe(1)
    expect(nd.error).toBeNull()
    // The unparseable line is skipped, the ones before it survive verbatim, and
    // the fourth record is beyond the cap and absent.
    expect(nd.records).toEqual([
      { user_login: 'a', day: '2026-06-29', ai_credits_used: 1, ai_adoption_phase: 'power' },
      { user_login: 'b', day: '2026-06-29', ai_credits_used: 2 },
    ])
  })

  it('reports an unbounded-looking read honestly when the file fits inside the cap', async () => {
    // The sibling of the case above: `linesCapped` must be FALSE for a file the
    // cap did not touch, or every run claims truncation and the flag stops meaning
    // anything (the same reasoning as the stored scan's `capped`).
    installRouter([
      ...installRoutes,
      envelopeRoute({ download_links: [LINK_A], report_day: '2026-06-29' }),
      { match: 'report-a.ndjson', res: () => textRes(200, JSON.stringify({ user_login: 'a' })) },
    ])
    const nd = (await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })).ndjson!
    expect(nd.linesRead).toBe(1)
    expect(nd.linesCapped).toBe(false)
  })

  it('never returns the signed link when the download fails, and does return the provider text', async () => {
    // A blob store quotes the request URL back in its error body. That is the
    // realistic way a capability URL escapes into an operator-facing report.
    installRouter([
      ...installRoutes,
      envelopeRoute({ download_links: [LINK_A], report_day: '2026-06-29' }),
      {
        match: 'report-a.ndjson',
        res: () => textRes(403, `<Error><Code>AuthenticationFailed</Code><Resource>${LINK_A}</Resource></Error>`),
      },
    ])
    const raw = await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })
    const nd = raw.ndjson!
    expect(nd.error?.status).toBe(403)
    expect(nd.records).toEqual([])
    expect(nd.linksRead).toBe(0)
    // The provider's own cause survives — a classified reason would hide it...
    expect(nd.error?.bodyText).toContain('AuthenticationFailed')
    // ...but the signature it quoted back does not.
    expect(nd.error?.bodyText).not.toContain('SIGNED_A')
    // Nor anywhere else this method builds. `envelope` is excluded because it is
    // the provider's body verbatim, by design (see this describe's header).
    const built = { path: raw.path, params: raw.params, ndjson: raw.ndjson }
    expect(JSON.stringify(built)).not.toContain('SIGNED_A')
  })

  it('never returns the signed link when the download throws before a response', async () => {
    // undici puts the request URL on the error's `cause`, and a caller that
    // stringifies the error is one line away from emitting it. The message is
    // scrubbed against the link regardless of where it came from.
    installRouter([
      ...installRoutes,
      envelopeRoute({ download_links: [LINK_A], report_day: '2026-06-29' }),
      {
        match: 'report-a.ndjson',
        res: () => {
          throw new Error(`connect ECONNREFUSED for ${LINK_A}`)
        },
      },
    ])
    const raw = await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })
    expect(raw.ndjson?.error?.status).toBe(0)
    expect(raw.ndjson?.error?.bodyText).toContain('ECONNREFUSED')
    expect(raw.ndjson?.error?.bodyText).not.toContain('SIGNED_A')
    const built = { path: raw.path, params: raw.params, ndjson: raw.ndjson }
    expect(JSON.stringify(built)).not.toContain('SIGNED_A')
  })

  it('refuses a first link that is not an https string, and does not fetch it', async () => {
    const seen = installRouter([
      ...installRoutes,
      envelopeRoute({ download_links: ['http://blob.example/r.ndjson'], report_day: '2026-06-29' }),
    ])
    const nd = (await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })).ndjson!
    expect(nd.linksAvailable).toBe(1)
    expect(nd.linksRead).toBe(0)
    expect(nd.error?.status).toBe(0)
    expect(nd.error?.bodyText).toContain('not an https')
    expect(seen.some((s) => s.url.includes('blob.example'))).toBe(false)
  })

  it('reports an envelope with no links as a clean empty read, not an error', async () => {
    // The report is generated asynchronously, so "not ready yet" is expected.
    // getUserDailyCredits fails the DAY for it (never book a silent zero); the
    // probe has nothing to book and the envelope's own shape is still evidence.
    installRouter([...installRoutes, envelopeRoute({ report_day: '2026-06-29' })])
    const nd = (await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })).ndjson!
    expect(nd.linksAvailable).toBe(0)
    expect(nd.linksRead).toBe(0)
    expect(nd.records).toEqual([])
    expect(nd.error).toBeNull()
  })

  it('returns the provider error for a failed envelope with the installation token scrubbed', async () => {
    installRouter([
      ...installRoutes,
      {
        match: `/enterprises/${ENT}/copilot/metrics/reports/users-1-day`,
        res: () => textRes(403, `{"message":"Resource not accessible by integration","token":"${INSTALL_TOKEN}"}`),
      },
    ])
    const raw = await client().rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })
    expect(raw.envelope.ok).toBe(false)
    if (raw.envelope.ok) return
    expect(raw.envelope.status).toBe(403)
    expect(raw.envelope.bodyText).toContain('Resource not accessible by integration')
    expect(raw.envelope.bodyText).not.toContain(INSTALL_TOKEN)
    // No envelope means no link to follow — the second step never ran.
    expect(raw.ndjson).toBeNull()
  })

  it('is App-mode only, like every other method that mints an installation token', async () => {
    const pat = GithubCopilotClient.withPat(ENT, 'ghp_not_an_app_key')
    await expect(pat.rawUserDailyCreditsPage('2026-06-29', { lineLimit: 3 })).rejects.toMatchObject({
      statusCode: 500,
    })
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

describe('rawAiCreditUsagePage (diagnostics) refuses an App-mode client', () => {
  /*
   * This method returns a RAW provider error body and promises the credential has
   * been scrubbed out of it. An App-mode client holds no PAT, so there would be
   * nothing to scrub and the promise would be vacuous. The wire-shape probe
   * already declines to call it in App mode — but that is a property of one
   * caller, and the requirement belongs to the method. Asserted here so the
   * unreachability is enforced rather than assumed.
   */
  it('throws a 500 instead of issuing a call with no credential to scrub', async () => {
    const appClient = GithubCopilotClient.withApp(ENT, new GithubAppAuth(APP_ID, base64Pem))
    mockFetch.mockClear()
    await expect(
      appClient.rawAiCreditUsagePage('octocat', { year: 2026, month: 7, day: 30 }),
    ).rejects.toMatchObject({ statusCode: 500 })
    // It refused BEFORE reaching the network, not after.
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('a PAT-mode client is unaffected', async () => {
    const patClient = GithubCopilotClient.withPat(ENT, 'ghp_classic_pat_1234567890')
    // readRawPage reads the body as TEXT before any schema touches it.
    mockFetch.mockImplementation(async () => textRes(200, JSON.stringify({ usageItems: [] })))
    const out = await patClient.rawAiCreditUsagePage('octocat', { year: 2026, month: 7, day: 30 })
    expect(out.page.ok).toBe(true)
  })
})

describe('withPat rejects a base64-encoded PEM (S9: never mint Authorization: Bearer <key>)', () => {
  it('throws when the supplied value round-trips through the App-key parser (base64 decodes AND parses as a private key)', () => {
    expect(() => GithubCopilotClient.withPat(ENT, base64Pem)).toThrow(/base64-encoded PEM/)
  })

  it('never includes the rejected value in the thrown message', () => {
    let thrown: unknown
    try {
      GithubCopilotClient.withPat(ENT, base64Pem)
    } catch (e) {
      thrown = e
    }
    expect(String(thrown)).not.toContain(base64Pem)
    expect(String(thrown)).not.toContain(privateKey)
  })

  it('a real PAT (not PEM-shaped) constructs normally', () => {
    expect(() => GithubCopilotClient.withPat(ENT, 'ghp_classic_pat_1234567890')).not.toThrow()
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

/*
 * UF-19: the per-org seat pull's diagnostics. `listOrgCopilotSeats()` returns a plain
 * array, so "the App is not installed on this org" (roster UNKNOWN) and "this org holds
 * no seats" (roster KNOWN, empty) are the same `[]` — and the Copilot flat-seat writer
 * DELETEs stale showback rows based on that roster. These pin that the two states are
 * distinguishable, and that a capped pull says so.
 */
describe('listOrgCopilotSeatsWithDiagnostics (App mode — installed + pagination diagnostics)', () => {
  it('App-only: rejects a PAT-mode client, exactly like the array surface', async () => {
    const patClient = GithubCopilotClient.withPat(ENT, 'ghp_classic_pat')
    await expect(patClient.listOrgCopilotSeatsWithDiagnostics(ORG)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('installed org with seats → installed:true, shortPageBreak:true, pagesCapped:false', async () => {
    installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      { match: `/orgs/${ORG}/copilot/billing/seats`, res: () => jsonRes(200, { seats: [{ assignee: { login: 'octocat' } }] }) },
    ])
    expect(await client().listOrgCopilotSeatsWithDiagnostics(ORG)).toEqual({
      seats: [{ login: 'octocat', org: ORG }],
      installed: true,
      pagesCapped: false,
      shortPageBreak: true,
      // A complete one-seat roster: short page, but no evidence of truncation.
      rosterIncomplete: false,
    })
  })

  it('DISTINGUISHES a not-installed org (installed:false) from an installed org with zero seats (installed:true)', async () => {
    installRouter([{ match: `/orgs/${ORG}/installation`, res: () => jsonRes(404, {}) }])
    const notInstalled = await client().listOrgCopilotSeatsWithDiagnostics(ORG)
    expect(notInstalled).toEqual({ seats: [], rosterIncomplete: false,
      installed: false, pagesCapped: false, shortPageBreak: false })

    installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      { match: `/orgs/${ORG}/copilot/billing/seats`, res: () => jsonRes(200, { seats: [] }) },
    ])
    const emptyButKnown = await client().listOrgCopilotSeatsWithDiagnostics(ORG)
    expect(emptyButKnown).toEqual({ seats: [], rosterIncomplete: false,
      installed: true, pagesCapped: false, shortPageBreak: true })

    // The array surface collapses both to the same value — which is exactly why the
    // diagnostics surface exists and why the prune must not read the array form.
    expect(notInstalled.seats).toEqual(emptyButKnown.seats)
  })

  it('hits the 100-page hard cap when every page is full (pagesCapped:true, never an unbounded loop)', async () => {
    let seatPages = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/installation')) return jsonRes(200, { id: 88, suspended_at: null })
      if (url.includes('/access_tokens')) return jsonRes(201, { token: INSTALL_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() })
      seatPages += 1
      // Every page full ⇒ pagination never sees a natural end signal.
      return jsonRes(200, { seats: Array.from({ length: 100 }, (_, i) => ({ assignee: { login: `u-${seatPages}-${i}` } })) })
    })
    const out = await client().listOrgCopilotSeatsWithDiagnostics(ORG)
    expect(out.seats).toHaveLength(10_000)
    expect(out.pagesCapped).toBe(true)
    expect(out.shortPageBreak).toBe(false)
    expect(seatPages).toBe(100)
  })

  it('fails loud (502) on a non-OK seats response — never a silent empty-with-installed:true', async () => {
    installRouter([
      { match: `/orgs/${ORG}/installation`, res: () => jsonRes(200, { id: 88, suspended_at: null }) },
      tokenRoute,
      { match: `/orgs/${ORG}/copilot/billing/seats`, res: () => jsonRes(403, {}) },
    ])
    await expect(client().listOrgCopilotSeatsWithDiagnostics(ORG)).rejects.toMatchObject({ statusCode: 502 })
  })
})

describe('listInstallableOrganizations (Workstream D — bounded census pagination)', () => {
  it('App-only: rejects a PAT-mode client', async () => {
    const patClient = GithubCopilotClient.withPat(ENT, 'ghp_classic_pat')
    await expect(patClient.listInstallableOrganizations()).rejects.toMatchObject({ statusCode: 500 })
  })

  it('resolves the ENTERPRISE install, paginates, returns organizations + shortPageBreak on a short final page', async () => {
    const seen = installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 5, suspended_at: null }) },
      tokenRoute,
      {
        match: '/apps/installable_organizations',
        res: () =>
          jsonRes(200, [
            { id: 1, login: 'acme-eng' },
            { id: 2, login: 'acme-design' },
          ]),
      },
    ])
    const result = await client().listInstallableOrganizations()
    expect(result).toEqual({
      organizations: [
        { id: 1, login: 'acme-eng' },
        { id: 2, login: 'acme-design' },
      ],
      pagesCapped: false,
      shortPageBreak: true,
    })
    const censusCall = seen.find((s) => s.url.includes('/apps/installable_organizations'))!
    expect(censusCall.url).toContain(`/enterprises/${ENT}/apps/installable_organizations`)
    expect(censusCall.url).toContain('per_page=100')
    expect(censusCall.headers.Authorization).toBe(['Bearer', INSTALL_TOKEN].join(' '))
  })

  it('follows multiple full pages before a short final page (normal multi-page pull)', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 5, suspended_at: null }) },
      tokenRoute,
    ])
    let call = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/enterprises') && url.endsWith('/installation')) return jsonRes(200, { id: 5, suspended_at: null })
      if (url.includes('/access_tokens')) return jsonRes(201, { token: INSTALL_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() })
      call += 1
      // `[?&]page=` (not a bare /page=/) — `per_page=100` would otherwise match the
      // unanchored pattern FIRST (capturing "100" from "per_page=100"), never reaching
      // the real `&page=N` parameter at all.
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1')
      if (page < 3) {
        // Full 100-org pages.
        return jsonRes(200, Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i, login: `org-${page}-${i}` })))
      }
      // Short final page (page 3): ends pagination naturally.
      return jsonRes(200, [{ id: 9999, login: 'org-last' }])
    })
    const result = await client().listInstallableOrganizations()
    expect(result.organizations).toHaveLength(201) // 100 + 100 + 1
    expect(result.pagesCapped).toBe(false)
    expect(result.shortPageBreak).toBe(true)
    expect(call).toBe(3) // exactly 3 pages fetched, not more
  })

  it('hits the 100-page hard cap when every page is full (pagesCapped: true, never an unbounded loop)', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 5, suspended_at: null }) },
      tokenRoute,
    ])
    let calls = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/enterprises') && url.endsWith('/installation')) return jsonRes(200, { id: 5, suspended_at: null })
      if (url.includes('/access_tokens')) return jsonRes(201, { token: INSTALL_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() })
      calls += 1
      // EVERY page returns a full 100 — pagination never sees a natural end signal.
      return jsonRes(200, Array.from({ length: 100 }, (_, i) => ({ id: i, login: `org-${calls}-${i}` })))
    })
    const result = await client().listInstallableOrganizations()
    expect(result.organizations).toHaveLength(10_000) // 100 pages × 100 orgs — the hard cap, not more
    expect(result.pagesCapped).toBe(true)
    expect(result.shortPageBreak).toBe(false)
    // Exactly 100 census pages fetched (+ the install lookup + token mint) — bounded,
    // never an unbounded loop even though the server never signalled "end of list".
    expect(calls).toBe(100)
  })

  it('skips cleanly with a 404 fail — App not installed on the enterprise (no install, no census call)', async () => {
    const seen = installRouter([{ match: `/enterprises/${ENT}/installation`, res: () => jsonRes(404, {}) }])
    await expect(client().listInstallableOrganizations()).rejects.toMatchObject({ statusCode: 502 })
    expect(seen.some((s) => s.url.includes('/apps/installable_organizations'))).toBe(false)
  })

  it('fails loud (502) on a non-OK census response (e.g. 403 — the capability-denial shape callers classify)', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 5, suspended_at: null }) },
      tokenRoute,
      { match: '/apps/installable_organizations', res: () => jsonRes(403, {}) },
    ])
    await expect(client().listInstallableOrganizations()).rejects.toMatchObject({ statusCode: 502 })
  })

  it('never leaks the installation token in the thrown error', async () => {
    installRouter([
      { match: `/enterprises/${ENT}/installation`, res: () => jsonRes(200, { id: 5, suspended_at: null }) },
      tokenRoute,
      { match: '/apps/installable_organizations', res: () => jsonRes(500, {}) },
    ])
    let thrown: unknown
    try {
      await client().listInstallableOrganizations()
    } catch (e) {
      thrown = e
    }
    expect(JSON.stringify(thrown)).not.toContain(INSTALL_TOKEN)
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

/*
 * Roster-integrity detection (external review, sprint 3). The seat-convergence prune
 * is a DELETE on a money table gated on the roster being trustworthy. Two payload
 * shapes prove it is NOT, and both used to be invisible: a 200 whose `seats` key is
 * absent (which `z.array().default([])` flattened into a clean empty page), and a
 * `total_seats` larger than what we actually collected.
 *
 * shortPageBreak deliberately does NOT imply rosterIncomplete — it is true for every
 * roster under 100 seats, so treating it as evidence would block convergence forever.
 */
describe('pullSeats roster-integrity diagnostics', () => {
  const PAT = 'ghp-test'
  const seatsOf = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ assignee: { login: `u${from + i}` }, organization: { login: 'acme' } }))

  it('a 200 page with NO `seats` key sets rosterIncomplete', async () => {
    mockFetch.mockResolvedValue(jsonRes(200, { total_seats: 5 }))
    const diag = await GithubCopilotClient.withPat('ent', PAT).listSeatsWithDiagnostics()
    expect(diag.rosterIncomplete).toBe(true)
    expect(diag.seats).toHaveLength(0)
  })

  it('a full page followed by a keyless page sets rosterIncomplete and keeps what it read', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes(200, { seats: seatsOf(100) }))
      .mockResolvedValueOnce(jsonRes(200, {}))
    const diag = await GithubCopilotClient.withPat('ent', PAT).listSeatsWithDiagnostics()
    expect(diag.rosterIncomplete).toBe(true)
    expect(diag.seats).toHaveLength(100)
  })

  it('total_seats greater than the seats collected sets rosterIncomplete', async () => {
    mockFetch.mockResolvedValue(jsonRes(200, { total_seats: 50, seats: seatsOf(3) }))
    const diag = await GithubCopilotClient.withPat('ent', PAT).listSeatsWithDiagnostics()
    expect(diag.rosterIncomplete).toBe(true)
  })

  it('a COMPLETE small roster is not flagged — shortPageBreak alone is not evidence', async () => {
    mockFetch.mockResolvedValue(jsonRes(200, { total_seats: 3, seats: seatsOf(3) }))
    const diag = await GithubCopilotClient.withPat('ent', PAT).listSeatsWithDiagnostics()
    expect(diag).toMatchObject({ rosterIncomplete: false, shortPageBreak: true })
    expect(diag.seats).toHaveLength(3)
  })

  it('a roster with no total_seats reported and a normal short page is not flagged', async () => {
    mockFetch.mockResolvedValue(jsonRes(200, { seats: seatsOf(7) }))
    const diag = await GithubCopilotClient.withPat('ent', PAT).listSeatsWithDiagnostics()
    expect(diag.rosterIncomplete).toBe(false)
  })
})
