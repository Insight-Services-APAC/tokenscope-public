// @vitest-environment node
/*
 * Intent: ADR-0010 D1 + reporting-consolidation Wave 0 — the Copilot flat-seat writer.
 *
 * The writer now emits ONLY the whole-month flat per-seat SHOWBACK rows (display-only). The
 * per-user OVERAGE charge (WRONG model #1) was REMOVED — the pooled overage authority is
 * copilot_pool_bill.overage_net_usd (read from the bill by the copilot-pool-bill worker).
 *
 * Executable statement:
 *   - flat seat is WHOLE-MONTH (D1): a seat active any day owes the full flat price, ONE row
 *     dated the 1st (onboarded the 29th → still the full month).
 *   - NO overage row is EVER written (source='copilot-overage' is gone).
 *   - chargeback_exempt is set from the license-org (NFR/demo → true) for the SHOWBACK lane.
 *   - NULL flat price disables the flat row; an unmapped seat is counted, not dropped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runCopilotBillWriter } from '../../../server/workers/copilot-bill'
import type { GithubSeat } from '../../../server/reconciliation/adapters/github-client'

let t: TestDb
let regionId = ''
let orgUnitId = ''
const ENT = 'test-ent'
const NOW = new Date('2026-06-29T09:00:00.000Z') // day 29 — flat must still be the full month
const MONTH_START = '2026-06-01'

function seat(login: string, org: string): GithubSeat {
  return { assignee: { login }, organization: { login: org } } as GithubSeat
}
/** A seat-list stub (no live GitHub call). */
function stubClient(seats: GithubSeat[]) {
  return { listSeats: async () => seats }
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

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'cb', displayName: 'CB' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cb', code: 'cb-co', displayName: 'CoU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM actual_spend WHERE tool = 'copilot-cli'`
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

describe('runCopilotBillWriter (flat-seat showback; overage removed)', () => {
  it('writes a whole-month flat seat (day-29 run → dated the 1st, full price) and NO overage row', async () => {
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: 'unused',
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme')]),
    })
    expect(res).toMatchObject({ seatsResolved: 1, flatRowsWritten: 1, overageRowsWritten: 0, seatsCarriedUnmapped: 0 })

    const rows = await copilotRows(tm)
    expect(rows).toHaveLength(1) // ONLY the flat seat — no overage row
    const seatRow = rows[0]!
    expect(seatRow.source).toBe('copilot-seat:acme')
    expect(seatRow.date).toBe(MONTH_START) // D1: whole-month, dated the 1st
    expect(Number(seatRow.cost_usd)).toBe(39) // full flat price despite a day-29 run
    expect(seatRow.category).toBe('seat-license')
  })

  it('never writes a source=copilot-overage row (WRONG model #1 removed)', async () => {
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: 'unused',
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme')]),
    })
    const rows = await copilotRows(tm)
    expect(rows.map((r) => r.source)).not.toContain('copilot-overage')
  })

  it('sets chargeback_exempt from the license-org (NFR/demo heuristic) for showback', async () => {
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: 'unused',
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
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: 'unused',
      now: NOW,
      flatSeatPriceUsd: null,
      clientOverride: stubClient([seat('dev', 'acme')]),
    })
    expect(res).toMatchObject({ flatRowsWritten: 0, overageRowsWritten: 0 })
    expect(await copilotRows(tm)).toHaveLength(0)
  })

  it('multi-org user: one flat row PER SEAT (D1)', async () => {
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: 'unused',
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
    const res = await runCopilotBillWriter(t.db, {
      enterpriseSlug: ENT,
      credential: 'unused',
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('nobody', 'acme')]), // no identity map row
    })
    expect(res).toMatchObject({ seatsTotal: 1, seatsResolved: 0, seatsCarriedUnmapped: 1, flatRowsWritten: 0 })
  })

  it('is idempotent: a second run UPSERTS the same row (no duplicate)', async () => {
    const tm = await mkTeammate()
    await mapLogin('dev', tm)
    const cfg = {
      enterpriseSlug: ENT,
      credential: 'unused',
      now: NOW,
      flatSeatPriceUsd: 39,
      clientOverride: stubClient([seat('dev', 'acme')]),
    }
    await runCopilotBillWriter(t.db, cfg)
    await runCopilotBillWriter(t.db, cfg)
    const rows = await copilotRows(tm)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.cost_usd)).toBe(39)
  })
})
