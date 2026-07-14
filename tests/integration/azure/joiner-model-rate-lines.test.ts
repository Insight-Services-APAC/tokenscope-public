// @vitest-environment node
/*
 * Model-specific rate_line selection (migration 0061).
 *
 * THE BUG (pre-0061): the seeded card (mig 0004) held ONLY wildcard
 * (model = NULL) rate_line rows at SONNET placeholder prices, so computeCost()
 * — which prefers an exact (unit, model) line and falls back to the wildcard —
 * priced EVERY model, including claude-opus-4-8, at Sonnet rates (~50.5% mean
 * drift vs provider cost in admin diagnostics).
 *
 * THE FIX (0061): add model-specific lines on the SAME card with correct list
 * prices, keeping the wildcard rows as the fallback for unknown future models.
 *
 * This exercises the real seam: startTestDb() applies every migration including
 * 0061, then runReadJoiner() prices events through computeCost() against the
 * actual rate lines in the DB.
 *   1. claude-opus-4-8 → model-specific Opus lines ($5 / $25 / $0.50 / $6.25),
 *      NOT the Sonnet wildcard.
 *   2. an UNKNOWN model id → still falls back to the wildcard (Sonnet) lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb

const APAC = '11111111-1111-1111-1111-111111111111'
const OU_APAC = '22222222-2222-2222-2222-222222222222'
const TEAM = '33333333-3333-3333-3333-333333333333'
// Distinct instances per scenario so the per-instance watermark never filters a
// test's events (each instance's events stay ascending within its own scenario).
const INST_OPUS = '70707070-7070-4070-8070-707070707070' // model-specific opus pricing
const INST_UNKNOWN = '71717171-7171-4071-8071-717171717171' // unknown model → wildcard fallback

const GLOBAL_CARD = '90000000-0000-4000-8000-000000000001' // mig 0004 seed; mig 0061 adds model lines

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

const rowAt = async (inst: string, tsEvent: string) => {
  const rows = await t.client<
    { cost_usd: string; model: string; token_type: string; rate_card_id: string | null }[]
  >`
    SELECT cost_usd::text AS cost_usd, model, token_type, rate_card_id::text AS rate_card_id
    FROM attribution_record
    WHERE instance_id = ${inst}::uuid AND ts_event = ${tsEvent}::timestamptz`
  expect(rows.length).toBe(1)
  return rows[0]!
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES ('${APAC}','apac','APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type) VALUES
      ('${OU_APAC}','${APAC}','apac.services'::ltree,'apac-svcs','APAC Services','bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}','oid','dev@i.com','${APAC}','${OU_APAC}');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id,
       attestation_state)
    VALUES
      ('${INST_OPUS}','oid','dev@i.com','${TEAM}',NULL,NULL,'claude-code','hOpus',
       '2026-05-10T09:00:00Z','2026-05-10T11:00:00Z','${APAC}','${OU_APAC}',NULL,'unassigned'),
      ('${INST_UNKNOWN}','oid','dev@i.com','${TEAM}',NULL,NULL,'claude-code','hUnk',
       '2026-05-10T09:00:00Z','2026-05-10T11:00:00Z','${APAC}','${OU_APAC}',NULL,'unassigned');
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('model-specific rate lines (mig 0061)', () => {
  it('claude-opus-4-8 prices at the Opus lines ($5 / $25 / $0.50 / $6.25), NOT the Sonnet wildcard', async () => {
    const res = await runReadJoiner(
      t.db,
      reader(INST_OPUS, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-opus-4-8', tsEvent: '2026-05-10T10:00:00Z' },
        { tokens: 1_000_000, tokenType: 'output', model: 'claude-opus-4-8', tsEvent: '2026-05-10T10:00:01Z' },
        { tokens: 1_000_000, tokenType: 'cache-read', model: 'claude-opus-4-8', tsEvent: '2026-05-10T10:00:02Z' },
        { tokens: 1_000_000, tokenType: 'cache-write', model: 'claude-opus-4-8', tsEvent: '2026-05-10T10:00:03Z' },
      ]),
      { sessionIds: [INST_OPUS] },
    )
    expect(res.attributionRowsWritten).toBe(4)
    expect(res.spansSkippedNoRateCard).toBe(0)

    // Opus list (mig 0061), per 1M tokens. These are the post-fix numbers — the
    // pre-0061 Sonnet wildcard would have priced input $3 / output $15 / cache-read
    // $0.30 / cache-write $3.75.
    const input = await rowAt(INST_OPUS, '2026-05-10T10:00:00Z')
    expect(input.cost_usd).toBe('5.000000')
    expect(input.rate_card_id).toBe(GLOBAL_CARD)
    const output = await rowAt(INST_OPUS, '2026-05-10T10:00:01Z')
    expect(output.cost_usd).toBe('25.000000')
    const cacheRead = await rowAt(INST_OPUS, '2026-05-10T10:00:02Z')
    expect(cacheRead.cost_usd).toBe('0.500000')
    const cacheWrite = await rowAt(INST_OPUS, '2026-05-10T10:00:03Z')
    expect(cacheWrite.cost_usd).toBe('6.250000')
  })

  it('an UNKNOWN model still falls back to the wildcard (Sonnet) line', async () => {
    // No model-specific row for this id → computeCost falls back to model = NULL,
    // which holds the Sonnet placeholder ($3/1M input) from mig 0004.
    const res = await runReadJoiner(
      t.db,
      reader(INST_UNKNOWN, [
        { tokens: 1_000_000, tokenType: 'input', model: 'claude-future-model-9', tsEvent: '2026-05-10T10:00:00Z' },
      ]),
      { sessionIds: [INST_UNKNOWN] },
    )
    expect(res.attributionRowsWritten).toBe(1)
    expect(res.spansSkippedNoRateCard).toBe(0)

    const row = await rowAt(INST_UNKNOWN, '2026-05-10T10:00:00Z')
    expect(row.model).toBe('claude-future-model-9')
    expect(row.cost_usd).toBe('3.000000') // wildcard Sonnet fallback, not an Opus rate
    expect(row.rate_card_id).toBe(GLOBAL_CARD)
  })
})
