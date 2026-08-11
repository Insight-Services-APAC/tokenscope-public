// @vitest-environment node
/*
 * server/reports/coverage-meta.ts — the ReportMeta.coverage marker (Workstream D,
 * requirement 6). Real testcontainers DB (coverage-store.ts's own tables).
 *
 * Covers the cross-enterprise SUPPRESSION rule: the aggregate denominator is null
 * whenever ANY relevant enterprise's own census is unavailable/capped/stale — the
 * weakest link governs the whole report's completeness claim, never a partial "N of M"
 * that quietly drops the enterprise it could not classify.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { reportCoverageMeta } from '../../../server/reports/coverage-meta'
import { persistEnterpriseCoverage } from '../../../server/reconciliation/coverage-store'
import { summariseEnterpriseCoverage } from '../../../server/reconciliation/coverage'
import type { EnterpriseCoverageResult } from '../../../server/reconciliation/github-coverage'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM provider_org_coverage`
  await t.client`DELETE FROM provider_enterprise_coverage_census`
  await t.client`DELETE FROM provider_enterprise WHERE provider = 'github'`
})

async function insertEnterprise(externalId: string): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    INSERT INTO provider_enterprise (id, provider, external_id, display_name, github_app_id)
    VALUES (gen_random_uuid(), 'github', ${externalId}, ${externalId}, '123')
    RETURNING id::text AS id`
  return row!.id
}

function coverageResult(
  enterpriseId: string,
  externalId: string,
  opts: { available: boolean; capped?: boolean; orgCount?: number; orgs?: EnterpriseCoverageResult['orgs'] },
): EnterpriseCoverageResult {
  const orgs = opts.orgs ?? []
  return {
    enterpriseId,
    externalId,
    census: { available: opts.available, capped: opts.capped ?? false, reason: opts.available ? null : 'capability-denied', orgCount: opts.available ? (opts.orgCount ?? orgs.length) : null },
    orgs,
    summary: summariseEnterpriseCoverage(orgs.map((o) => o.state), {
      censusAvailable: opts.available,
      censusCapped: opts.capped ?? false,
      censusSize: opts.orgCount ?? orgs.length,
    }),
    probesCapped: false,
  }
}

describe('reportCoverageMeta', () => {
  it('not applicable when there is no GitHub provider_enterprise at all', async () => {
    const meta = await reportCoverageMeta(t.db)
    expect(meta).toEqual({ applicable: false, denominator: null, connected: 0, nonConnected: 0, stale: false })
  })

  it('a single, fully-available enterprise yields an honest N-of-M', async () => {
    const entId = await insertEnterprise('meta-single-ent')
    await persistEnterpriseCoverage(
      t.db,
      coverageResult(entId, 'meta-single-ent', {
        available: true,
        orgCount: 2,
        orgs: [
          { org: 'a', state: 'connected', providerOrgId: null },
          { org: 'b', state: 'suspended', providerOrgId: null },
        ],
      }),
    )
    const meta = await reportCoverageMeta(t.db)
    expect(meta).toEqual({ applicable: true, denominator: 2, connected: 1, nonConnected: 1, stale: false })
  })

  it('SUPPRESSION: one unavailable enterprise makes the WHOLE aggregate denominator null, even though another is fine', async () => {
    const goodId = await insertEnterprise('meta-good-ent')
    const badId = await insertEnterprise('meta-bad-ent')
    await persistEnterpriseCoverage(
      t.db,
      coverageResult(goodId, 'meta-good-ent', { available: true, orgCount: 3, orgs: [{ org: 'a', state: 'connected', providerOrgId: null }] }),
    )
    await persistEnterpriseCoverage(t.db, coverageResult(badId, 'meta-bad-ent', { available: false }))
    const meta = await reportCoverageMeta(t.db)
    expect(meta.applicable).toBe(true)
    expect(meta.denominator).toBeNull() // the bad enterprise poisons the aggregate claim
    expect(meta.connected).toBe(1) // per-org counts remain honest regardless
  })

  it('SUPPRESSION: a CAPPED census also poisons the aggregate, even though the pull "succeeded"', async () => {
    const entId = await insertEnterprise('meta-capped-ent')
    await persistEnterpriseCoverage(t.db, coverageResult(entId, 'meta-capped-ent', { available: true, capped: true, orgCount: 5 }))
    const meta = await reportCoverageMeta(t.db)
    expect(meta.denominator).toBeNull()
  })

  it('SUPPRESSION: a STALE (expired) observation poisons the aggregate AND is flagged', async () => {
    const entId = await insertEnterprise('meta-stale-ent')
    const past = new Date(Date.now() - 60 * 60 * 1000)
    await persistEnterpriseCoverage(
      t.db,
      coverageResult(entId, 'meta-stale-ent', { available: true, orgCount: 1, orgs: [{ org: 'a', state: 'connected', providerOrgId: null }] }),
      { now: past, ttlMs: 1000 },
    )
    const meta = await reportCoverageMeta(t.db)
    expect(meta.denominator).toBeNull()
    expect(meta.stale).toBe(true)
  })

  it('per-org connected/nonConnected counts sum across MULTIPLE enterprises', async () => {
    const ent1 = await insertEnterprise('meta-sum-ent-1')
    const ent2 = await insertEnterprise('meta-sum-ent-2')
    await persistEnterpriseCoverage(
      t.db,
      coverageResult(ent1, 'meta-sum-ent-1', {
        available: true,
        orgCount: 2,
        orgs: [
          { org: 'a', state: 'connected', providerOrgId: null },
          { org: 'b', state: 'connected', providerOrgId: null },
        ],
      }),
    )
    await persistEnterpriseCoverage(
      t.db,
      coverageResult(ent2, 'meta-sum-ent-2', {
        available: true,
        orgCount: 1,
        orgs: [{ org: 'c', state: 'not-installed', providerOrgId: null }],
      }),
    )
    const meta = await reportCoverageMeta(t.db)
    expect(meta).toEqual({ applicable: true, denominator: 3, connected: 2, nonConnected: 1, stale: false })
  })
})
