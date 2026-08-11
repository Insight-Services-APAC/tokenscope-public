// @vitest-environment node
/*
 * Governance-key propagation (design §4.0, Required outcome 2) — every
 * ingest/replay/reconciliation writer stamps (provider_org_id,
 * provider_enterprise_id), and the bounded/resumable backfill worker resolves
 * historical rows + targeted resweeps. Real Postgres (per AGENTS.md).
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runAnalyticsPoll } from '../../../server/workers/analytics-poller'
import type { AnthropicAnalyticsClient } from '../../../server/anthropic/client'
import { runCopilotBillWriter } from '../../../server/workers/copilot-bill'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { ReconciledLine } from '../../../server/reconciliation/types'
import { enqueueOwedBill, makePlacementStore } from '../../../server/reconciliation/placement-store'
import { runGovernanceKeyBackfill, resweepProviderOrgReferences } from '../../../server/workers/governance-key-backfill'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'gk-r', displayName: 'GK R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'gk.svc', code: 'gk-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gk-dev', email: 'gk-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM reconciliation_record`
  await t.client`DELETE FROM pending_placement`
  await t.client`DELETE FROM personal_subscription_declaration`
  await t.client`DELETE FROM provider_org`
  await t.client`DELETE FROM provider_enterprise`
  await t.client`UPDATE governance_cutover_state SET status = 'not_started', preflight_snapshot = NULL, preflight_verified_at = NULL, preflight_verified_by = NULL, activated_at = NULL, activated_by = NULL, rolled_back_at = NULL, rolled_back_by = NULL WHERE id = 1`
})

describe('key propagation — server/workers/analytics-poller.ts (actual_spend)', () => {
  it('stamps provider_org_id when the org is registered', async () => {
    await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'gk-anth-org', displayName: 'X', reconciliationMode: 'reconciled' })
    const client = {
      getClaudeCodeUsage: async () => ({
        has_more: false,
        data: [
          {
            date: '2026-06-01',
            actor: { type: 'user_actor', email_address: 'gk-dev@x.test' },
            customer_type: 'api',
            model_breakdown: [
              { model: 'claude-sonnet-4-6', tokens: { input: 10, output: 5, cache_read: 0, cache_creation: 0 }, estimated_cost: { currency: 'USD', amount: 1 } },
            ],
          },
        ],
      }),
    } as unknown as AnthropicAnalyticsClient

    await runAnalyticsPoll(t.db, client, { startingAt: '2026-06-01', endingAt: '2026-06-01', externalOrgId: 'gk-anth-org' })

    const rows = await t.client<{ provider_org_id: string | null; governance_key_status: string | null }[]>`
      SELECT provider_org_id::text AS provider_org_id, governance_key_status
      FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_org_id).not.toBeNull()
    expect(rows[0]!.governance_key_status).toBe('resolved')
  })

  it('uses provider billing for chargeback even when the teammate declares the tool personal', async () => {
    const [org] = await t.db
      .insert(schema.providerOrg)
      .values({
        provider: 'anthropic',
        externalOrgId: 'gk-provider-authority',
        displayName: 'Provider authority',
        reconciliationMode: 'reconciled',
        billing: 'billed',
      })
      .returning()
    await t.db.insert(schema.personalSubscriptionDeclaration).values({
      teammateId,
      tool: 'claude-code',
      subscriptionType: 'Claude Max',
      monthlyCostUsd: '100.00',
    })
    await t.client`UPDATE governance_cutover_state SET status = 'activated' WHERE id = 1`

    const client = {
      getClaudeCodeUsage: async () => ({
        has_more: false,
        data: [
          {
            date: '2026-06-03',
            actor: { type: 'user_actor', email_address: 'gk-dev@x.test' },
            customer_type: 'api',
            model_breakdown: [
              { model: 'claude-sonnet-4-6', tokens: { input: 10, output: 5, cache_read: 0, cache_creation: 0 }, estimated_cost: { currency: 'USD', amount: 1 } },
            ],
          },
        ],
      }),
    } as unknown as AnthropicAnalyticsClient

    await runAnalyticsPoll(t.db, client, {
      startingAt: '2026-06-03',
      endingAt: '2026-06-03',
      externalOrgId: 'gk-provider-authority',
    })

    const readVerdict = async () =>
      (
        await t.client<{ chargeback_exempt: boolean; governance_verdict_source: string }[]>`
          SELECT chargeback_exempt, governance_verdict_source
          FROM actual_spend
          WHERE teammate_id = ${teammateId}::uuid AND date = '2026-06-03'::date`
      )[0]!

    expect(await readVerdict()).toEqual({
      chargeback_exempt: false,
      governance_verdict_source: 'governance:billed',
    })

    await t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${org!.id}::uuid`
    await runAnalyticsPoll(t.db, client, {
      startingAt: '2026-06-03',
      endingAt: '2026-06-03',
      externalOrgId: 'gk-provider-authority',
    })
    expect(await readVerdict()).toEqual({
      chargeback_exempt: true,
      governance_verdict_source: 'governance:tracked',
    })
  })

  it('leaves provider_org_id NULL (governance-unresolved) when the org is not registered — never guessed', async () => {
    const client = {
      getClaudeCodeUsage: async () => ({
        has_more: false,
        data: [
          {
            date: '2026-06-02',
            actor: { type: 'user_actor', email_address: 'gk-dev@x.test' },
            customer_type: 'api',
            model_breakdown: [
              { model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0 }, estimated_cost: { currency: 'USD', amount: 1 } },
            ],
          },
        ],
      }),
    } as unknown as AnthropicAnalyticsClient

    await runAnalyticsPoll(t.db, client, { startingAt: '2026-06-02', endingAt: '2026-06-02', externalOrgId: 'unregistered-org' })

    const rows = await t.client<{ provider_org_id: string | null; chargeback_exempt: boolean; governance_verdict_source: string | null }[]>`
      SELECT provider_org_id::text AS provider_org_id, chargeback_exempt, governance_verdict_source
      FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_org_id).toBeNull()
  })
})

describe('key propagation — server/workers/copilot-bill.ts (actual_spend)', () => {
  it('stamps provider_org_id + provider_enterprise_id for a registered org/enterprise', async () => {
    const [ent] = await t.db
      .insert(schema.providerEnterprise)
      .values({ provider: 'github', externalId: 'gk-ent', displayName: 'GK Ent', reconciliationMode: 'reconciled' })
      .returning()
    await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'github', externalOrgId: 'gk-gh-org', displayName: 'GK Org', reconciliationMode: 'reconciled', providerEnterpriseId: ent!.id })
    await t.db
      .insert(schema.teammateIdentityMap)
      .values({ teammateId, system: 'github', identifier: 'gk-login', identifierKind: 'username', enterpriseSlug: 'gk-ent', isCanonical: true })

    const stubClient = {
      listSeatsWithDiagnostics: async () => ({
        seats: [{ assignee: { login: 'gk-login' }, organization: { login: 'gk-gh-org' } }],
        pagesCapped: false,
        shortPageBreak: true,
      }),
    }
    const cred: ResolvedCredential = { secretName: 'x', value: 'unused', level: 'enterprise', kind: 'github-pat' }
    await runCopilotBillWriter(t.db, {
      enterpriseSlug: 'gk-ent',
      credential: cred,
      now: new Date('2026-06-15T00:00:00.000Z'),
      flatSeatPriceUsd: 39,
      clientOverride: stubClient as never,
    })

    const rows = await t.client<{ provider_org_id: string | null; provider_enterprise_id: string | null }[]>`
      SELECT provider_org_id::text AS provider_org_id, provider_enterprise_id::text AS provider_enterprise_id
      FROM actual_spend WHERE teammate_id = ${teammateId}::uuid AND tool = 'copilot-cli'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_org_id).not.toBeNull()
    expect(rows[0]!.provider_enterprise_id).not.toBeNull()
  })
})

describe('key propagation — server/reconciliation/engine.ts (reconciliation_record)', () => {
  const NOW = new Date('2026-06-08T12:00:00.000Z')
  function line(over: Partial<ReconciledLine> = {}): ReconciledLine {
    return {
      provider: 'anthropic',
      enterpriseRef: 'gk-engine-org',
      licenseOrg: null,
      periodDate: '2026-06-08',
      subject: { kind: 'teammate', teammateId },
      category: 'model_tokens',
      unit: { quantity: 1000, unitType: 'tokens' },
      rateUsdPerUnit: '0',
      amountUsd: '5.00',
      spendClass: 'estimated',
      raw: { test: true },
      ...over,
    }
  }

  it('stamps provider_org_id on the written reconciliation_record row', async () => {
    await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'gk-engine-org', displayName: 'X', reconciliationMode: 'reconciled' })

    await runReconcileEngine(t.db, [line()], { now: NOW })
    const rows = await t.client<{ provider_org_id: string | null; governance_key_status: string | null }[]>`
      SELECT provider_org_id::text AS provider_org_id, governance_key_status FROM reconciliation_record WHERE teammate_id = ${teammateId}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_org_id).not.toBeNull()
    expect(rows[0]!.governance_key_status).toBe('resolved')
  })

  it('a github enterprise-only line resolves provider_enterprise_id even with no license org', async () => {
    await t.db
      .insert(schema.providerEnterprise)
      .values({ provider: 'github', externalId: 'gk-engine-ent', displayName: 'X', reconciliationMode: 'reconciled' })
    await runReconcileEngine(
      t.db,
      [line({ provider: 'github', enterpriseRef: 'gk-engine-ent', licenseOrg: null, category: 'copilot_interactive', unit: { quantity: 10, unitType: 'ai-credits' } })],
      { now: NOW },
    )
    const rows = await t.client<{ provider_enterprise_id: string | null }[]>`
      SELECT provider_enterprise_id::text AS provider_enterprise_id FROM reconciliation_record WHERE teammate_id = ${teammateId}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_enterprise_id).not.toBeNull()
  })
})

describe('key propagation — pending_placement replay (server/reconciliation/placement-store.ts)', () => {
  it('carries the governance key through replay and ignores a personal declaration for chargeback', async () => {
    const [org] = await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'gk-replay-org', displayName: 'X', reconciliationMode: 'reconciled', billing: 'billed' })
      .returning()
    await enqueueOwedBill(t.db, {
      provider: 'anthropic',
      actualSource: 'anthropic-analytics-api:gk-replay-org',
      email: 'replay-target@x.test',
      tool: 'claude-code',
      date: '2026-06-10',
      costUsd: 3.5,
      providerOrgId: org!.id,
      providerEnterpriseId: null,
    })
    const [newTm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-replay-${randomUUID()}`, email: 'replay-target@x.test', role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    await t.db.insert(schema.personalSubscriptionDeclaration).values({
      teammateId: newTm!.id,
      tool: 'claude-code',
      subscriptionType: 'Claude Max',
      monthlyCostUsd: '100.00',
    })
    await t.client`UPDATE governance_cutover_state SET status = 'activated' WHERE id = 1`

    const store = makePlacementStore(t.db)
    const replayed = await store.replayOwedBills(newTm!.id, 'replay-target@x.test')
    expect(replayed).toBe(1)

    const rows = await t.client<{ provider_org_id: string | null; chargeback_exempt: boolean; governance_verdict_source: string | null }[]>`
      SELECT provider_org_id::text AS provider_org_id, chargeback_exempt, governance_verdict_source
      FROM actual_spend WHERE teammate_id = ${newTm!.id}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider_org_id).toBe(org!.id)
    expect(rows[0]!.chargeback_exempt).toBe(false)
    expect(rows[0]!.governance_verdict_source).toBe('governance:billed')
  })
})

describe('governance-key-backfill worker — bounded, resumable, targeted resweep', () => {
  async function seedUnkeyedRow(source: string, date = '2026-01-05') {
    const [row] = await t.db
      .insert(schema.actualSpend)
      .values({ teammateId, date, tool: 'claude-code', inputTokens: 1n, outputTokens: 1n, costUsd: '1.000000', source })
      .returning()
    return row!.id
  }

  it('resolves rows in BOUNDED batches and is RESUMABLE across multiple calls', async () => {
    await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'bf-org', displayName: 'X', reconciliationMode: 'reconciled' })
    // 5 resolvable rows (distinct dates so the unique index doesn't collapse them).
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await seedUnkeyedRow('anthropic-analytics-api:bf-org', `2026-01-${10 + i}`))

    const first = await runGovernanceKeyBackfill(t.db, { batchSize: 2 })
    expect(first.actualSpend.resolved).toBeLessThanOrEqual(2) // BOUNDED — never the whole backlog in one call

    let totalResolved = first.actualSpend.resolved
    let guard = 0
    while (totalResolved < 5 && guard < 10) {
      const next = await runGovernanceKeyBackfill(t.db, { batchSize: 2 })
      totalResolved += next.actualSpend.resolved
      guard++
    }
    expect(totalResolved).toBe(5) // RESUMABLE — converges to the full backlog across calls

    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM actual_spend WHERE governance_key_status = 'resolved' AND teammate_id = ${teammateId}::uuid`
    expect(Number(rows[0]!.n)).toBe(5)
  })

  it('parks a truly-unresolvable row as "unresolved" rather than rescanning it forever', async () => {
    await seedUnkeyedRow('anthropic-analytics-api', '2026-01-20') // bare prefix — no org suffix, unresolvable
    const result = await runGovernanceKeyBackfill(t.db, { batchSize: 50 })
    expect(result.actualSpend.parkedUnresolved).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ governance_key_status: string | null }[]>`
      SELECT governance_key_status FROM actual_spend WHERE source = 'anthropic-analytics-api' AND teammate_id = ${teammateId}::uuid`
    expect(rows[0]!.governance_key_status).toBe('unresolved')
  })

  it('a targeted resweep un-parks rows the moment the missing org is registered (design §8.4)', async () => {
    const id = await seedUnkeyedRow('anthropic-analytics-api:late-org', '2026-01-25')
    await runGovernanceKeyBackfill(t.db, { batchSize: 50 })
    const before = await t.client<{ governance_key_status: string | null }[]>`SELECT governance_key_status FROM actual_spend WHERE id = ${id}::uuid`
    expect(before[0]!.governance_key_status).toBe('unresolved') // parked — the org didn't exist yet

    // The org is registered/linked NOW (simulates the admin org-create endpoint).
    const [org] = await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'late-org', displayName: 'Late Org', reconciliationMode: 'reconciled' })
      .returning()
    const resweep = await resweepProviderOrgReferences(t.db, {
      providerOrgId: org!.id,
      provider: 'anthropic',
      externalOrgId: 'late-org',
      providerEnterpriseId: null,
    })
    expect(resweep.actualSpendResolved).toBe(1)

    const after = await t.client<{ governance_key_status: string | null; provider_org_id: string | null }[]>`
      SELECT governance_key_status, provider_org_id::text AS provider_org_id FROM actual_spend WHERE id = ${id}::uuid`
    expect(after[0]!.governance_key_status).toBe('resolved')
    expect(after[0]!.provider_org_id).toBe(org!.id)
  })
})
