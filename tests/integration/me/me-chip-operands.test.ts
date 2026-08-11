// @vitest-environment node
/*
 * D11 (developer-pages W0c) — the me payloads carry the REPORTING freshness
 * operands for the W1 settlement/coverage chip row, against real Postgres via
 * the REAL handlers (AGENTS.md §"Never mock Drizzle").
 *
 * `/me/usage` and `/me/projects/{code}` gain:
 *   - `providerStates` — providerStatesForWindow's pure settling clock for the
 *     month the MTD payload describes: one entry per vendor axis
 *     (anthropic / github / usage), each in an honest settling state. The
 *     current (open) month is ALWAYS 'estimated' — the payloads are MTD.
 *   - `coverage` — reportCoverageMeta's persisted GitHub org-coverage marker;
 *     with nothing persisted it is the honest "cannot claim completeness"
 *     shape (applicable: false), never a fabricated denominator.
 *
 * Both are the exact helpers the reports-depth composites feed their `meta`
 * legs with — real operands, not re-derived prose (r1-H8's me-page leg).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import usageHandler from '../../../server/api/v1/me/usage.get'
import projectHandler from '../../../server/api/v1/me/projects/[code]/index.get'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let devId = ''

const PROJECT_CODE = 'CHIP-1'

function ev(routerParams: Record<string, string> = {}) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: '/x?window=30',
    context: { params: routerParams },
    node: {
      req: {
        method: 'GET',
        url: '/x?window=30',
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, cookie: '' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  const session = {
    teammateId: devId,
    email: 'chip@x.test',
    displayName: 'Chip',
    role: 'developer',
    regionId,
    orgPath: 'chip',
    issuedAt: new Date().toISOString(),
  } as unknown as Session
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof usageHandler>[0]
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'chip', displayName: 'Chip' }).returning()
  regionId = r!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'chip', code: 'chip', displayName: 'Chip', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = bu!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-chip', email: 'chip@x.test', regionId, orgUnitId })
    .returning()
  devId = tm!.id

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: PROJECT_CODE,
      codeHash: 'h-chip-1',
      displayName: 'Chip One',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  await t.db.insert(schema.projectAssignment).values({
    projectId: proj!.id,
    teammateId: devId,
    effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
  })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

/** The chip-row operand assertions, identical for both payloads (D14 mounts
 *  one chip row on both pages, so the operands must carry one shape). */
function expectChipOperands(payload: {
  providerStates?: Array<{ vendor: string; state: string; closeRun: boolean }>
  coverage?: { applicable: boolean; denominator: number | null; stale: boolean }
}) {
  // One settling clock per vendor axis, in the shared vocabulary.
  expect(payload.providerStates).toBeDefined()
  expect(payload.providerStates!.map((s) => s.vendor).sort()).toEqual([
    'anthropic',
    'github',
    'usage',
  ])
  for (const s of payload.providerStates!) {
    // MTD payloads describe the OPEN month → always 'estimated', and the close
    // never ran (there is no close run anywhere yet — settling.ts's contract).
    expect(s.state).toBe('estimated')
    expect(s.closeRun).toBe(false)
  }
  // Coverage: nothing persisted in this fixture → the honest
  // cannot-claim-completeness shape, never a fabricated denominator.
  expect(payload.coverage).toEqual({
    applicable: false,
    denominator: null,
    connected: 0,
    nonConnected: 0,
    stale: false,
  })
}

describe('/me/usage — chip-row operands (D11)', () => {
  it('carries providerStates + coverage from the reporting helpers', async () => {
    const payload = (await usageHandler(ev())) as Record<string, unknown>
    expectChipOperands(payload as Parameters<typeof expectChipOperands>[0])
    // Additive: the pre-W0c payload legs are untouched beside the new ones.
    expect(payload.month).toBeDefined()
    expect(payload.page_freshness).toBeDefined()
  })
})

describe('/me/projects/{code} — chip-row operands (D11)', () => {
  it('carries providerStates + coverage from the reporting helpers', async () => {
    const payload = (await projectHandler(
      ev({ code: PROJECT_CODE }) as unknown as Parameters<typeof projectHandler>[0],
    )) as Record<string, unknown>
    expectChipOperands(payload as Parameters<typeof expectChipOperands>[0])
    expect((payload.project as { code: string }).code).toBe(PROJECT_CODE)
    expect(payload.budget).toBeDefined()
  })
})
