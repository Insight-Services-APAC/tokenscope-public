// @vitest-environment node
/*
 * Personal subscription declaration (ADR-0011 D3/D4, design §4.3, Required
 * outcome 6). Covers the ADR-0010 rule-2 corroboration carve-out and pins the
 * invariant that teammate declarations never alter provider-backed chargeback.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { recomputeGovernanceVerdicts } from '../../../server/governance/recompute'
import { detectOverEmission } from '../../../server/usage/over-emission-detection'

import getHandler from '../../../server/api/v1/me/personal-subscription.get'
import putHandler from '../../../server/api/v1/me/personal-subscription.put'
import deleteHandler from '../../../server/api/v1/me/personal-subscription/[tool].delete'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string
let instanceId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'ps-r', displayName: 'PS R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ps.svc', code: 'ps-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ps-dev', email: 'ps-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: 'oid-ps-dev',
    teammateId,
    projectCodeHash: 'h',
    rawProjectCode: 'PS',
    tool: 'claude-code',
    tsStart: new Date('2026-06-01T00:00:00Z'),
    regionId,
    orgUnitId: ouId,
  })
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM inbox_item WHERE category = 'personal-subscription-prompt'`
  await t.client`DELETE FROM personal_subscription_declaration`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM provider_org WHERE external_org_id LIKE 'ps-authority-%'`
  await t.client`UPDATE governance_cutover_state SET status = 'not_started', preflight_snapshot = NULL, preflight_verified_at = NULL, preflight_verified_by = NULL, activated_at = NULL, activated_by = NULL, rolled_back_at = NULL, rolled_back_by = NULL WHERE id = 1`
  await t.client`DELETE FROM attribution_record`
  await t.client`DELETE FROM over_emission`
})

function ev(opts: {
  method: string
  body?: unknown
  session: Session
  params?: Record<string, string>
  origin?: string
}) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: opts.origin ?? 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof getHandler>[0]
}

const dev = (): Session => ({ teammateId, email: 'ps-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'ps.svc' })

describe('self-service declare / list / revoke', () => {
  it('declares, lists, and revokes a personal subscription; audited', async () => {
    const since = new Date()
    const created = (await putHandler(
      ev({ method: 'PUT', session: dev(), body: { tool: 'claude-code', subscriptionType: 'Claude Max', monthlyCostUsd: 100 } }),
    )) as { id: string; updated: boolean }
    expect(created.updated).toBe(false)

    const list = (await getHandler(ev({ method: 'GET', session: dev() }))) as { declarations: { tool: string; subscriptionType: string; monthlyCostUsd: number }[] }
    expect(list.declarations).toHaveLength(1)
    expect(list.declarations[0]!.subscriptionType).toBe('Claude Max')
    expect(list.declarations[0]!.monthlyCostUsd).toBe(100)

    // PUT again for the SAME tool updates in place (does not duplicate).
    const updated = (await putHandler(
      ev({ method: 'PUT', session: dev(), body: { tool: 'claude-code', subscriptionType: 'Claude Max (annual)', monthlyCostUsd: 90 } }),
    )) as { updated: boolean }
    expect(updated.updated).toBe(true)
    const listAfterUpdate = (await getHandler(ev({ method: 'GET', session: dev() }))) as { declarations: unknown[] }
    expect(listAfterUpdate.declarations).toHaveLength(1)

    const revoked = (await deleteHandler(ev({ method: 'DELETE', session: dev(), params: { tool: 'claude-code' } }))) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
    const listAfterRevoke = (await getHandler(ev({ method: 'GET', session: dev() }))) as { declarations: unknown[] }
    expect(listAfterRevoke.declarations).toHaveLength(0)

    const auditRows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type IN ('personal-subscription-declared', 'personal-subscription-updated', 'personal-subscription-revoked')
        AND ts_recorded >= ${since.toISOString()}::timestamptz`
    expect(Number(auditRows[0]!.n)).toBe(3)
  })

  it('rejects an invalid tool', async () => {
    await expect(
      putHandler(ev({ method: 'PUT', session: dev(), body: { tool: 'copilot-cli', subscriptionType: 'x', monthlyCostUsd: 1 } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('CSRF: a cross-origin PUT is rejected', async () => {
    await expect(
      putHandler(
        ev({
          method: 'PUT',
          session: dev(),
          body: { tool: 'claude-code', subscriptionType: 'x', monthlyCostUsd: 1 },
          origin: 'http://evil.example',
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('provider chargeback authority', () => {
  it('rejects teammate-derived chargeback verdict sources at the database boundary', async () => {
    await expect(
      t.client`
        INSERT INTO actual_spend
          (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
           chargeback_exempt, governance_verdict_source)
        VALUES
          (${teammateId}::uuid, '2026-06-01'::date, 'claude-code', 1, 1, 5,
           'anthropic-analytics-api:invalid-personal-verdict', TRUE, 'personal-declared')`,
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('a personal declaration cannot override billed or tracked provider governance', async () => {
    await putHandler(ev({ method: 'PUT', session: dev(), body: { tool: 'claude-code', subscriptionType: 'Claude Max', monthlyCostUsd: 100 } }))

    const [billedOrg] = await t.db
      .insert(schema.providerOrg)
      .values({
        provider: 'anthropic',
        externalOrgId: 'ps-authority-billed',
        displayName: 'Billed',
        reconciliationMode: 'reconciled',
        billing: 'billed',
      })
      .returning()
    const [trackedOrg] = await t.db
      .insert(schema.providerOrg)
      .values({
        provider: 'anthropic',
        externalOrgId: 'ps-authority-tracked',
        displayName: 'Tracked',
        reconciliationMode: 'reconciled',
        billing: 'tracked',
      })
      .returning()
    await t.client`UPDATE governance_cutover_state SET status = 'activated' WHERE id = 1`

    const [billedRow] = await t.db
      .insert(schema.actualSpend)
      .values({
        teammateId,
        date: '2026-06-01',
        tool: 'claude-code',
        inputTokens: 1n,
        outputTokens: 1n,
        costUsd: '5.000000',
        source: 'anthropic-analytics-api:ps-authority-billed',
        providerOrgId: billedOrg!.id,
        chargebackExempt: true,
      })
      .returning()
    const [trackedRow] = await t.db
      .insert(schema.actualSpend)
      .values({
        teammateId,
        date: '2026-06-01',
        tool: 'claude-code',
        inputTokens: 1n,
        outputTokens: 1n,
        costUsd: '5.000000',
        source: 'anthropic-analytics-api:ps-authority-tracked',
        providerOrgId: trackedOrg!.id,
        chargebackExempt: false,
      })
      .returning()

    await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, {}))

    const rows = await t.client<{ id: string; chargeback_exempt: boolean; governance_verdict_source: string | null }[]>`
      SELECT id::text AS id, chargeback_exempt, governance_verdict_source
      FROM actual_spend
      WHERE id IN (${billedRow!.id}::uuid, ${trackedRow!.id}::uuid)
      ORDER BY id`
    const billed = rows.find((row) => row.id === billedRow!.id)
    const tracked = rows.find((row) => row.id === trackedRow!.id)
    expect(billed).toMatchObject({ chargeback_exempt: false, governance_verdict_source: 'governance:billed' })
    expect(tracked).toMatchObject({ chargeback_exempt: true, governance_verdict_source: 'governance:tracked' })
  })
})

describe('corroboration carve-out (ADR-0010 rule 2) — never weakened globally', () => {
  const WINDOW = { startDate: '2026-06-01', endDate: '2026-06-30' }
  const DAY = '2026-06-20'

  async function otelSession(conv: string, tool: string, costUsd: string): Promise<void> {
    await t.db.insert(schema.attributionRecord).values({
      instanceId,
      claudeSessionId: conv,
      teammateId,
      regionId,
      orgUnitId: ouId,
      tool,
      model: 'opus',
      tokenType: 'output',
      tokens: 1000n,
      costUsd,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(`${DAY}T12:00:00.000Z`),
      sourceRunId: randomUUID(),
    })
  }

  it('a declared tool with no corroborating bill is NOT flagged in the no-bill lane; an undeclared tool with the same shape IS', async () => {
    await putHandler(ev({ method: 'PUT', session: dev(), body: { tool: 'claude-code', subscriptionType: 'Claude Max', monthlyCostUsd: 100 } }))
    // No `actual_spend` bill row for either tool — both are "no bill to corroborate".
    await otelSession('sess-declared', 'claude-code', '300.00') // above the $250 floor
    await otelSession('sess-undeclared', 'claude-ai', '300.00') // same shape, DIFFERENT (undeclared) tool

    const res = await detectOverEmission(t.db, WINDOW)
    // Exactly one of the two (claude-ai) should be caught by the no-bill lane —
    // the declared claude-code day must NOT contribute to it.
    expect(res.noBillFlagged).toBe(1)
    expect(res.totalNoBillUsd).toBeCloseTo(300, 2)
  })

  it('prompts the affected teammate once per tool/month without auto-classifying, then resolves the prompt on declaration', async () => {
    await otelSession('sess-likely-personal', 'claude-code', '300.00')

    const first = await detectOverEmission(t.db, WINDOW)
    expect(first.personalPromptsDispatched).toBe(1)

    const prompts = await t.client<{
      recipient_teammate_id: string
      ack_state: string
      body: { tool: string; signalMonth: string; usageUsd: number; actionHref: string }
    }[]>`
      SELECT recipient_teammate_id::text AS recipient_teammate_id, ack_state, body::jsonb AS body
      FROM inbox_item
      WHERE category = 'personal-subscription-prompt'
    `
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.recipient_teammate_id).toBe(teammateId)
    expect(prompts[0]!.body).toMatchObject({
      tool: 'claude-code',
      signalMonth: '2026-06',
      usageUsd: 300,
      actionHref: '/account#personal-subscription',
    })

    const declarationsBefore = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM personal_subscription_declaration`
    expect(declarationsBefore[0]!.n).toBe('0')

    const second = await detectOverEmission(t.db, WINDOW)
    expect(second.personalPromptsDispatched).toBe(0)
    const promptCount = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM inbox_item WHERE category = 'personal-subscription-prompt'`
    expect(promptCount[0]!.n).toBe('1')

    await putHandler(
      ev({
        method: 'PUT',
        session: dev(),
        body: { tool: 'claude-code', subscriptionType: 'Claude Max', monthlyCostUsd: 100 },
      }),
    )
    const resolved = await t.client<{ ack_state: string }[]>`
      SELECT ack_state FROM inbox_item WHERE category = 'personal-subscription-prompt'`
    expect(resolved[0]!.ack_state).toBe('resolved')
  })

  it('deduplicates concurrent prompt producers at the database boundary', async () => {
    await otelSession('sess-concurrent', 'claude-code', '300.00')
    const results = await Promise.all([
      detectOverEmission(t.db, WINDOW),
      detectOverEmission(t.db, WINDOW),
    ])
    expect(results.reduce((sum, result) => sum + result.personalPromptsDispatched, 0)).toBe(1)

    const promptCount = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM inbox_item WHERE category = 'personal-subscription-prompt'`
    expect(promptCount[0]!.n).toBe('1')
  })

  it('does not prompt for a non-declarable tool or during an administrative backfill', async () => {
    await otelSession('sess-copilot', 'copilot-cli', '300.00')
    const nonDeclarable = await detectOverEmission(t.db, WINDOW)
    expect(nonDeclarable.noBillFlagged).toBe(1)
    expect(nonDeclarable.personalPromptsDispatched).toBe(0)

    await otelSession('sess-backfill', 'claude-code', '300.00')
    const backfill = await detectOverEmission(t.db, { ...WINDOW, dispatchPersonalPrompts: false })
    expect(backfill.noBillFlagged).toBe(2)
    expect(backfill.personalPromptsDispatched).toBe(0)

    const promptCount = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM inbox_item WHERE category = 'personal-subscription-prompt'`
    expect(promptCount[0]!.n).toBe('0')
  })

  it('without ANY declaration, both tools are flagged — the carve-out is opt-in, never a default weakening', async () => {
    await otelSession('sess-a', 'claude-code', '300.00')
    await otelSession('sess-b', 'claude-ai', '300.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.noBillFlagged).toBe(2)
  })
})
