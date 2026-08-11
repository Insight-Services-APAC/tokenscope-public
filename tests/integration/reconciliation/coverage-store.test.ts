// @vitest-environment node
/*
 * server/reconciliation/coverage-store.ts — persistence + expiry semantics (requirement
 * 5: "render expired observations unknown, never complete"). Real testcontainers DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  persistEnterpriseCoverage,
  loadPersistedEnterpriseCoverage,
  loadAllPersistedCoverage,
} from '../../../server/reconciliation/coverage-store'
import type { EnterpriseCoverageResult } from '../../../server/reconciliation/github-coverage'
import { summariseEnterpriseCoverage } from '../../../server/reconciliation/coverage'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

async function insertEnterprise(externalId: string): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    INSERT INTO provider_enterprise (id, provider, external_id, display_name, github_app_id)
    VALUES (gen_random_uuid(), 'github', ${externalId}, ${externalId}, '123')
    RETURNING id::text AS id`
  return row!.id
}

function resultFor(enterpriseId: string, externalId: string): EnterpriseCoverageResult {
  const orgs = [
    { org: 'connected-org', state: 'connected' as const, providerOrgId: null },
    { org: 'suspended-org', state: 'suspended' as const, providerOrgId: null },
  ]
  return {
    enterpriseId,
    externalId,
    census: { available: true, capped: false, reason: null, orgCount: 2 },
    orgs,
    summary: summariseEnterpriseCoverage(
      orgs.map((o) => o.state),
      { censusAvailable: true, censusCapped: false, censusSize: 2 },
    ),
    probesCapped: false,
  }
}

describe('persistEnterpriseCoverage + loadPersistedEnterpriseCoverage', () => {
  it('round-trips a fresh observation verbatim (not expired)', async () => {
    const entId = await insertEnterprise('store-fresh-ent')
    const now = new Date('2026-07-29T00:00:00.000Z')
    await persistEnterpriseCoverage(t.db, resultFor(entId, 'store-fresh-ent'), { now })

    const loaded = await loadPersistedEnterpriseCoverage(t.db, entId, { now })
    expect(loaded.census).toMatchObject({ available: true, capped: false, reason: null, orgCount: 2, stale: false })
    const byOrg = Object.fromEntries(loaded.orgs.map((o) => [o.org, o]))
    expect(byOrg['connected-org']).toMatchObject({ state: 'connected', lastObservedState: 'connected', stale: false })
    expect(byOrg['suspended-org']).toMatchObject({ state: 'suspended', lastObservedState: 'suspended', stale: false })
  })

  it('an EXPIRED observation reads as unknown/unavailable, never as still-connected/complete', async () => {
    const entId = await insertEnterprise('store-expired-ent')
    const observedAt = new Date('2026-07-29T00:00:00.000Z')
    await persistEnterpriseCoverage(t.db, resultFor(entId, 'store-expired-ent'), { now: observedAt, ttlMs: 1000 })

    // Read long after the 1s TTL elapsed.
    const readAt = new Date(observedAt.getTime() + 60_000)
    const loaded = await loadPersistedEnterpriseCoverage(t.db, entId, { now: readAt })

    expect(loaded.census.available).toBe(false) // never "still available"
    expect(loaded.census.orgCount).toBeNull() // never a stale denominator
    const byOrg = Object.fromEntries(loaded.orgs.map((o) => [o.org, o]))
    // The connected org must NOT still read as connected once stale.
    expect(byOrg['connected-org']!.state).toBe('coverage-unknown')
    expect(byOrg['connected-org']!.stale).toBe(true)
    // But the RAW last-observed value is preserved for operator context.
    expect(byOrg['connected-org']!.lastObservedState).toBe('connected')
    expect(byOrg['suspended-org']!.state).toBe('coverage-unknown')
    expect(byOrg['suspended-org']!.lastObservedState).toBe('suspended')
  })

  it('never observed at all reads as unavailable + not stale (distinct from expired)', async () => {
    const entId = await insertEnterprise('store-never-ent')
    const loaded = await loadPersistedEnterpriseCoverage(t.db, entId)
    expect(loaded.census).toEqual({ available: false, capped: false, reason: null, orgCount: null, observedAt: null, stale: false })
    expect(loaded.orgs).toEqual([])
  })

  it('a fresh persist REPLACES the touched org rows; an org not in the new pass keeps its prior row (bounded-pass safety)', async () => {
    const entId = await insertEnterprise('store-replace-ent')
    const now = new Date('2026-07-29T00:00:00.000Z')
    await persistEnterpriseCoverage(t.db, resultFor(entId, 'store-replace-ent'), { now })

    // Second pass only re-observes 'connected-org' (e.g. a probe-bounded tick) — its
    // state changes; 'suspended-org' is untouched by this pass and must survive.
    const second: EnterpriseCoverageResult = {
      enterpriseId: entId,
      externalId: 'store-replace-ent',
      census: { available: true, capped: false, reason: null, orgCount: 1 },
      orgs: [{ org: 'connected-org', state: 'not-installed', providerOrgId: null }],
      summary: summariseEnterpriseCoverage(['not-installed'], { censusAvailable: true, censusCapped: false, censusSize: 1 }),
      probesCapped: false,
    }
    await persistEnterpriseCoverage(t.db, second, { now: new Date(now.getTime() + 60_000) })

    const loaded = await loadPersistedEnterpriseCoverage(t.db, entId, { now: new Date(now.getTime() + 61_000) })
    const logins = loaded.orgs.map((o) => o.org).sort()
    expect(logins).toEqual(['connected-org', 'suspended-org'])
    expect(loaded.orgs.find((o) => o.org === 'connected-org')!.lastObservedState).toBe('not-installed')
    expect(loaded.orgs.find((o) => o.org === 'suspended-org')!.lastObservedState).toBe('suspended')
  })
})

describe('loadAllPersistedCoverage', () => {
  it('includes every github enterprise, even one never observed', async () => {
    const observedId = await insertEnterprise('store-all-observed-ent')
    const neverId = await insertEnterprise('store-all-never-ent')
    await persistEnterpriseCoverage(t.db, resultFor(observedId, 'store-all-observed-ent'))

    const all = await loadAllPersistedCoverage(t.db)
    const byId = Object.fromEntries(all.map((c) => [c.enterpriseId, c]))
    expect(byId[observedId]!.census.available).toBe(true)
    expect(byId[neverId]!.census).toMatchObject({ available: false, stale: false, observedAt: null })
  })
})

describe('persistEnterpriseCoverage — provider_org_id round-trips for the admin UI remediation link', () => {
  it('carries a REAL provider_org row id through unchanged', async () => {
    const entId = await insertEnterprise('store-poid-ent')
    const [org] = await t.client<{ id: string }[]>`
      INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id)
      VALUES ('github', 'homed-org', 'homed-org', ${entId}) RETURNING id::text AS id`
    const result: EnterpriseCoverageResult = {
      enterpriseId: entId,
      externalId: 'store-poid-ent',
      census: { available: true, capped: false, reason: null, orgCount: 1 },
      orgs: [{ org: 'homed-org', state: 'not-onboarded', providerOrgId: org!.id }],
      summary: summariseEnterpriseCoverage(['not-onboarded'], { censusAvailable: true, censusCapped: false, censusSize: 1 }),
      probesCapped: false,
    }
    await persistEnterpriseCoverage(t.db, result)
    const loaded = await loadPersistedEnterpriseCoverage(t.db, entId)
    expect(loaded.orgs[0]!.providerOrgId).toBe(org!.id)
  })
})
