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
    await store.setPlacementProvenance(tmId, { via: 'manager-chain', ownerOid: 'gone-owner' }) // was chain-placed

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

  /*
   * C3 — the placement worklist's Department/Company columns are fed from a
   * snapshot captured HERE, from the directory record this worker already
   * fetched. Two properties matter and both are asserted:
   *   1. the snapshot lands even when the derivation resolves NOTHING — those
   *      are precisely the people an admin has to place by hand, so they are the
   *      ones who most need to be clusterable;
   *   2. it merges, never replaces: the placement provenance lives in the same
   *      jsonb column and the two writers must not erase each other.
   */
  it('captures the directory department/company onto the teammate, without clobbering provenance', async () => {
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'snap@example.com', displayName: null, orgUnitId: globalUnplaced })
    await store.setPlacementProvenance(tmId, { via: 'manager-chain', ownerOid: 'keep-me' })

    await runRegionReenrichment(t.db, {
      // An UNMAPPED department, so the derivation resolves nothing and the row is
      // left on the holding node — the hand-placement case.
      lookupDirectory: async (email) => ({
        oid: 'snap-oid', email, displayName: 'S', department: 'Sales-Solution Sales Management',
        companyName: 'Insight EMEA', jobTitle: null, costCenter: null, division: null,
      }),
      getManager: async () => null,
    })

    const [tm] = await t.client<{ dept: string | null; company: string | null; captured: string | null }[]>`
      SELECT metadata->'directory'->>'department'  AS dept,
             metadata->'directory'->>'companyName' AS company,
             metadata->'directory'->>'capturedAt'  AS captured
      FROM teammate WHERE id = ${tmId}::uuid`
    expect(tm!.dept).toBe('Sales-Solution Sales Management')
    expect(tm!.company).toBe('Insight EMEA')
    expect(tm!.captured).not.toBeNull() // a snapshot that cannot be dated cannot be judged stale
  })

  it('a directory record MISSING an attribute still writes the snapshot, with NULL for the absent one', async () => {
    /*
     * drizzle's sql`` OMITS an `undefined` binding rather than binding NULL, so a
     * DirectoryUser built without `companyName` rendered `'companyName', ::text`
     * and PostgreSQL rejected the whole statement — taking department with it.
     * The write is fenced, so the only symptom was a silently absent snapshot.
     * This is the case that pins the coercion.
     */
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'partial@example.com', displayName: null, orgUnitId: globalUnplaced })

    const r = await runRegionReenrichment(t.db, {
      lookupDirectory: async (email) => ({
        oid: 'partial-oid', email, displayName: 'P', department: 'Delivery',
        jobTitle: null, costCenter: null, division: null,
      } as unknown as DirectoryUser), // no companyName key at all
      getManager: async () => null,
    })
    expect(r.snapshotErrors).toBe(0)

    const [tm] = await t.client<{ dept: string | null; company: string | null; has: boolean }[]>`
      SELECT metadata->'directory'->>'department'  AS dept,
             metadata->'directory'->>'companyName' AS company,
             (metadata ? 'directory')              AS has
      FROM teammate WHERE id = ${tmId}::uuid`
    expect(tm!.has).toBe(true)
    expect(tm!.dept).toBe('Delivery')
    expect(tm!.company).toBeNull()
  })

  it('MERGES into metadata.directory — a capture never erases a field already under that key', async () => {
    /*
     * `metadata || jsonb_build_object('directory', {...})` merges at the TOP
     * level only: it protects the placement provenance (a sibling KEY) while
     * replacing everything under `directory` wholesale. Today's writer happens to
     * supply every field it knows about, so the loss is invisible — right up
     * until any other field lives there, and then one capture deletes it with no
     * error and no trace.
     */
    const store = makePlacementStore(t.db)
    const globalUnplaced = await store.unplacedOrgUnitId()
    const tmId = await store.createBillTeammate({ email: 'merge@example.com', displayName: null, orgUnitId: globalUnplaced })
    await t.client`
      UPDATE teammate
      SET metadata = jsonb_build_object('directory', jsonb_build_object(
            'department', 'Stale Dept', 'writtenByAnotherLane', 'keep-me'))
      WHERE id = ${tmId}::uuid`

    await store.captureDirectorySnapshot(tmId, { department: 'Fresh Dept', companyName: 'Insight X' })

    const [tm] = await t.client<{ dept: string | null; other: string | null; company: string | null }[]>`
      SELECT metadata->'directory'->>'department'            AS dept,
             metadata->'directory'->>'writtenByAnotherLane'  AS other,
             metadata->'directory'->>'companyName'           AS company
      FROM teammate WHERE id = ${tmId}::uuid`
    expect(tm!.dept).toBe('Fresh Dept') // the captured fields DO win
    expect(tm!.company).toBe('Insight X')
    expect(tm!.other).toBe('keep-me') // …and nothing else under the key is lost
  })

  it('a SECOND holding node, under a different code, is still a holding node to this worker', async () => {
    /*
     * The worklist, the region's unplaced count and the RLS clamp all classify a
     * holding node by unit_type — "a holding node is defined by BEING one, and a
     * tenant that mints a second one under a different code must still be
     * recognised as not a real placement". This worker classified by CODE, so the
     * same person appeared in the admin's unplaced worklist and was invisible to
     * the re-derivation meant to place them: one population, two definitions.
     */
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_hold2'::ltree, 'emea-holding-2', 'Unplaced (second)', 'holding', false)`
    const [second] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-holding-2'`
    const tmId = await store.createBillTeammate({ email: 'second-holding@example.com', displayName: null, orgUnitId: second!.id })

    await runRegionReenrichment(t.db, { lookupDirectory: enrich('EMEA Data & AI'), getManager: async () => null })

    // Considered, re-derived, and moved off the second holding node onto the
    // region's canonical one. Keyed on the code, it was never even a candidate.
    const [tm] = await t.client<{ code: string }[]>`
      SELECT ou.code FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id WHERE t.id = ${tmId}::uuid`
    expect(tm!.code).toBe('__UNPLACED__')
  })

  /*
   * A RULE placement is a DERIVED placement, so it must keep following the rule.
   * The candidate arm reads every kind in DERIVED_PLACEMENT_VIAS for exactly this
   * reason: keyed on 'manager-chain' alone, a teammate the mig-0112 unit rule
   * placed would be frozen in whichever unit the rule named on the day they were
   * provisioned, and re-pointing the rule would move nobody who already exists —
   * which is the defect C7 exists to close, reappearing one rule kind later.
   */
  it('re-derives a RULE-placed teammate when the rule is re-pointed', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${emeaId}::uuid, 'emea_ruleold'::ltree, 'emea-rule-old', 'EMEA Rule Old', 'practice', true),
             (${emeaId}::uuid, 'emea_rulenew'::ltree, 'emea-rule-new', 'EMEA Rule New', 'practice', true)`
    const [oldU] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-rule-old'`
    const [newU] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-rule-new'`
    const tmId = await store.createBillTeammate({ email: 'ruled@example.com', displayName: null, orgUnitId: oldU!.id })
    await store.setPlacementProvenance(tmId, { via: 'attribute-rule', attribute: 'department' })

    // The rule now names a DIFFERENT cost centre.
    await t.client`INSERT INTO directory_region_rule
        (attribute, match_mode, match_value, match_value_raw, region_id, org_unit_id)
      VALUES ('department', 'exact', 'ruled practice', 'Ruled Practice', ${emeaId}::uuid, ${newU!.id}::uuid)`

    await runRegionReenrichment(t.db, {
      lookupDirectory: enrich('Ruled Practice'),
      getManager: async () => null,
    })
    const [tm] = await t.client<{ code: string; via: string | null; attr: string | null }[]>`
      SELECT ou.code, t.metadata->>'placedVia' AS via, t.metadata->>'placedAttribute' AS attr
      FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id WHERE t.id = ${tmId}::uuid`
    expect(tm!.code).toBe('emea-rule-new')
    expect(tm!.via).toBe('attribute-rule')
    expect(tm!.attr).toBe('department')

    await t.client`DELETE FROM directory_region_rule WHERE match_value = 'ruled practice'`
    await t.client`DELETE FROM teammate WHERE id = ${tmId}::uuid`
  })

  it('an admin move clears provenance → re-enrichment does NOT revert it (admin authority wins)', async () => {
    const store = makePlacementStore(t.db)
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, cost_centre_code)
      VALUES (${emeaId}::uuid, 'emea_prac2'::ltree, 'emea-prac2', 'EMEA Practice 2', 'practice', true, 'CC-EMEA-2')`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='emea-prac2'`
    const tmId = await store.createBillTeammate({ email: 'pinned@example.com', displayName: null, orgUnitId: u!.id })
    await store.setPlacementProvenance(tmId, { via: 'manager-chain', ownerOid: 'someowner' })
    // The admin-move endpoints now strip the provenance (that is the fix); replicate it.
    await t.client`UPDATE teammate SET metadata = (coalesce(metadata,'{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAttribute' - 'placedAt') WHERE id=${tmId}::uuid`

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
