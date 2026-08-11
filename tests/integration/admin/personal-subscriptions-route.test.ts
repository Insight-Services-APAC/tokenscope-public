// @vitest-environment node
/*
 * GET /api/v1/admin/governance/personal-subscriptions — the reviewer's view of
 * teammate-declared personal subscriptions.
 *
 * A declaration is the only usage-provenance statement a teammate creates for
 * themselves. It suppresses the no-bill signal but never changes provider
 * chargeback. These tests pin reviewability, RBAC, and mixed-funding context.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/governance/personal-subscriptions.get'

let t: TestDb
let regionId: string
let ouId: string
let alice: string
let bob: string
const MONTH = '2026-06'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'psa-r', displayName: 'PSA R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'psa.svc', code: 'psa-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const mk = async (email: string, oid: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email, displayName: email, role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    return tm!.id
  }
  alice = await mk('psa-alice@x.test', 'oid-psa-alice')
  bob = await mk('psa-bob@x.test', 'oid-psa-bob')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM personal_subscription_declaration`
  await t.client`DELETE FROM actual_spend`
  // Also the §A side. Without this the usage rows planted below leak into every
  // later test, and "covers nothing" only passes because it happens to run
  // first — an ordering dependency, not isolation.
  await t.client`DELETE FROM unaccounted_usage`
})

function ev(opts: { session: Session; query?: Record<string, string> }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const path = `/api/v1/admin/governance/personal-subscriptions${qs}`
  const e = {
    method: 'GET',
    // h3's getQuery reads event.path, not node.req.url — a mock without it
    // yields an empty query and every param assertion passes vacuously.
    path,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { host: 'localhost:3450', 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof handler>[0]
}

const sess = (role: Session['role'], teammateId: string): Session => ({
  teammateId,
  email: `psa-${role}@x.test`,
  displayName: role,
  role,
  regionId,
  orgPath: 'psa.svc',
})

async function declare(
  teammateId: string,
  tool: string,
  cost: number,
  opts: { declaredAt?: string; revokedAt?: string | null } = {},
) {
  await t.client`
    INSERT INTO personal_subscription_declaration
      (teammate_id, tool, subscription_type, monthly_cost_usd, declared_at, revoked_at)
    VALUES (${teammateId}::uuid, ${tool}, 'Claude Max', ${cost},
            ${opts.declaredAt ?? '2026-06-02T00:00:00Z'}::timestamptz,
            ${opts.revokedAt ?? null}::timestamptz)`
}

async function bill(teammateId: string, tool: string, cost: number, exempt: boolean, date = '2026-06-10') {
  await t.client`
    INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${teammateId}::uuid, ${date}::date, ${tool}, 0, 0, ${cost}, 'anthropic-analytics-api', ${exempt})`
}

/** §A usage via arm 2 of v_complete_usage. `unaccounted_usage` is the cheapest
 *  arm to plant (no instance_attestation FK); its ts_event is midnight UTC of
 *  `day`, which is what the interval assertions below key on. */
async function usage(teammateId: string, tool: string, cost: number, day: string) {
  await t.client`
    INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${teammateId}::uuid, ${regionId}::uuid, ${ouId}::uuid, ${day}::date, ${tool}, ${cost}, 0, 'api-reconciled')`
}

type Resp = {
  month: string
  declarations: {
    email: string
    tool: string
    revokedAt: string | null
    usageUsd: string
    providerSpendUsd: string
    declaredMonthlyCostUsd: string
  }[]
  totals: {
    effectiveCount: number
    activeAtMonthEndCount: number
    endedDuringMonthCount: number
    effectiveProviderSpendUsd: string
    providerBackedCount: number
  }
}

describe('GET /admin/governance/personal-subscriptions', () => {
  it('allows global-finops and lists a declaration nobody but its owner could see before', async () => {
    await declare(alice, 'claude-code', 100)
    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.month).toBe(MONTH)
    expect(res.declarations).toHaveLength(1)
    expect(res.declarations[0]!.email).toBe('psa-alice@x.test')
    expect(res.declarations[0]!.declaredMonthlyCostUsd).toBe('100.00')
    expect(res.totals.effectiveCount).toBe(1)
  })

  it('denies a region admin, who would otherwise read every region\'s declarations', async () => {
    await declare(alice, 'claude-code', 100)
    await expect(
      handler(ev({ session: sess('admin', bob), query: { month: MONTH } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('denies a developer — a declaration must not be readable by other developers', async () => {
    await declare(alice, 'claude-code', 100)
    await expect(
      handler(ev({ session: sess('developer', bob), query: { month: MONTH } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('surfaces provider-backed spend alongside a declaration without treating the declaration as an override', async () => {
    await declare(alice, 'claude-code', 100)
    await bill(alice, 'claude-code', 42, false)
    await declare(bob, 'claude-code', 50)
    // bob has a declaration and no provider-backed spend.

    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    const byEmail = new Map(res.declarations.map((d) => [d.email, d]))
    expect(byEmail.get('psa-alice@x.test')!.providerSpendUsd).toBe('42.000000')
    expect(byEmail.get('psa-bob@x.test')!.providerSpendUsd).toBe('0.000000')
    expect(res.totals.effectiveProviderSpendUsd).toBe('42.000000')
    expect(res.totals.providerBackedCount).toBe(1)
  })

  it('includes a declaration that ended during the month in that month\'s exposure totals', async () => {
    await declare(alice, 'claude-code', 100, { revokedAt: '2026-06-20T00:00:00Z' })
    await bill(alice, 'claude-code', 77, false)
    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.declarations).toHaveLength(1)
    expect(res.declarations[0]!.revokedAt).not.toBeNull()
    expect(res.declarations[0]!.providerSpendUsd).toBe('77.000000')
    expect(res.totals.effectiveCount).toBe(1)
    expect(res.totals.activeAtMonthEndCount).toBe(0)
    expect(res.totals.endedDuringMonthCount).toBe(1)
    expect(res.totals.effectiveProviderSpendUsd).toBe('77.000000')
    expect(res.totals.providerBackedCount).toBe(1)
  })

  it('keeps a declaration that covers nothing — the one a reviewer most wants to ask about', async () => {
    await declare(alice, 'claude-code', 100)
    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.declarations).toHaveLength(1)
    expect(res.declarations[0]!.usageUsd).toBe('0.000000')
    expect(res.declarations[0]!.providerSpendUsd).toBe('0.000000')
  })

  it('returns only declarations effective during the selected month', async () => {
    await declare(alice, 'claude-code', 100)
    await bill(alice, 'claude-code', 42, false) // dated 2026-06-10
    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: '2026-07' } }))) as Resp
    expect(res.declarations).toHaveLength(1)
    expect(res.declarations[0]!.providerSpendUsd).toBe('0.000000')

    const beforeDeclaration = (await handler(
      ev({ session: sess('global-finops', bob), query: { month: '2026-05' } }),
    )) as Resp
    expect(beforeDeclaration.declarations).toHaveLength(0)
    expect(beforeDeclaration.totals.effectiveCount).toBe(0)
  })

  it('correlates spend only inside the declaration effective interval', async () => {
    await declare(alice, 'claude-code', 100, {
      declaredAt: '2026-06-10T00:00:00Z',
      revokedAt: '2026-06-20T00:00:00Z',
    })
    await bill(alice, 'claude-code', 11, false, '2026-06-05')
    await bill(alice, 'claude-code', 22, false, '2026-06-15')
    await bill(alice, 'claude-code', 33, false, '2026-06-25')

    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.declarations).toHaveLength(1)
    expect(res.declarations[0]!.providerSpendUsd).toBe('22.000000')
    expect(res.totals.effectiveProviderSpendUsd).toBe('22.000000')
    expect(res.totals.providerBackedCount).toBe(1)
  })

  /*
   * The USAGE side of the effective interval, which nothing else exercises.
   *
   * The sibling "correlates spend only inside the declaration effective
   * interval" test plants three actual_spend rows and no usage rows at all, so
   * reverting the usage clipping to a plain whole-month window leaves it green.
   * Verified by mutation: without this test, that revert survives.
   */
  it('correlates USAGE only inside the declaration effective interval', async () => {
    await declare(alice, 'claude-code', 100, {
      declaredAt: '2026-06-10T00:00:00Z',
      revokedAt: '2026-06-20T00:00:00Z',
    })
    await usage(alice, 'claude-code', 11, '2026-06-05') // before it was declared
    await usage(alice, 'claude-code', 22, '2026-06-15') // inside
    await usage(alice, 'claude-code', 33, '2026-06-25') // after it was revoked

    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.declarations).toHaveLength(1)
    // Not 66: a declaration cannot vouch for usage that predates it or follows
    // its revocation, and crediting it with the whole month overstates what the
    // teammate actually declared.
    expect(res.declarations[0]!.usageUsd).toBe('22.000000')
    expect(res.totals.effectiveUsageUsd).toBe('22.000000')
  })

  /*
   * The MID-DAY handoff — the only shape that makes the correlated
   * candidate-declaration subquery load-bearing, and the one its sibling test
   * misses.
   *
   * "…change on the same day" below hands over at exactly midnight, so the day
   * boundary alone separates the two declarations and no day ever has two
   * candidates. Mutation-verified: neutering the candidate subquery leaves that
   * test green. Revoke and re-declare mid-day (0105 anticipates exactly this —
   * "a revoked one does not block a fresh declaration, e.g. switching
   * subscription type") and BOTH declarations overlap 06-15, so without the
   * subquery that day's $22 is counted twice and the total reads $88.
   */
  it('assigns a mid-day handover\'s bill to exactly one declaration', async () => {
    await declare(alice, 'claude-code', 100, {
      declaredAt: '2026-06-01T00:00:00Z',
      revokedAt: '2026-06-15T10:00:00Z',
    })
    await declare(alice, 'claude-code', 120, {
      declaredAt: '2026-06-15T10:00:00Z',
    })
    await bill(alice, 'claude-code', 11, false, '2026-06-10')
    await bill(alice, 'claude-code', 22, false, '2026-06-15') // both intervals touch this day
    await bill(alice, 'claude-code', 33, false, '2026-06-20')

    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.declarations).toHaveLength(2)
    // The contested day goes to the LATER declaration, once. Never 88.
    expect(res.declarations.map((d) => d.providerSpendUsd).sort()).toEqual(['11.000000', '55.000000'])
    expect(res.totals.effectiveProviderSpendUsd).toBe('66.000000')
  })

  it('assigns a day-grain bill once when declarations change on the same day', async () => {
    await declare(alice, 'claude-code', 100, {
      declaredAt: '2026-06-01T00:00:00Z',
      revokedAt: '2026-06-15T00:00:00Z',
    })
    await declare(alice, 'claude-code', 120, {
      declaredAt: '2026-06-15T00:00:00Z',
    })
    await bill(alice, 'claude-code', 11, false, '2026-06-10')
    await bill(alice, 'claude-code', 22, false, '2026-06-15')
    await bill(alice, 'claude-code', 33, false, '2026-06-20')

    const res = (await handler(ev({ session: sess('global-finops', bob), query: { month: MONTH } }))) as Resp
    expect(res.declarations).toHaveLength(2)
    expect(res.declarations.map((d) => d.providerSpendUsd).sort()).toEqual(['11.000000', '55.000000'])
    expect(res.totals.effectiveProviderSpendUsd).toBe('66.000000')
  })

  it('rejects a malformed month rather than silently defaulting to now', async () => {
    await expect(
      handler(ev({ session: sess('global-finops', bob), query: { month: '2026-6' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
