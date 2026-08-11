// @vitest-environment node
/*
 * Intent: ADR-0010 D1 + reporting-consolidation Wave 0 — the Copilot flat-seat writer.
 *
 * The writer now emits ONLY the whole-month flat per-seat SHOWBACK rows (display-only). The
 * per-user OVERAGE charge (WRONG model #1) was REMOVED — the pooled overage authority is
 * copilot_pool_bill.overage_net_usd (read from the bill by the copilot-pool-bill worker).
 *
 * Executable statement:
 *   - flat seat is WHOLE-MONTH (D1): a seat active any day owes the full month, ONE row
 *     dated the 1st (onboarded the 29th → still the full month).
 *   - NO overage row is EVER written (source='copilot-overage' is gone).
 *   - chargeback_exempt is set from the license-org (NFR/demo → true) for the SHOWBACK lane.
 *   - NULL flat price disables the flat row; an unmapped seat is counted, not dropped.
 *
 * S9 additions: the seat-convergence prune (rebind / seat removal / org move converge to ONE
 * row), the three-precondition guard that stops the prune firing on an unreliable empty/short
 * roster, the DB-clock runStarted read, and the credential-kind branch (never withPat(App key)).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runCopilotBillWriter } from '../../../server/workers/copilot-bill'
import { GithubCopilotClient, type GithubSeat, type SeatsPullDiagnostics } from '../../../server/reconciliation/adapters/github-client'
import { GithubAppAuth } from '../../../server/reconciliation/adapters/github-app-auth'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'

// Mock the shared outbound chokepoint — needed ONLY by the tests that exercise a REAL
// GithubCopilotClient (the N=0 shape-change case and the App-mode construction proof).
// Every other test here uses clientOverride and never reaches resilientFetch, so mocking
// it module-wide doesn't affect them.
vi.mock('../../../server/utils/resilient-fetch', () => ({ resilientFetch: vi.fn() }))
/* eslint-disable import/first */
import { resilientFetch } from '../../../server/utils/resilient-fetch'
/* eslint-enable import/first */
const mockFetch = resilientFetch as unknown as ReturnType<typeof vi.fn>

let t: TestDb
let regionId = ''
let orgUnitId = ''
const ENT = 'test-ent'
const NOW = new Date('2026-06-29T09:00:00.000Z') // day 29 — flat must still be the full month
const MONTH_START = '2026-06-01'

const PAT_CRED: ResolvedCredential = { secretName: 'test-secret', value: 'unused-pat', level: 'enterprise', kind: 'github-pat' }

function seat(login: string, org: string): GithubSeat {
  return { assignee: { login }, organization: { login: org } } as GithubSeat
}
/** A seat-list stub (no live GitHub call). */
function stubClient(seats: GithubSeat[], diag?: Partial<Pick<SeatsPullDiagnostics, 'pagesCapped' | 'shortPageBreak'>>) {
  return {
    listSeatsWithDiagnostics: async () => ({
      seats,
      pagesCapped: diag?.pagesCapped ?? false,
      shortPageBreak: diag?.shortPageBreak ?? true,
    }),
  }
}

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

async function mkTeammate(): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-cb-${randomUUID().slice(0, 8)}`,
      email: `cb.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function mapLogin(login: string, teammateId: string): Promise<void> {
  await t.client`
    INSERT INTO teammate_identity_map (teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug, source)
    VALUES (${teammateId}::uuid, 'github', ${login}, 'username', ${login}, ${ENT}, 'directory-sync')`
}

/* Registers a github license-org under the ENT enterprise's provider_org set, so the
 * seat-convergence prune (scoped to provider_org, not just the orgs seen this tick) knows
 * this org belongs to this enterprise. Idempotent — safe to call repeatedly across tests. */
async function mkProviderOrg(org: string): Promise<void> {
  // provider_org_unique is an EXPRESSION index (provider, lower(external_org_id)) as
  // of mig 0064 — the ON CONFLICT target must match it exactly, not the plain columns.
  await t.client`
    INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, provider_enterprise_id)
    SELECT 'github', ${org}, ${org}, 'reconciled', 'tracked', pe.id
    FROM provider_enterprise pe WHERE pe.provider = 'github' AND pe.external_id = ${ENT}
    ON CONFLICT (provider, (lower(external_org_id))) DO UPDATE SET provider_enterprise_id = EXCLUDED.provider_enterprise_id`
}

interface Row {
  date: string
  source: string
  category: string | null
  cost_usd: string
  chargeback_exempt: boolean
  input_tokens: string
}
async function copilotRows(teammateId: string): Promise<Row[]> {
  return t.client<Row[]>`
    SELECT date::text AS date, source, category, cost_usd::text AS cost_usd, chargeback_exempt, input_tokens::text AS input_tokens
    FROM actual_spend WHERE teammate_id = ${teammateId}::uuid AND tool = 'copilot-cli' ORDER BY source`
}

/* Seed a pre-existing copilot-seat row with pulled_at safely BEFORE any run's runStarted
 * marker (mirrors seedSpend in poller-surface-split.test.ts, the Claude-lane's own prune
 * test convention) — deterministic staleness, not "run the writer twice and hope enough
 * wall-clock time passed between the two runStarted reads". */
async function seedStaleCopilotRow(teammateId: string, source: string, costUsd: number, date = MONTH_START): Promise<void> {
  await t.client`
    INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, category, chargeback_exempt, pulled_at)
    VALUES (${teammateId}::uuid, ${date}::date, 'copilot-cli', 0, 0, ${costUsd}, ${source}, 'seat-license', false, now() - interval '1 hour')`
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'cb', displayName: 'CB' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cb', code: 'cb-co', displayName: 'CoU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  // provider_enterprise_unique is an EXPRESSION index (provider, lower(external_id)) as
  // of mig 0062 — the ON CONFLICT target must match it exactly, not the plain columns.
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name)
    VALUES ('github', ${ENT}, 'Test Ent', 'reconciled', 'test-ent-secret')
    ON CONFLICT (provider, (lower(external_id))) DO NOTHING`
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM actual_spend WHERE tool = 'copilot-cli'`
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
  mockFetch.mockReset()
})

describe('runCopilotBillWriter (flat-seat showback; overage removed)', () => {
  it('writes a whole-month flat seat (day-29 run → dated the 1st, full price) and NO overage row', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme')]),
    })
    expect(res).toMatchObject({ seatsResolved: 1, flatRowsWritten: 1, overageRowsWritten: 0, seatsCarriedUnmapped: 0, prunedRows: 0 })

    const rows = await copilotRows(tm)
    expect(rows).toHaveLength(1) // ONLY the flat seat — no overage row
    const seatRow = rows[0]!
    expect(seatRow.source).toBe('copilot-seat:acme')
    expect(seatRow.date).toBe(MONTH_START) // D1: whole-month, dated the 1st
    expect(Number(seatRow.cost_usd)).toBe(39) // full flat price despite a day-29 run
    expect(seatRow.category).toBe('seat-license')
  })

  it('never writes a source=copilot-overage row (WRONG model #1 removed)', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme')]),
    })
    const rows = await copilotRows(tm)
    expect(rows.map((r) => r.source)).not.toContain('copilot-overage')
  })

  it('sets chargeback_exempt from the license-org (NFR/demo heuristic) for showback', async () => {
    await mkProviderOrg('partner-demo')
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'partner-demo')]), // 'demo' → exempt
    })
    expect(res.flatRowsWritten).toBe(1)
    const [row] = await copilotRows(tm)
    expect(row!.chargeback_exempt).toBe(true)
    expect(row!.source).toBe('copilot-seat:partner-demo')
  })

  it('NULL flat price → no flat row', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: null,
      clientOverride: stubClient([seat('dev', 'acme')]),
    })
    expect(res).toMatchObject({ flatRowsWritten: 0, overageRowsWritten: 0 })
    expect(await copilotRows(tm)).toHaveLength(0)
  })

  it('multi-org user: one flat row PER SEAT (D1)', async () => {
    await mkProviderOrg('acme')
    await mkProviderOrg('partner-demo')
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme'), seat('dev', 'partner-demo')]),
    })
    expect(res).toMatchObject({ seatsResolved: 2, flatRowsWritten: 2, overageRowsWritten: 0 })

    const rows = await copilotRows(tm)
    expect(rows.map((r) => r.source).sort()).toEqual(['copilot-seat:acme', 'copilot-seat:partner-demo'])
    expect(rows.find((r) => r.source === 'copilot-seat:partner-demo')!.chargeback_exempt).toBe(true)
    expect(rows.find((r) => r.source === 'copilot-seat:acme')!.chargeback_exempt).toBe(false)
  })

  it('counts an unmapped seat as carried (not dropped, not written)', async () => {
    await mkProviderOrg('acme')
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('nobody', 'acme')]), // no identity map row
    })
    expect(res).toMatchObject({ seatsTotal: 1, seatsResolved: 0, seatsCarriedUnmapped: 1, flatRowsWritten: 0 })
  })

  it('is idempotent: a second run UPSERTS the same row (no duplicate)', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const cfg = {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme')]),
    }
    await runCopilotBillWriter(t.db, cfg)
    const res = await runCopilotBillWriter(t.db, cfg)
    const rows = await copilotRows(tm)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.cost_usd)).toBe(39)
    expect(res.prunedRows).toBe(0) // re-asserted, not stale
  })
})

describe('runCopilotBillWriter — S9 seat convergence (rebind / removal / org-move converge to ONE row)', () => {
  // Every case here SEEDS the "old" row directly with pulled_at = now() - 1h (via
  // seedStaleCopilotRow, mirroring the Claude lane's own seedSpend prune-test convention)
  // rather than running the writer twice and relying on enough wall-clock time passing
  // between two runStarted reads — deterministic, not coincidentally-timed.

  it('(a) REBIND: a stale row under the OLD teammate is pruned; the login now resolves to the NEW teammate', async () => {
    await mkProviderOrg('acme')
    const tmA = await mkTeammate()
    const tmB = await mkTeammate()
    await seedStaleCopilotRow(tmA, 'copilot-seat:acme', 39) // A used to hold this seat
    await mapLogin('shared-login-a', tmB) // the login is NOW bound to B

    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('shared-login-a', 'acme')]),
    })

    expect(await copilotRows(tmA)).toHaveLength(0) // A's stale row pruned
    const bRows = await copilotRows(tmB)
    expect(bRows).toHaveLength(1)
    expect(bRows[0]!.source).toBe('copilot-seat:acme')
    expect(res.prunedRows).toBe(1)
  })

  it('(b) SEAT REMOVAL: one seat gone while another remains — only the removed seat\'s row is deleted', async () => {
    await mkProviderOrg('acme')
    const tmKeep = await mkTeammate()
    const tmGone = await mkTeammate()
    await mapLogin('keeper', tmKeep)
    await seedStaleCopilotRow(tmGone, 'copilot-seat:acme', 39) // leaver's seat is no longer on the roster

    // keeper's seat is still on the roster (seatsTotal stays > 0) — this is the guard
    // this test exercises: NOT the N=0 case.
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('keeper', 'acme')]),
    })
    expect(await copilotRows(tmKeep)).toHaveLength(1) // newly written, re-asserted
    expect(await copilotRows(tmGone)).toHaveLength(0) // pruned
    expect(res.prunedRows).toBe(1)
  })

  it('(c) ORG MOVE: a seat moving org A → org B leaves one row (B), not two', async () => {
    await mkProviderOrg('org-a')
    await mkProviderOrg('org-b')
    const tm = await mkTeammate()
    await mapLogin('mover', tm)
    await seedStaleCopilotRow(tm, 'copilot-seat:org-a', 39) // stale — used to be org-a

    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('mover', 'org-b')]), // now on org-b
    })
    const rows = await copilotRows(tm)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe('copilot-seat:org-b')
    expect(res.prunedRows).toBe(1)
  })

  it('(d) PRUNE GUARD: roster resolves 0 of N (N > 0) seats — nothing deleted (the ratio guard, not the N=0 guard)', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    // A pre-existing row that WOULD be pruned if the ratio guard did not hold.
    await seedStaleCopilotRow(tm, 'copilot-seat:acme', 39)

    // A roster with THREE seats, but NONE resolve — looks like broken identity
    // resolution, not "the seats are gone".
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('nobody1', 'acme'), seat('nobody2', 'acme'), seat('nobody3', 'acme')]),
    })
    expect(res).toMatchObject({ seatsTotal: 3, seatsResolved: 0, seatsCarriedUnmapped: 3, prunedRows: 0 })
    expect(await copilotRows(tm)).toHaveLength(1) // untouched — the ratio guard skipped the prune
  })

  it('(d2) PRUNE GUARD: a page-CAPPED pull deletes nothing, even though the other three preconditions hold', async () => {
    await mkProviderOrg('acme')
    const tmKeep = await mkTeammate()
    const tmBeyondCap = await mkTeammate()
    await mapLogin('keeper-d2', tmKeep)
    // tmBeyondCap's seat is real and still held, but sits past the pagination cap, so
    // it is absent from THIS pull's roster. Identity resolution is perfectly healthy
    // (1 of 1 roster seats resolves, ratio 0), seatsTotal > 0, and nothing threw — so
    // preconditions 1-3 all hold and only the truncation signal stands between this
    // row and deletion.
    await seedStaleCopilotRow(tmBeyondCap, 'copilot-seat:acme', 39)

    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('keeper-d2', 'acme')], { pagesCapped: true }),
    })

    expect(res).toMatchObject({ seatsTotal: 1, seatsCarriedUnmapped: 0, seatPagesCapped: true, prunedRows: 0 })
    // The beyond-cap teammate's real showback row survives. Without the seatPagesCapped
    // precondition this row is deleted as "stale" and the money is silently gone.
    expect(await copilotRows(tmBeyondCap)).toHaveLength(1)
  })

  it('(e) EMPTY ROSTER, N=0: listSeats() parses to [] via the schema default (a shape change, not a hand-made empty array) — prior + this month rows all survive', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    // A this-month row AND a prior-month row, both pre-existing (as if written by
    // healthy earlier runs).
    await seedStaleCopilotRow(tm, 'copilot-seat:acme', 39, MONTH_START)
    await seedStaleCopilotRow(tm, 'copilot-seat:acme', 39, '2026-05-01')
    expect(await copilotRows(tm)).toHaveLength(2)

    // The REAL client this time (no clientOverride): a 200 response body with NO `seats`
    // key at all — SeatsPageSchema's `seats: z.array(SeatSchema).default([])` parses this
    // to an empty array, NOT a thrown error. This is the shape-change / partial-outage
    // case the guard exists for — indistinguishable, at the roster layer, from a
    // genuinely seatless enterprise.
    mockFetch.mockResolvedValue(jsonRes(200, { total_seats: 0 }))

    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: PAT_CRED, // real PAT-mode client — no clientOverride
      now: NOW,
      flatSeatPriceUsd: 39,
    })

    expect(res).toMatchObject({ seatsTotal: 0, prunedRows: 0 })
    expect(await copilotRows(tm)).toHaveLength(2) // BOTH months' rows still present — nothing pruned
  })

  it('(f) a run whose runStarted DB-clock read fails throws and deletes nothing, even when the prune would otherwise fire', async () => {
    await mkProviderOrg('acme')
    const tmKeep = await mkTeammate()
    const tmGone = await mkTeammate()
    await mapLogin('keeper-f', tmKeep)
    // leaver's stale row: NOT re-asserted by the roster below, and the ratio guard
    // passes (1 resolved / 1 total) — a legitimate prune candidate.
    await seedStaleCopilotRow(tmGone, 'copilot-seat:acme', 39)

    // A db whose FIRST execute() call (the clock read, which runCopilotBillWriter issues
    // before anything else) returns an empty result set — reproduces `!clock` without
    // touching a live connection. Every subsequent call passes through to the real db.
    let calls = 0
    const brokenClockDb = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return (...args: unknown[]) => {
            calls += 1
            if (calls === 1) return Promise.resolve([])
            return (target.execute as (...a: unknown[]) => unknown)(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    await expect(
      runCopilotBillWriter(brokenClockDb as typeof t.db, {
        enterpriseSlug: ENT,
        credential: PAT_CRED,
        now: NOW,
        flatSeatPriceUsd: 39,
        clientOverride: stubClient([seat('keeper-f', 'acme')]),
      }),
    ).rejects.toThrow(/DB clock/)

    expect(await copilotRows(tmGone)).toHaveLength(1) // untouched — thrown before the prune
    expect(await copilotRows(tmKeep)).toHaveLength(0) // the seat loop never ran either — no upsert happened
  })
})

/*
 * KNOWN GAP (discovered while building this coverage, NOT fixed here — out of S9's
 * scope, which is the credential-CONSTRUCTION branch, not the seat-DATA-PATH): the
 * enterprise seats endpoint this writer pulls from (GithubCopilotClient.listSeats /
 * listSeatsWithDiagnostics) sends `this.headers()` — a Bearer PAT header — REGARDLESS
 * of App vs PAT mode. github-client.ts's own class docstring calls listSeats() a
 * "legacy PAT method" that "the adapter branches at the seam by credential.kind" to
 * AVOID calling in App mode (github.ts and github-identity.ts both do this; App mode
 * uses listOrgCopilotSeats(org) per onboarded org instead). copilot-bill.ts does not
 * do that branching — it always calls listSeatsWithDiagnostics(). Against a REAL
 * App-mode enterprise this sends an EMPTY bearer (`this.pat === ''` for a withApp()
 * client) to an endpoint that (per the module's own verification notes) needs the
 * manage_billing PAT scope, which would 401 — isolated by reconciliation-sync's
 * inner try/catch, so it fails safely, but Copilot flat-seat SHOWBACK will not
 * actually populate for an App-mode enterprise. This test mocks resilientFetch to
 * return 200s regardless of the auth header, so it proves ONLY what S9 asks: the
 * client is constructed via withApp (not withPat) and no request carries the raw key.
 * It does NOT prove the seats pull itself is App-mode-correct end to end.
 */
describe('runCopilotBillWriter — App mode (S9: no App-mode coverage existed before this fix)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const APP_KEY_B64 = Buffer.from(privateKey).toString('base64')
  const APP_CRED: ResolvedCredential = { secretName: 'app-secret', value: APP_KEY_B64, level: 'enterprise', kind: 'github-app', appId: '424242' }
  const INSTALL_TOKEN = 'ghs_INSTALLATION_TOKEN_DO_NOT_LEAK'

  it('constructs the client via withApp (never withPat) and no outbound request carries the App key', async () => {
    await mkProviderOrg('acme')
    const tm = await mkTeammate()
    await mapLogin('appdev', tm)

    const withAppSpy = vi.spyOn(GithubCopilotClient, 'withApp')
    const withPatSpy = vi.spyOn(GithubCopilotClient, 'withPat')

    const seen: { url: string; headers: Record<string, string> }[] = []
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers as Record<string, string>) ?? {}
      seen.push({ url, headers })
      if (url.includes(`/enterprises/${ENT}/installation`)) return jsonRes(200, { id: 77, suspended_at: null })
      if (url.includes('/access_tokens')) {
        return jsonRes(201, { token: INSTALL_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() })
      }
      if (url.includes(`/enterprises/${ENT}/copilot/billing/seats`)) {
        return jsonRes(200, { seats: [{ assignee: { login: 'appdev' }, organization: { login: 'acme' } }] })
      }
      throw new Error(`no canned route for ${url}`)
    })

    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: APP_CRED,
      now: NOW,
      flatSeatPriceUsd: 39,
    })

    expect(res).toMatchObject({ seatsResolved: 1, flatRowsWritten: 1 })

    // Asserted on the CONSTRUCTED client kind, not merely a successful run (Must-not-break).
    expect(withAppSpy).toHaveBeenCalledTimes(1)
    expect(withAppSpy.mock.calls[0]?.[0]).toBe(ENT)
    expect(withAppSpy.mock.calls[0]?.[1]).toBeInstanceOf(GithubAppAuth)
    expect(withPatSpy).not.toHaveBeenCalled()

    // No outbound request — not even the seats call's Authorization header — carries the
    // raw base64 App key or the decoded PEM text.
    for (const s of seen) {
      const headerBlob = JSON.stringify(s.headers)
      expect(headerBlob).not.toContain(APP_KEY_B64)
      expect(headerBlob).not.toContain(privateKey)
    }

    withAppSpy.mockRestore()
    withPatSpy.mockRestore()
  })
})
