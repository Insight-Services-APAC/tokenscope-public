// @vitest-environment node
/*
 * The GitHub App surface's TWO-STEP assembly (liveFromTwoStep in
 * server/diagnostics/provider-wire-probe.ts): one users-1-day report envelope plus
 * ONE of the signed NDJSON files it links to, turned into a single surface report.
 *
 * WHY IT IS TESTED HERE AND NOT THROUGH THE ROUTE. The App path mints an
 * installation token against a hardcoded api.github.com, so no local stub can
 * reach it end to end. This function is where the two stages meet and is the only
 * place a live `download_links` value can reach a report, so the assertion that it
 * does NOT has to drive it directly.
 *
 * WHAT MUST NOT REGRESS:
 *   1. A signed link never reaches the report. The client hands the envelope over
 *      VERBATIM by design; the summariser's key denylist is what withholds the
 *      values, and this is the test that the combination actually holds.
 *   2. Both stages are described on one surface — envelope keys AND record keys —
 *      because "does a Copilot per-user record carry a model dimension" is
 *      answered by the undeclared list over the records.
 *   3. A step-2 failure is an ERROR, not an `ok` with zero rows. Zero records with
 *      no error reads as "GitHub sent nothing", which is the opposite of the truth.
 *
 * Every test below was verified to FAIL with its fix reverted — see the commit
 * body for the exact mutation applied per test.
 */
import { describe, it, expect } from 'vitest'
import { liveFromTwoStep, PROBE_NDJSON_LINE_LIMIT } from '../../../server/diagnostics/provider-wire-probe'
import type { RawUserDailyCreditsPage } from '../../../server/reconciliation/adapters/github-client'

const SIGNED = 'https://objects.example.net/copilot/users-1-day.ndjson?sig=SIGNATURE_XYZ&exp=1799999999'
const DAY = '2026-07-30'

/** A record shaped like the live one verified on 2026-06-30, plus an undeclared field. */
const record = (login: string, extra: Record<string, unknown> = {}) => ({
  user_login: login,
  user_id: 1,
  day: DAY,
  ai_credits_used: 12.5,
  ...extra,
})

function page(over: Partial<RawUserDailyCreditsPage> = {}): RawUserDailyCreditsPage {
  return {
    path: '/enterprises/ws-ent/copilot/metrics/reports/users-1-day',
    params: [['day', DAY]],
    envelope: { ok: true, status: 200, body: { download_links: [SIGNED], report_day: DAY } },
    ndjson: {
      linksAvailable: 1,
      linksRead: 1,
      lineLimit: PROBE_NDJSON_LINE_LIMIT,
      linesRead: 2,
      linesCapped: false,
      linesUnparseable: 0,
      records: [record('alice', { ai_adoption_phase: 'power' }), record('bob')],
      error: null,
    },
    ...over,
  }
}

const run = (over?: Partial<RawUserDailyCreditsPage>) =>
  liveFromTwoStep('github-user-daily-credits', 'ws-ent', page(over), DAY, 11)

describe('liveFromTwoStep — the signed links never reach the report', () => {
  it('withholds every download_links value while still reporting the path', () => {
    const r = run()
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return

    // The whole report, serialised the way the route returns it.
    const json = JSON.stringify(r)
    expect(json).not.toContain('SIGNATURE_XYZ')
    expect(json).not.toContain(SIGNED)
    expect(json).not.toContain('objects.example.net')

    // The PATH is still reported — the operator has to be able to see that the
    // envelope carries links at all, and how many; only the values are withheld.
    const links = r.summary.paths.find((p) => p.path === 'download_links[]')
    expect(links).toBeDefined()
    expect(links!.present).toBe(1)
    expect(links!.distinctValues).toBeUndefined()
    expect(links!.valuesWithheld).toBe('denylisted-key')
  })

  it('withholds a link that no value-shape rule would catch', () => {
    // The reason the KEY rule carries this rather than the value rule: shorten the
    // link and every value test (URL-shaped, long-and-opaque, email, numeric)
    // passes it straight through.
    const short = 'r/9f2c'
    const r = run({
      envelope: { ok: true, status: 200, body: { download_links: [short], report_day: DAY } },
    })
    expect(JSON.stringify(r)).not.toContain(short)
  })

  it('reports the identity fields on a record as paths only, never as values', () => {
    const r = run()
    if (r.status !== 'ok') return
    const json = JSON.stringify(r)
    expect(json).not.toContain('alice')
    expect(json).not.toContain('bob')
    const login = r.summary.paths.find((p) => p.path === 'ndjson_records[].user_login')!
    expect(login.present).toBe(2)
    expect(login.valuesWithheld).toBe('denylisted-key')
  })
})

describe('liveFromTwoStep — both stages on one surface', () => {
  it('describes the envelope AND the records, and counts records as the items', () => {
    const r = run()
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const paths = r.summary.paths.map((p) => p.path)
    expect(paths).toContain('download_links')
    expect(paths).toContain('report_day')
    expect(paths).toContain('ndjson_records[].ai_credits_used')
    // The RECORDS are the item collection, not the envelope's links.
    expect(r.summary.itemsPath).toBe('ndjson_records[]')
    expect(r.summary.itemCount).toBe(2)
  })

  it('reports a record field our schema never declared as UNDECLARED', () => {
    // This is the question the surface exists to answer, exercised with a field
    // the client's own comment says rides along on the live record. The same
    // machinery reports a `model` field if one ever arrives — the probe collects
    // the evidence and does not presume the answer.
    const r = run()
    if (r.status !== 'ok') return
    expect(r.undeclared.kind).toBe('undeclared-by-schema')
    expect(r.undeclared.paths).toContain('ndjson_records[].ai_adoption_phase')
    expect(r.undeclared.paths).not.toContain('ndjson_records[].user_login')
  })

  it('states the bound it applied instead of letting a sample read as a census', () => {
    const r = run({
      ndjson: { ...page().ndjson!, linksAvailable: 4, linksRead: 1, linesRead: 300, linesCapped: true, linesUnparseable: 2 },
    })
    if (r.status !== 'ok') return
    expect(r.fetchBound).toMatchObject({
      linksAvailable: 4,
      linksRead: 1,
      linesRead: 300,
      linesCapped: true,
      linesUnparseable: 2,
    })
  })
})

describe('liveFromTwoStep — a failure at either step is an error, not an empty success', () => {
  it('reports a failed envelope with the provider text and no records', () => {
    const r = run({
      envelope: { ok: false, status: 403, bodyText: 'Resource not accessible by integration', truncated: false },
      ndjson: null,
    })
    expect(r.status).toBe('errored')
    if (r.status !== 'errored') return
    expect(r.error.status).toBe(403)
    expect(r.error.bodyText).toContain('Resource not accessible by integration')
  })

  it('reports a failed NDJSON download as an error, naming which step failed', () => {
    // The mutation this catches: treating a step-2 failure as `ok` with zero
    // records, which renders as "0 rows observed" — indistinguishable from a
    // provider that genuinely returned nothing.
    const r = run({
      ndjson: {
        ...page().ndjson!,
        linksRead: 0,
        records: [],
        error: { ok: false, status: 403, bodyText: 'AuthenticationFailed', truncated: false },
      },
    })
    expect(r.status).toBe('errored')
    if (r.status !== 'errored') return
    expect(r.error.status).toBe(403)
    expect(r.error.bodyText).toContain('AuthenticationFailed')
    // Which of the two calls failed, because they fail for unrelated reasons.
    expect(r.error.bodyText).toContain('envelope read OK')
  })

  it('reports a 200 whose envelope is not a JSON object as an error, not as an empty shape', () => {
    // download_links cannot be read off an array or a string, so calling this
    // "no rows" would hide the loudest contract break the endpoint has.
    const r = run({ envelope: { ok: true, status: 200, body: [] }, ndjson: null })
    expect(r.status).toBe('errored')
    if (r.status !== 'errored') return
    expect(r.error.bodyText).toContain('not a JSON object')
    expect(r.error.bodyText).toContain('array')
  })
})
