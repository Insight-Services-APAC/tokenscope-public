// @vitest-environment node
/*
 * region-reenrichment — re-derives bill teammates on a holding node into their real region
 * (mig 0068). Validates the heal/backfill move AND the revoke-safety gate (a teammate with
 * a live emit instance is NEVER moved by the worker).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'
import { runRegionReenrichment } from '../../../server/workers/region-reenrichment'
import type { DirectoryUser } from '../../../server/azure/directory'

let t: TestDb
let emeaId = ''

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'emea', 'EMEA')`
  const [rg] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='emea'`
  emeaId = rg!.id
  await t.client`INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id)
    VALUES ('department', 'exact', 'emea data & ai', 'EMEA Data & AI', ${emeaId})`
})
afterAll(async () => { await stopTestDb(t) })

const enrich = (department: string | null) =>
  async (email: string): Promise<DirectoryUser> => ({
    oid: `oid-${email}`, email, displayName: 'D', department, jobTitle: null, costCenter: null, division: null,
  })

const regionCodeOf = async (tmId: string) => {
  const [tm] = await t.client<{ code: string }[]>`
    SELECT rg.code FROM teammate t JOIN region rg ON rg.id = t.region_id WHERE t.id = ${tmId}::uuid`
  return tm!.code
}

describe('runRegionReenrichment', () => {
  it('moves a never-logged-in bill teammate from global __unassigned__ to its department region', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'reenrich1@example.com', displayName: null, orgUnitId: globalUnplaced })
    expect(await regionCodeOf(tmId)).toBe('__unassigned__')

    const r = await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })
    expect(r.rehomed).toBeGreaterThanOrEqual(1)
    expect(await regionCodeOf(tmId)).toBe('emea')

    // Idempotent: a second run sees it already correct, no move.
    const r2 = await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })
    expect(r2.rehomed).toBe(0)
    expect(r2.alreadyCorrect).toBeGreaterThanOrEqual(1)
  })

  it('does NOT move a teammate with a live emit instance (revoke-safety gate)', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'reenrich2@example.com', displayName: null, orgUnitId: globalUnplaced })
    // Live instance (ts_actual_end NULL) → not rehome-safe. An attested instance must
    // carry a project (instance_attestation_attested_has_project), so stamp a hash.
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      SELECT gen_random_uuid(), 'oid-live', t.id, 'claude-code', t.region_id, t.org_unit_id, 'h-test', 'TEST'
      FROM teammate t WHERE t.id = ${tmId}::uuid`

    const r = await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })
    // It must not even be considered as a candidate.
    expect(await regionCodeOf(tmId)).toBe('__unassigned__')
    void r
  })

  it('a stale manager-chain UNIT placement (chain no longer resolves) is de-placed to global + provenance cleared', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, cost_centre_code)
      VALUES (${emeaId}::uuid, 'emea_prac'::ltree, 'emea-prac', 'EMEA Practice', 'practice', true, 'CC-EMEA-1')`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-prac'`
    const tmId = await store.createBillTeammate({ email: 'stale@example.com', displayName: null, orgUnitId: u!.id })
    await store.setPlacementProvenance(tmId, { ownerOid: 'gone-owner' }) // was chain-placed

    // Chain no longer resolves (no manager, department doesn't map) → de-place.
    const r = await runRegionReenrichment(t.db, {
      lookupDirectory: async (email) => ({ oid: 'stale-oid', email, displayName: 'S', department: 'Services', jobTitle: null, costCenter: null, division: null }),
      getManager: async () => null,
    })
    expect(r.rehomed).toBeGreaterThanOrEqual(1)
    const [tm] = await t.client<{ ou_code: string; region: string; via: string | null }[]>`
      SELECT ou.code AS ou_code, rg.code AS region, t.metadata->>'placedVia' AS via
      FROM teammate t JOIN org_unit ou ON ou.id=t.org_unit_id JOIN region rg ON rg.id=t.region_id WHERE t.id=${tmId}::uuid`
    expect(tm!.ou_code).toBe('__UNPLACED__') // de-placed off the stale unit
    expect(tm!.region).toBe('__unassigned__')
    expect(tm!.via).toBeNull() // provenance cleared
  })

  it('an admin move clears provenance → re-enrichment does NOT revert it (admin authority wins)', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, cost_centre_code)
      VALUES (${emeaId}::uuid, 'emea_prac2'::ltree, 'emea-prac2', 'EMEA Practice 2', 'practice', true, 'CC-EMEA-2')`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-prac2'`
    const tmId = await store.createBillTeammate({ email: 'pinned@example.com', displayName: null, orgUnitId: u!.id })
    await store.setPlacementProvenance(tmId, { ownerOid: 'someowner' })
    // The admin-move endpoints now strip the provenance (that is the fix); replicate it.
    await t.client`UPDATE teammate SET metadata = (coalesce(metadata,'{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAt') WHERE id=${tmId}::uuid`

    const r = await runRegionReenrichment(t.db, {
      lookupDirectory: async (email) => ({ oid: 'pinned-oid', email, displayName: 'P', department: 'Services', jobTitle: null, costCenter: null, division: null }),
      getManager: async () => null,
    })
    // No provenance + on a real (non-holding) unit → NOT a re-enrichment candidate → unchanged.
    const [tm] = await t.client<{ code: string }[]>`SELECT ou.code FROM teammate t JOIN org_unit ou ON ou.id=t.org_unit_id WHERE t.id=${tmId}::uuid`
    expect(tm!.code).toBe('emea-prac2')
    void r
  })
})
