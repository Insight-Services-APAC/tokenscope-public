// @vitest-environment node
/*
 * Rate-card selection: scope-aware + temporal (COST-4/COST-6, mig 0050).
 *
 * Precedence contract (0050_rate_card_scope.sql): (cou match) > (region match)
 * > (global); within each tier only cards whose `effective` range contains the
 * EVENT timestamp and retired_at IS NULL; ties break to the highest version.
 * The pre-0050 bug: selection ignored `effective` entirely (a card whose
 * period had ENDED kept pricing new events if it had the highest version) and
 * had no scope dimension at all.
 *
 * Also pins the regression invariant: with only the seeded global card
 * (mig 0004 — region_id NULL, effective [2026-01-01, 2099-01-01)), costing
 * output is byte-identical to the pre-0050 joiner.
 *
 * SCOPE AFTER docs/design/provider-cost-precedence.md: every record below is
 * DELIBERATELY emitted without a provider cost (no lawCostUsd), so the ladder
 * drops to rung 2 and this file keeps testing exactly what it was written to
 * test — rate-card SELECTION. Selection still matters on rung 1 too, because
 * the selected card is what SLICES the provider's total; the last test pins
 * that the selection ladder is unchanged when a provider cost is present, and
 * that the amount then comes from the provider rather than from the card.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb

const APAC = '11111111-1111-1111-1111-111111111111'
const EMEA = '12121212-1212-1212-1212-121212121212'
const OU_APAC = '22222222-2222-2222-2222-222222222222'
const OU_EMEA = '23232323-2323-2323-2323-232323232323'
const TEAM = '33333333-3333-3333-3333-333333333333'
// One instance per scenario so the per-instance watermark never filters a
// test's events (each instance's events stay ascending across tests).
const INST_REG = '66666666-6666-6666-6666-666666666666' // regression (global card only)
const INST_APAC = '67676767-6767-6767-6767-676767676767' // temporal tests (APAC region cards)
const INST_EMEA = '68686868-6868-6868-6868-686868686868' // scope test (no EMEA card → global)
const INST_SLICE = '69696969-6969-4969-8969-696969696969' // provider-costed slice (APAC current card)

const GLOBAL_CARD = '90000000-0000-4000-8000-000000000001' // mig 0004 seed, v1, input $3/1M, output $15/1M
const APAC_OLD = 'a0000000-0000-4000-8000-000000000001' // APAC, OLD period, version 2 (HIGHER)
const APAC_CUR = 'a0000000-0000-4000-8000-000000000002' // APAC, CURRENT period, version 1
const APAC_COU = 'a0000000-0000-4000-8000-000000000003' // CoU-scoped — tier NOT implemented (TODO), must never be selected

class StubReader {
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

const reader = (sid: string, recs: UsageRecord[]) =>
  new StubReader(new Map([[sid, recs]])) as unknown as TelemetryReader

const cardOf = async (inst: string, tsEvent: string) => {
  const rows = await t.client<
    { cost_usd: string; rate_card_id: string | null; rate_card_version: number | null }[]
  >`
    SELECT cost_usd::text AS cost_usd, rate_card_id::text AS rate_card_id, rate_card_version
    FROM attribution_record
    WHERE instance_id = ${inst}::uuid AND ts_event = ${tsEvent}::timestamptz`
  expect(rows.length).toBe(1)
  return rows[0]!
}

beforeAll(async () => {
  t = await startTestDb()
  // World WITHOUT extra rate cards: only the mig-0004 seeded global card
  // exists when the regression suite below runs. Untagged events are fine —
  // pricing is independent of project resolution (unallocated rows still cost).
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('${APAC}','apac','APAC'),
      ('${EMEA}','emea','EMEA');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type) VALUES
      ('${OU_APAC}','${APAC}','apac.services'::ltree,'apac-svcs','APAC Services','bu'),
      ('${OU_EMEA}','${EMEA}','emea.services'::ltree,'emea-svcs','EMEA Services','bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}','oid','dev@i.com','${APAC}','${OU_APAC}');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id,
       attestation_state)
    VALUES
      ('${INST_REG}','oid','dev@i.com','${TEAM}',NULL,NULL,'claude-code','hReg',
       '2026-05-10T09:00:00Z','2026-05-10T11:00:00Z','${APAC}','${OU_APAC}',NULL,'unassigned'),
      ('${INST_APAC}','oid','dev@i.com','${TEAM}',NULL,NULL,'claude-code','hApac',
       '2026-05-01T09:00:00Z','2026-09-01T11:00:00Z','${APAC}','${OU_APAC}',NULL,'unassigned'),
      ('${INST_EMEA}','oid','dev@i.com','${TEAM}',NULL,NULL,'claude-code','hEmea',
       '2026-05-01T09:00:00Z','2026-09-01T11:00:00Z','${EMEA}','${OU_EMEA}',NULL,'unassigned'),
      ('${INST_SLICE}','oid','dev@i.com','${TEAM}',NULL,NULL,'claude-code','hSlice',
       '2026-05-01T09:00:00Z','2026-09-01T11:00:00Z','${APAC}','${OU_APAC}',NULL,'unassigned');
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('regression — only the seeded global card (mig 0004)', () => {
  it('costing output is unchanged: exact pre-0050 numbers, pinned card id + version', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(INST_REG, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-10T10:00:00Z' },
        { tokens: 500_000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-10T10:00:01Z' },
      ]),
      { sessionIds: [INST_REG] },
    )
    expect(res.attributionRowsWritten).toBe(2)
    expect(res.spansSkippedNoRateCard).toBe(0)
    // No provider cost on these records → rung 2 for both spans, which is what
    // keeps the pre-0050 numbers below meaningful.
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 2, carrier: 0, skipped: 0 })

    // Seeded lines: input $3/1M, output $15/1M (mig 0004).
    const input = await cardOf(INST_REG, '2026-05-10T10:00:00Z')
    expect(input.cost_usd).toBe('3.000000')
    expect(input.rate_card_id).toBe(GLOBAL_CARD)
    expect(input.rate_card_version).toBe(1)
    const output = await cardOf(INST_REG, '2026-05-10T10:00:01Z')
    expect(output.cost_usd).toBe('7.500000')
    expect(output.rate_card_id).toBe(GLOBAL_CARD)
    expect(output.rate_card_version).toBe(1)
  })

  it('temporal: an event OUTSIDE the seeded card\'s effective range does NOT use it (skipped, not priced)', async () => {
    // 2025-12-15 predates the seeded card's [2026-01-01, …) start. Pre-0050
    // this event was priced anyway (the COST-4 bug); now no card matches.
    const res = await runReadJoiner(
      t.db,
      reader(INST_EMEA, [
        { tokens: 999, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2025-12-15T10:00:00Z' },
      ]),
      { sessionIds: [INST_EMEA] },
    )
    expect(res.spansSkippedNoRateCard).toBe(1)
    expect(res.attributionRowsWritten).toBe(0)
    // Rung 3: no provider cost AND no card in force for that instant.
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 0, skipped: 1 })
  })

  it('the SAME out-of-range event is NOT skipped once the provider reports a cost — carrier fallback', async () => {
    // The behaviour change the design buys: "no card in force" used to mean
    // "drop the spend". It now means "we cannot SLICE it", and the provider's
    // total lands whole on the deterministic carrier row instead. Under-report
    // was the old safety net; it is no longer needed when the provider spoke.
    const res = await runReadJoiner(
      t.db,
      reader(INST_EMEA, [
        {
          tokens: 999,
          tokenType: 'output',
          model: 'claude-sonnet-4-7',
          tsEvent: '2025-12-15T10:05:00Z',
          sourceRunId: 'req_no_card',
          lawCostUsd: 0.004_2,
        },
      ]),
      { sessionIds: [INST_EMEA] },
    )
    expect(res.attributionRowsWritten).toBe(1)
    expect(res.spansSkippedNoRateCard).toBe(0)
    expect(res.costingRungs).toEqual({ provider: 0, rateCard: 0, carrier: 1, skipped: 0 })

    const [carried] = await t.client<
      { cost_usd: string; cost_basis: string; rate_card_id: string | null }[]
    >`
      SELECT cost_usd::text AS cost_usd, cost_basis, rate_card_id::text AS rate_card_id
      FROM attribution_record
      WHERE instance_id = ${INST_EMEA}::uuid AND source_run_id = 'req_no_card'`
    expect(carried!.cost_usd).toBe('0.004200')
    expect(carried!.cost_basis).toBe('provider-reported')
    expect(carried!.rate_card_id).toBeNull()
  })
})

describe('scope + temporal — region cards alongside the global card (mig 0050)', () => {
  beforeAll(async () => {
    // Two APAC-scoped periods (old period carries the HIGHER version — the
    // version-trumps-time trap) + a CoU-scoped card whose tier is NOT
    // implemented yet (resolveRateCard excludes cou_id IS NOT NULL — TODO).
    // Overlapping the GLOBAL card's period is now legal: the 0050 exclusion
    // keys on (scope_key, region, cou), no-overlap holds WITHIN a tier only.
    await t.client.unsafe(`
      INSERT INTO rate_card (id, scope_key, effective, basis, provenance, version, region_id, cou_id) VALUES
        ('${APAC_OLD}','anthropic:claude-code','[2026-01-01, 2026-06-01)'::tstzrange,'list',
         '{"source":"test"}'::jsonb, 2, '${APAC}', NULL),
        ('${APAC_CUR}','anthropic:claude-code','[2026-06-01, 2026-07-01)'::tstzrange,'list',
         '{"source":"test"}'::jsonb, 1, '${APAC}', NULL),
        ('${APAC_COU}','anthropic:claude-code','[2026-06-01, 2026-07-01)'::tstzrange,'list',
         '{"source":"test"}'::jsonb, 99, '${APAC}', '${OU_APAC}');
      INSERT INTO rate_line (rate_card_id, unit, unit_qty, unit_cost_usd, model, notes) VALUES
        ('${APAC_OLD}', 'input', 1000000, 10.00, NULL, 'APAC old period'),
        ('${APAC_CUR}', 'input', 1000000, 20.00, NULL, 'APAC current period'),
        -- Second unit on the current APAC card so the SLICE ratio it implies
        -- (1:3) is distinguishable from the global card's (1:5).
        ('${APAC_CUR}', 'output', 1000000, 60.00, NULL, 'APAC current period'),
        ('${APAC_COU}', 'input', 1000000, 50.00, NULL, 'CoU-scoped — must not be selected yet');
    `)
  }, 30_000)

  it('temporal: an event inside the OLD period uses the old card', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(INST_APAC, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-15T10:00:00Z' },
      ]),
      { sessionIds: [INST_APAC] },
    )
    expect(res.attributionRowsWritten).toBe(1)
    const row = await cardOf(INST_APAC, '2026-05-15T10:00:00Z')
    expect(row.rate_card_id).toBe(APAC_OLD)
    expect(row.rate_card_version).toBe(2)
    expect(row.cost_usd).toBe('10.000000')
  })

  it('temporal: the CURRENT period\'s card wins even though its version is LOWER (effective beats version)', async () => {
    // Pre-0050, APAC_OLD (v2) would have priced this 2026-06-05 event despite
    // its period having ended on 06-01 — the live COST-4 bug.
    // Also proves the CoU-scoped card (v99, same region, effective for this
    // ts) is EXCLUDED: the cou tier is a documented TODO in resolveRateCard.
    const res = await runReadJoiner(
      t.db,
      reader(INST_APAC, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-06-05T10:00:00Z' },
      ]),
      { sessionIds: [INST_APAC] },
    )
    expect(res.attributionRowsWritten).toBe(1)
    const row = await cardOf(INST_APAC, '2026-06-05T10:00:00Z')
    expect(row.rate_card_id).toBe(APAC_CUR)
    expect(row.rate_card_version).toBe(1)
    expect(row.cost_usd).toBe('20.000000')
  })

  it('scope: an event from ANOTHER region falls through to the global card', async () => {
    // Same day as the APAC test above — if the per-run cache key dropped the
    // region, EMEA would inherit APAC's cached card ($20) instead of global ($3).
    const res = await runReadJoiner(
      t.db,
      reader(INST_EMEA, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-06-05T10:00:00Z' },
      ]),
      { sessionIds: [INST_EMEA] },
    )
    expect(res.attributionRowsWritten).toBe(1)
    const row = await cardOf(INST_EMEA, '2026-06-05T10:00:00Z')
    expect(row.rate_card_id).toBe(GLOBAL_CARD)
    expect(row.cost_usd).toBe('3.000000')
  })

  it('temporal fallback: after the region cards\' periods end, the region\'s events use the global card again', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(INST_APAC, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-08-15T10:00:00Z' },
      ]),
      { sessionIds: [INST_APAC] },
    )
    expect(res.attributionRowsWritten).toBe(1)
    const row = await cardOf(INST_APAC, '2026-08-15T10:00:00Z')
    expect(row.rate_card_id).toBe(GLOBAL_CARD)
    expect(row.cost_usd).toBe('3.000000')
  })

  it('with a provider cost, the SELECTED card still decides the slice — but not the amount', async () => {
    // The selection ladder is unchanged on rung 1; what changes is what the
    // selected card is FOR. Here the APAC current card (input $20 / output $60,
    // ratio 1:3) slices the provider's $0.12, where the global card would have
    // implied 1:5. The total is the provider's number either way.
    const res = await runReadJoiner(
      t.db,
      reader(INST_SLICE, [
        {
          tokens: 1_000_000,
          tokenType: 'input',
          model: 'claude-sonnet-4-7',
          tsEvent: '2026-06-20T10:00:00Z',
          sourceRunId: 'req_apac_slice',
          lawCostUsd: 0.12,
        },
        {
          tokens: 1_000_000,
          tokenType: 'output',
          model: 'claude-sonnet-4-7',
          tsEvent: '2026-06-20T10:00:00Z',
          sourceRunId: 'req_apac_slice',
          lawCostUsd: 0.12,
        },
      ]),
      { sessionIds: [INST_SLICE] },
    )
    expect(res.attributionRowsWritten).toBe(2)
    expect(res.costingRungs).toEqual({ provider: 1, rateCard: 0, carrier: 0, skipped: 0 })

    const rows = await t.client<
      { token_type: string; cost_usd: string; rate_card_id: string | null; cost_basis: string }[]
    >`
      SELECT token_type, cost_usd::text AS cost_usd, rate_card_id::text AS rate_card_id, cost_basis
      FROM attribution_record
      WHERE instance_id = ${INST_SLICE}::uuid AND source_run_id = 'req_apac_slice'
      ORDER BY token_type`
    expect(rows.map((r) => [r.token_type, r.cost_usd])).toEqual([
      ['input', '0.030000'], // 1/4 of $0.12 — the APAC ratio, not the global 1/6
      ['output', '0.090000'],
    ])
    for (const r of rows) {
      expect(r.rate_card_id).toBeNull()
      expect(r.cost_basis).toBe('provider-reported')
    }
    const [total] = await t.client<{ total: string }[]>`
      SELECT SUM(cost_usd)::text AS total FROM attribution_record
      WHERE instance_id = ${INST_SLICE}::uuid AND source_run_id = 'req_apac_slice'`
    expect(total!.total).toBe('0.120000')
  })

  it('CHECK: a CoU-scoped card without a region is rejected (strict scope ladder)', async () => {
    await expect(
      t.client.unsafe(`
        INSERT INTO rate_card (scope_key, effective, basis, provenance, version, region_id, cou_id)
        VALUES ('anthropic:claude-code','[2026-07-01, 2026-08-01)'::tstzrange,'list','{}'::jsonb,1,NULL,'${OU_APAC}')
      `),
    ).rejects.toThrow(/rate_card_cou_requires_region/)
  })

  it('EXCLUDE: two overlapping cards in the SAME tier are still rejected (0001 invariant preserved per tier)', async () => {
    // A second GLOBAL card overlapping the seeded one — the rebuilt exclusion
    // must still forbid it (COALESCE sentinel: NULL region/cou compare equal).
    await expect(
      t.client.unsafe(`
        INSERT INTO rate_card (scope_key, effective, basis, provenance, version)
        VALUES ('anthropic:claude-code','[2026-06-01, 2026-07-01)'::tstzrange,'list','{}'::jsonb,7)
      `),
    ).rejects.toThrow(/rate_card_scope_key_effective_excl/)
  })
})
