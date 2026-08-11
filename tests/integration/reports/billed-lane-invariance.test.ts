// @vitest-environment node
/*
 * §B invariance golden (07-model-axis-subtraction-build.md r1-M3, test 11).
 *
 * The model-axis subtraction work (S1/S2) rebuilds the ATTRIBUTED lane's model
 * axis — new view arms, reason-typed remainder rows, fanned-out children. The
 * BILLED lane must not move by a cent through any of it: it reads
 * `provider_usage_fact` alone, and the acceptance is an ACTUAL RESPONSE
 * comparison, not a grep.
 *
 * One test run cannot compare two revisions of the code, so the comparison is
 * against a COMMITTED golden fixture: the billed-lane drivers response was
 * serialized on the seeded estate BEFORE the S2 changes
 * (`WRITE_GOLDEN=1 npx vitest run tests/integration/reports/billed-lane-invariance.test.ts`)
 * and checked in at tests/fixtures/billed-lane-drivers.golden.json. This test
 * asserts deep-equality of the live response against that file, so any change
 * that reaches a billed figure — through the view, the shared label helpers,
 * or the engine — fails here with the exact field that moved.
 *
 * The fixture is UUID-free by construction: only the model axis is captured
 * (model-string keys + the synthetic BILLED_NO_MODEL_KEY), in both widths
 * (whole-company and a region clamp) and in the month-aligned WITH_POOL shape
 * that exercises the chargebackCoverage sentences.
 *
 * Seeding mirrors tests/integration/reports/billed-drivers.test.ts — both
 * lanes deliberately hold different money, and the attributed lane (OTel rows,
 * unaccounted_usage fill days) is seeded precisely so the S2 fan-out has
 * something to change on the OTHER lane while this response stays identical.
 *
 * REGENERATING is a deliberate act, not a fix for a red run: only rerun with
 * WRITE_GOLDEN=1 when the billed lane's response is MEANT to change, and say
 * so in the same commit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  clampedFinance,
  clampedUsage,
  wholeCompanyFinance,
  wholeCompanyUsage,
} from '../../../server/reporting/engine/scope'
import { fetchDrivers } from '../../../server/reporting/engine/drivers'

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'billed-lane-drivers.golden.json',
)

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
let alice = ''
let bob = ''
let projAtlas = ''

/** June 1-5 exclusive — the part-month window. */
const WIN = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-06-05T00:00:00.000Z' }
/** Month-aligned — the only window the pooled Copilot invoice may fold over. */
const MONTH_WIN = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-07-01T00:00:00.000Z' }

// Deliberately un-round, deliberately not equal (billed-drivers.test.ts's rule):
// a fold that happens to be arithmetically plausible still fails.
const OPUS_USD = 411.25
const SONNET_USD = 88.5
const NOMODEL_USD = 17.75
const BOB_OPUS_USD = 260.5
const COPILOT_CREDITS_USD = 913.4
const COPILOT_LICENSE_USD = 137.5
const COPILOT_OVERAGE_USD = 64.25
const COPILOT_UNCLASSIFIED_USD = 9.75

async function fact(over: {
  provider?: string
  model?: string | null
  date?: string
  tool?: string
  costUsd?: number | null
  input?: number | null
  requests?: number | null
  teammate?: string
  region?: string
  unit?: string
}): Promise<void> {
  const isCost = over.costUsd != null
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
       input_tokens, requests, region_id, org_unit_id, cost_owning_unit_id)
    VALUES (
      ${'src-' + (over.provider ?? 'anthropic')},
      ${over.provider ?? 'anthropic'},
      ${over.teammate ?? alice}::uuid,
      'actor@x.test',
      ${over.date ?? '2026-06-02'}::date,
      ${over.tool ?? 'claude-code'},
      ${over.model === undefined ? 'claude-opus-5' : over.model},
      ${isCost ? 'tokens' : null},
      ${isCost ? over.costUsd : null},
      ${isCost ? null : (over.input ?? null)},
      ${isCost ? null : (over.requests ?? null)},
      ${over.region ?? regionA}::uuid,
      ${over.unit ?? unitA}::uuid,
      ${over.unit ?? unitA}::uuid)`
}

beforeAll(async () => {
  t = await startTestDb()

  await t.client`INSERT INTO region (code, display_name) VALUES ('gia', 'Golden A'), ('gib', 'Golden B')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='gia'`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='gib'`

  const mkUnit = async (region: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${code}::ltree, ${code}, ${'Unit ' + code}, 'practice', true)`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return u!.id
  }
  unitA = await mkUnit(regionA, 'giua')
  unitB = await mkUnit(regionB, 'giub')

  const mkTeammate = async (region: string, unit: string, email: string, name: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${'oid-' + email}, ${email}, ${name}, ${region}::uuid, ${unit}::uuid, true)`
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return m!.id
  }
  alice = await mkTeammate(regionA, unitA, 'golden-alice@x.test', 'Golden Alice')
  bob = await mkTeammate(regionB, unitB, 'golden-bob@x.test', 'Golden Bob')

  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('GI-ATLAS', 'h-gi-atlas', 'Atlas', 'billable', ${regionA}::uuid, ${unitA}::uuid)`
  ;[{ id: projAtlas }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='GI-ATLAS'`

  // ── The BILLED lane — the money this file pins ─────────────────────────────
  await fact({ model: 'claude-opus-5', costUsd: OPUS_USD })
  await fact({ model: 'claude-sonnet-5', costUsd: SONNET_USD })
  await fact({ model: null, costUsd: NOMODEL_USD })
  await fact({ model: 'claude-opus-5', costUsd: BOB_OPUS_USD, teammate: bob, region: regionB, unit: unitB })
  // A token row: measure exclusivity — never a $0 driver row.
  await fact({ model: 'claude-opus-5', input: 5000 })
  // GitHub consumption on the same key family: money on a model-NULL row, the
  // model dimension on its own requests row (mig 0120's shape).
  await fact({ provider: 'github', model: null, tool: 'copilot-cli', costUsd: COPILOT_CREDITS_USD })
  await fact({ provider: 'github', model: 'gpt-5.6-sol', tool: 'copilot-cli', requests: 42 })

  // ── The ATTRIBUTED lane — the lane S2 rebuilds. Seeded so this suite proves
  // the billed response is invariant WHILE the other lane has material to move.
  const mkInstance = async (tm: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), ${'p-' + tm}, ${tm}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [i] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm}::uuid LIMIT 1`
    return i!.id
  }
  const instA = await mkInstance(alice, regionA, unitA)
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type, tokens,
       cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instA}::uuid, ${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, ${projAtlas}::uuid, 'claude-code',
            'claude-sonnet-5', 'input', 1000, 40, 'tier-1', 'estimated',
            '2026-06-02T00:00:00Z'::timestamptz, 'sess-golden-alice')`
  // Fill days — exactly the rows whose arm-2 rendering S2 changes.
  await t.client`INSERT INTO unaccounted_usage
      (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source, tagged_at)
    VALUES (${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, ${projAtlas}::uuid,
            '2026-06-03'::date, 'copilot-cli', 60, 0, 'api-reconciled', now())`
  await t.client`INSERT INTO unaccounted_usage
      (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source)
    VALUES (${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, NULL,
            '2026-06-04'::date, 'claude-code', 33, 0, 'api-reconciled')`

  // ── The pooled Copilot chargeback (month grain, homed to unitA) ────────────
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'gi-ent', 'Golden Enterprise')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`
    SELECT id::text AS id FROM provider_enterprise WHERE external_id='gi-ent'`
  await t.client`INSERT INTO copilot_pool_bill
      (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
       license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-06-01'::date, ${entId}::uuid, NULL, ${unitA}::uuid, 5,
            ${COPILOT_LICENSE_USD}, ${COPILOT_OVERAGE_USD}, ${COPILOT_UNCLASSIFIED_USD}, 80, 90)`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

/**
 * The captured surface: the billed-lane MODEL axis, both widths, plus the
 * month-aligned WITH_POOL shape. Model-axis keys are model strings and the
 * synthetic no-model key — no UUID reaches the serialization, which is what
 * makes a committed fixture byte-stable across fresh databases.
 */
async function snapshot(): Promise<unknown> {
  const shapes = {
    'across:model:WIN': await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'model', 'chargeback'),
    'regional:model:WIN': await fetchDrivers(
      t.db,
      clampedUsage(sql`u.region_id = ${regionA}::uuid`),
      WIN,
      'model',
      'chargeback',
    ),
    'across:model:MONTH_WIN:pool': await fetchDrivers(
      t.db,
      wholeCompanyUsage,
      MONTH_WIN,
      'model',
      'chargeback',
      { financeScope: wholeCompanyFinance, copilotChargeback: true },
    ),
    'regional:model:MONTH_WIN:pool': await fetchDrivers(
      t.db,
      clampedUsage(sql`u.region_id = ${regionA}::uuid`),
      MONTH_WIN,
      'model',
      'chargeback',
      { financeScope: clampedFinance(sql`u.region_id = ${regionA}::uuid`), copilotChargeback: true },
    ),
  }
  // Through JSON so `undefined` fields drop on BOTH sides of the comparison —
  // the golden holds exactly what the wire would carry.
  return JSON.parse(JSON.stringify(shapes))
}

describe('the billed-lane drivers response is byte-identical to the committed golden', () => {
  it('matches tests/fixtures/billed-lane-drivers.golden.json in full', async () => {
    const live = await snapshot()
    // ONE serialization on both sides: the golden was WRITTEN as
    // `JSON.stringify(live, null, 2) + '\n'`, so the live response serialized
    // the same way must equal the committed file's exact TEXT. A parsed
    // toEqual alone proves structure, not bytes — key order and number
    // formatting drift would slide through it.
    const liveText = JSON.stringify(live, null, 2) + '\n'

    if (process.env.WRITE_GOLDEN) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, liveText)
      // A written golden is only evidence once a NON-writing run has passed.
      expect(existsSync(GOLDEN_PATH)).toBe(true)
      return
    }

    expect(
      existsSync(GOLDEN_PATH),
      'golden fixture missing — capture it on the PRE-CHANGE tree with WRITE_GOLDEN=1',
    ).toBe(true)
    const goldenText = readFileSync(GOLDEN_PATH, 'utf8')
    // Readable-failure companion FIRST: when a figure moves, the structural
    // diff names the exact field. The byte gate below is the acceptance.
    expect(live).toEqual(JSON.parse(goldenText))
    expect(liveText).toBe(goldenText)
  })

  it('the golden actually holds billed money — the comparison is not vacuous', async () => {
    const golden = process.env.WRITE_GOLDEN
      ? (await snapshot() as Record<string, { headlineUsd: number }>)
      : (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, { headlineUsd: number }>)
    expect(golden['across:model:WIN']!.headlineUsd).toBeCloseTo(
      OPUS_USD + SONNET_USD + NOMODEL_USD + BOB_OPUS_USD,
      6,
    )
    expect(golden['regional:model:WIN']!.headlineUsd).toBeCloseTo(
      OPUS_USD + SONNET_USD + NOMODEL_USD,
      6,
    )
  })
})
