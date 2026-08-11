// @vitest-environment node
/*
 * #142 — per-surface lanes on the FINANCE reporting scope (`/reports/finance`),
 * the read that feeds the live /reporting?scope=finance CoU table. Real
 * Postgres via the REAL handler (per AGENTS.md §"Never mock Drizzle").
 *
 * Contract under test (server/reporting/finance.ts fetchFinanceCous):
 *   - each CoU row carries `lanes` [{ lane, label, usd }] in VENDOR_LANES
 *     order with all-zero lanes elided;
 *   - conservation: Σ non-copilot lanes == anthropicUsd (both fold from the
 *     SAME (CoU × tool) rows) and Σ == the provider bill for the month;
 *   - RBAC unchanged (global-finops/platform-admin only) and a malformed
 *     month still 400s — the lane split is additive, not a regression.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import indexHandler from '../../../server/api/v1/reports/finance/index.get'

let t: TestDb
let regionA = ''
let ccA = ''
/*
 * mig 0129: a DEDICATED teammate for this file's 'global-finops' session —
 * NEVER the shared sess() default sentinel, which the 'developer' 403 case
 * below ALSO resolves to.
 */
let lanesElevatedId = ''

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url,
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof indexHandler>[0]
}

const sess = (role: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({
    teammateId,
    email: 'x@rl.test',
    displayName: 'X',
    role,
    regionId: regionA,
    orgPath: 'rl',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'report-lanes-padded-to-thirty-two-chars!!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'report-lanes-hmac-key-padded-well-beyond-32-chars'

  await t.client`INSERT INTO region (code, display_name) VALUES ('rl', 'Report Lanes')`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rl'`
  regionA = r!.id

  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'rl'::ltree, 'rl-cc', 'RL Practice', 'bu', true)`
  const [cc] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='rl-cc'`
  ccA = cc!.id

  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-rl-a', 'a@rl.test', 'A', ${regionA}::uuid, ${ccA}::uuid, true)`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='a@rl.test'`

  // May 2026 Anthropic bill, split across Code + two non-Code surfaces.
  const asp = async (tool: string, cost: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
      VALUES (${tm!.id}::uuid, '2026-05-05'::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api')`
  }
  await asp('claude-code', 30)
  await asp('claude-ai', 12)
  await asp('claude-chrome', 6)

  // A SEPARATE, DEDICATED teammate for this file's 'global-finops' session
  // (mig 0129) — see the `lanesElevatedId` declaration above.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('oid-rl-gfo', 'gfo@rl.test', 'GFO', ${regionA}::uuid, ${ccA}::uuid, 'global-finops', true)`
  ;[{ id: lanesElevatedId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='gfo@rl.test'`
  await grantReportAccess(t.client, lanesElevatedId)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('/reports/finance — per-CoU surface lanes (#142)', () => {
  it('each CoU row carries ordered, zero-elided lanes; Σ non-copilot lanes == anthropicUsd == the bill', async () => {
    const res = await indexHandler(ev(sess('global-finops', lanesElevatedId), 'month=2026-05'))

    const cou = res.cous.find((c) => c.code === 'rl-cc')
    expect(cou).toBeDefined()
    expect(cou!.anthropicUsd).toBeCloseTo(48, 6) // 30 + 12 + 6

    expect(cou!.lanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai', 'claude-chrome'])
    expect(cou!.lanes.map((l) => l.label)).toEqual(['Claude Code', 'Claude Chat', 'Claude in Chrome'])
    expect(cou!.lanes.map((l) => l.usd)).toEqual([30, 12, 6])

    // Conservation: lanes and the provider totals fold from the same rows.
    const nonCopilot = cou!.lanes.filter((l) => l.lane !== 'copilot').reduce((a, l) => a + l.usd, 0)
    expect(nonCopilot).toBeCloseTo(cou!.anthropicUsd, 6)
    // …and the whole-company Σ=bill check still foots against the same figure.
    const anthropicBill = res.billCheck.providers.find((p) => p.provider === 'anthropic')
    expect(anthropicBill?.billUsd).toBeCloseTo(48, 6)
  })

  it('403s a developer (RBAC unchanged)', async () => {
    await expect(indexHandler(ev(sess('developer'), 'month=2026-05'))).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('400s a malformed month (validation unchanged)', async () => {
    await expect(indexHandler(ev(sess('global-finops'), 'month=bad'))).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
