// @vitest-environment node
/*
 * Engine credit-lane integration — GitHub ai-credits reconciliation END TO END
 * (joiner-persisted credit_qty -> engine OTel operand -> reconciliation_record).
 *
 * This is the test that proves the credit plumbing actually reconciles: a Copilot
 * span lands `attribution_record.credit_qty` via the joiner, then the engine's
 * ai-credits operand (SUM(credit_qty) x rate) must MATCH the billing line.
 *
 * Stream A's engine fix (commit f411ad6) made the OTel-operand telemetry-only
 * filter lane-aware: the ai-credits lane no longer excludes telemetry-only rows
 * (credit_qty is written only on Copilot rows, which are telemetry-only by design
 * in v1), so SUM(credit_qty) is now the live operand and a GitHub billing line
 * reconciles credit-vs-credit against it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { type TelemetryReader, type UsageRecord, WATERMARK_LOOKBACK_MS } from '../../../server/azure/reader'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { ReconciledLine } from '../../../server/reconciliation/types'

let t: TestDb
const TEAMMATE = '33333333-3333-3333-3333-333333333333'
const INST_COP = 'c0000000-0000-0000-0000-000000000099'
const TS = '2026-06-07T10:00:00Z'
const PERIOD = '2026-06-07'
const NOW = new Date('2026-06-08T12:00:00.000Z')

class StubReader {
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAMMATE}', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('44444444-4444-4444-4444-444444444444', 'AFL-AII', 'h-afl-aii', 'AFL · AI Insights',
              'billable', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('44444444-4444-4444-4444-444444444444', '${TEAMMATE}',
              '[2026-01-01, 2099-01-01)'::tstzrange);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${INST_COP}', 'oid', 'dev@i.com', '${TEAMMATE}', 'h-afl-aii', 'AFL-AII',
       'copilot-cli', 'hashCOP99', '2026-06-07 09:00:00+00', '2026-06-07 09:30:00+00',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

function githubLine(over: Partial<ReconciledLine> = {}): ReconciledLine {
  return {
    provider: 'github',
    enterpriseRef: 'acme-partner-demo',
    licenseOrg: 'acme-prod',
    periodDate: PERIOD,
    subject: { kind: 'teammate', teammateId: TEAMMATE },
    category: 'copilot_interactive',
    unit: { quantity: 9, unitType: 'ai-credits' },
    facets: { gross: 9, discount: 0, net: 9 },
    rateUsdPerUnit: '0.01',
    amountUsd: '0.09',
    spendClass: 'estimated',
    raw: { test: true },
    ...over,
  }
}

describe('engine credit-lane (GitHub ai-credits) — joiner credit_qty reconciles', () => {
  it('matches a GitHub billing line against telemetry credit_qty (no false untagged)', async () => {
    // 9_000_000_000 nano_aiu = 9 credits via the joiner.
    const reader = new StubReader(
      new Map([[INST_COP, [
        { tokens: 12000, tokenType: 'input', model: 'copilot/claude-sonnet-4-6', tsEvent: TS,
          claudeSessionId: 'conv-credit-lane', sourceRunId: 'cop-credit-001',
          projectCodeHash: 'h-afl-aii', nanoAiu: 9_000_000_000 },
      ]]]),
    ) as unknown as TelemetryReader

    await runReadJoiner(t.db, reader, { sessionIds: [INST_COP] })

    // Sanity: the joiner persisted the credit operand on a telemetry-only row.
    const [arow] = await t.client<{ credit_qty: string; cost_basis: string }[]>`
      SELECT credit_qty::text, cost_basis FROM attribution_record
      WHERE instance_id = ${INST_COP}::uuid AND token_type = 'input'`
    expect(Number(arow!.credit_qty)).toBeCloseTo(9, 6)
    expect(arow!.cost_basis).toBe('telemetry-only')

    // The engine must reconcile credit-vs-credit: otelUsd = 9 credits x $0.01 = $0.09,
    // exactly the billing line -> delta ~ 0 -> 'matched'. A 'matched' disposition is
    // rounding noise, so the engine intentionally writes NO reconciliation_record for
    // it (engine.ts: "no record for rounding-noise matches"). The proof that the
    // credit lane is live is therefore: matched == 1 and NO 'untagged' row is written.
    const res = await runReconcileEngine(t.db, [githubLine()], { now: NOW })
    expect(res.matched).toBe(1)
    expect(res.recordsWritten).toBe(0)

    // Pre-fix (telemetry-only excluded from the credit SUM) this line classified as
    // 'untagged' and DID write a record. Assert that regression cannot recur.
    const [{ c }] = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM reconciliation_record
      WHERE actual_unit_type = 'ai-credits' AND disposition = 'untagged'`
    expect(Number(c)).toBe(0)
  })
})
