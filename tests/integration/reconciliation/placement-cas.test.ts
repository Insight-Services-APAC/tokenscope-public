// @vitest-environment node
/*
 * placeTeammateIfStillSelected — the re-enrichment worker's compare-and-set
 * placement (scaling plan Phase 1 item 3). The worker selects a candidate, then
 * awaits Graph; everything the selection relied on can change in that window.
 * Each refusal case below is a fact changed AFTER selection; the write must see
 * it and write nothing. The success case must land placement, provenance and the
 * audit row together or not at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'
import type { CasPlacementInput } from '../../../server/reconciliation/placement-service'

let t: TestDb
let emeaId = ''
let apacId = ''

const ACTOR = 'region-reenrichment-worker'

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES
    ('9a1e0000-0000-4000-8000-0000000000e1', 'emea', 'EMEA'),
    ('9a1e0000-0000-4000-8000-0000000000a1', 'apac', 'APAC')`
  emeaId = '9a1e0000-0000-4000-8000-0000000000e1'
  apacId = '9a1e0000-0000-4000-8000-0000000000a1'
})
afterAll(async () => {
  await stopTestDb(t)
})

let seq = 0
async function mkUnit(regionId: string, opts: { costOwning?: boolean } = {}): Promise<string> {
  seq += 1
  const [u] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, ${`cas_u${seq}`}::ltree, ${`cas-u${seq}`}, ${`CAS Unit ${seq}`}, 'practice', ${opts.costOwning ?? true})
    RETURNING id::text AS id`
  return u!.id
}

async function mkBill(orgUnitId: string): Promise<string> {
  seq += 1
  return makePlacementStore(t.db).createBillTeammate({ email: `cas${seq}@example.com`, displayName: null, orgUnitId })
}

async function stateOf(id: string) {
  const [r] = await t.client<{ org_unit_id: string; via: string | null; owner: string | null; synced: Date | null }[]>`
    SELECT org_unit_id::text AS org_unit_id, metadata->>'placedVia' AS via,
           metadata->>'placedOwnerOid' AS owner, last_sync_at AS synced
    FROM teammate WHERE id = ${id}::uuid`
  return r!
}

async function auditRowsFor(id: string) {
  return t.client<{ event_type: string; actor_system: string | null; payload: Record<string, unknown> }[]>`
    SELECT event_type, actor_system, payload FROM audit_event WHERE subject_id = ${id}::uuid ORDER BY ts_recorded`
}

async function signIn(teammateId: string): Promise<void> {
  // A live emit instance — the teammate is no longer rehome-safe.
  await t.client`INSERT INTO instance_attestation
      (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    SELECT gen_random_uuid(), 'oid-live', t.id, 'claude-code', t.region_id, t.org_unit_id, 'h-test', 'TEST'
    FROM teammate t WHERE t.id = ${teammateId}::uuid`
}

const move = (teammateId: string, from: string, to: string, regionId: string): CasPlacementInput => ({
  teammateId,
  selectedOrgUnitId: from,
  target: { kind: 'unit', orgUnitId: to, regionId },
  provenance: { via: 'manager-chain', ownerOid: 'owner-new' },
  actorSystem: ACTOR,
})

describe('placeTeammateIfStillSelected — a derived unit target', () => {
  it('moves, writes provenance, stamps last_sync_at and records the audit event', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    await t.client`UPDATE teammate SET last_sync_at = NULL WHERE id = ${tm}::uuid`

    expect(await store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).toBe('moved')

    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(target)
    expect(s.via).toBe('manager-chain')
    expect(s.owner).toBe('owner-new')
    expect(s.synced).not.toBeNull()
    const audit = await auditRowsFor(tm)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.event_type).toBe('teammate-org-unit-changed')
    expect(audit[0]!.actor_system).toBe(ACTOR)
    expect(audit[0]!.payload).toMatchObject({ previousOrgUnitId: holding, newOrgUnitId: target, targetKind: 'unit' })
  })

  it('refuses a teammate who signed in after selection', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    await signIn(tm)

    expect(await store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).toBe('refused')
    expect((await stateOf(tm)).org_unit_id).toBe(holding)
    expect(await auditRowsFor(tm)).toHaveLength(0)
  })

  it('refuses a teammate an admin moved by hand to another unit after selection', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const adminChoice = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    await t.client`UPDATE teammate SET org_unit_id = ${adminChoice}::uuid WHERE id = ${tm}::uuid`

    expect(await store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).toBe('refused')
    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(adminChoice)
    expect(s.via).toBeNull()
  })

  it('refuses a target that was retired after selection', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${target}::uuid`

    expect(await store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).toBe('refused')
    expect((await stateOf(tm)).org_unit_id).toBe(holding)
  })

  it('refuses a target that is no longer cost-owning', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    await t.client`UPDATE org_unit SET is_cost_owning_unit = false WHERE id = ${target}::uuid`

    expect(await store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).toBe('refused')
    expect((await stateOf(tm)).org_unit_id).toBe(holding)
  })

  it('refuses a target outside the derived region', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const apacUnit = await mkUnit(apacId)
    const tm = await mkBill(holding)

    expect(await store.placeTeammateIfStillSelected(move(tm, holding, apacUnit, emeaId))).toBe('refused')
    expect((await stateOf(tm)).org_unit_id).toBe(holding)
  })

  it('placement, provenance and audit are ONE transaction: a failed audit insert rolls the move back', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    await t.client.unsafe(`
      CREATE FUNCTION cas_test_fail_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.subject_id = '${tm}'::uuid THEN RAISE EXCEPTION 'cas-test: audit insert failed'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER cas_test_fail_audit BEFORE INSERT ON audit_event
        FOR EACH ROW EXECUTE FUNCTION cas_test_fail_audit();`)
    try {
      await expect(store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).rejects.toThrow()
    } finally {
      await t.client.unsafe(`DROP TRIGGER cas_test_fail_audit ON audit_event; DROP FUNCTION cas_test_fail_audit();`)
    }
    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(holding)
    expect(s.via).toBeNull()
  })

  it('…and the other direction: a move that fails at COMMIT leaves no audit row behind', async () => {
    const store = makePlacementStore(t.db)
    const holding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const target = await mkUnit(emeaId)
    const tm = await mkBill(holding)
    // A deferred constraint trigger fires at COMMIT, after the audit insert: the
    // audit row must roll back with the move, not survive it.
    await t.client.unsafe(`
      CREATE FUNCTION cas_test_fail_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${tm}'::uuid THEN RAISE EXCEPTION 'cas-test: commit failed'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER cas_test_fail_commit AFTER UPDATE ON teammate
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cas_test_fail_commit();`)
    try {
      await expect(store.placeTeammateIfStillSelected(move(tm, holding, target, emeaId))).rejects.toThrow()
    } finally {
      await t.client.unsafe(`DROP TRIGGER cas_test_fail_commit ON teammate; DROP FUNCTION cas_test_fail_commit();`)
    }
    expect((await stateOf(tm)).org_unit_id).toBe(holding)
    expect(await auditRowsFor(tm)).toHaveLength(0)
  })
})

describe('placeTeammateIfStillSelected — a holding target', () => {
  it('moves onto the intended region holding node, with no provenance', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const emeaHolding = await store.unplacedOrgUnitIdForRegion(emeaId)
    const tm = await mkBill(global)

    const out = await store.placeTeammateIfStillSelected({
      teammateId: tm,
      selectedOrgUnitId: global,
      target: { kind: 'holding-node', orgUnitId: emeaHolding, regionId: emeaId },
      provenance: null,
      actorSystem: ACTOR,
    })
    expect(out).toBe('moved')
    expect((await stateOf(tm)).org_unit_id).toBe(emeaHolding)
  })

  it('de-places onto the GLOBAL holding node when regionId is null', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const unit = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'gone' })

    const out = await store.placeTeammateIfStillSelected({
      teammateId: tm,
      selectedOrgUnitId: unit,
      target: { kind: 'holding-node', orgUnitId: global, regionId: null },
      provenance: null,
      actorSystem: ACTOR,
    })
    expect(out).toBe('moved')
    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(global)
    expect(s.via).toBeNull()
  })

  it('refuses a holding target that is not the intended holding node of the expected region', async () => {
    const store = makePlacementStore(t.db)
    const global = await store.unplacedOrgUnitId()
    const apacHolding = await store.unplacedOrgUnitIdForRegion(apacId)
    const tm = await mkBill(global)

    const out = await store.placeTeammateIfStillSelected({
      teammateId: tm,
      selectedOrgUnitId: global,
      target: { kind: 'holding-node', orgUnitId: apacHolding, regionId: emeaId },
      provenance: null,
      actorSystem: ACTOR,
    })
    expect(out).toBe('refused')
    expect((await stateOf(tm)).org_unit_id).toBe(global)
  })
})

describe('placeTeammateIfStillSelected — the provenance-only branch (target = current unit)', () => {
  const restamp = (tm: string, unit: string): CasPlacementInput => ({
    teammateId: tm,
    selectedOrgUnitId: unit,
    target: { kind: 'unit', orgUnitId: unit, regionId: emeaId },
    provenance: { via: 'manager-chain', ownerOid: 'owner-new' },
    actorSystem: ACTOR,
  })

  it('re-stamps a CHANGED provenance in place: one provenance audit row with before and after, no move audit', async () => {
    const store = makePlacementStore(t.db)
    const unit = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-old' })

    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('provenance-only')
    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(unit)
    expect(s.owner).toBe('owner-new')
    const audit = await auditRowsFor(tm)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.event_type).toBe('teammate-placement-provenance-changed')
    expect(audit[0]!.actor_system).toBe(ACTOR)
    expect(audit[0]!.payload).toEqual({
      orgUnitId: unit,
      before: { placedVia: 'manager-chain', placedOwnerOid: 'owner-old', placedAttribute: null },
      after: { placedVia: 'manager-chain', placedOwnerOid: 'owner-new', placedAttribute: null },
    })
  })

  it('an UNCHANGED provenance re-stamp writes no audit row (no flood every run)', async () => {
    const store = makePlacementStore(t.db)
    const unit = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-new' })

    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('provenance-only')
    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('provenance-only')
    expect(await auditRowsFor(tm)).toHaveLength(0)
  })

  it('refuses after an admin moved the teammate away and BACK (U → V → U): same unit, but no longer derived', async () => {
    const store = makePlacementStore(t.db)
    const unit = await mkUnit(emeaId)
    const elsewhere = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-old' })
    // Two manual placements during the await, each stripping provenance as
    // place-teammate.ts does. The unit ends where it was selected.
    for (const to of [elsewhere, unit]) {
      await t.client`UPDATE teammate SET org_unit_id = ${to}::uuid,
          metadata = coalesce(metadata,'{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAttribute' - 'placedAt'
        WHERE id = ${tm}::uuid`
    }

    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('refused')
    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(unit)
    expect(s.via).toBeNull() // the admin's assertion is not re-marked as derived
    expect(await auditRowsFor(tm)).toHaveLength(0)
  })

  it('refuses for a teammate who signed in after selection: provenance untouched', async () => {
    const store = makePlacementStore(t.db)
    const unit = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-old' })
    await signIn(tm)

    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('refused')
    expect((await stateOf(tm)).owner).toBe('owner-old')
  })

  it('refuses for a teammate an admin moved by hand: the admin placement is not marked derived', async () => {
    const store = makePlacementStore(t.db)
    const unit = await mkUnit(emeaId)
    const adminChoice = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-old' })
    // What place-teammate.ts does: move, and strip the provenance.
    await t.client`UPDATE teammate SET org_unit_id = ${adminChoice}::uuid,
        metadata = coalesce(metadata,'{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAttribute' - 'placedAt'
      WHERE id = ${tm}::uuid`

    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('refused')
    const s = await stateOf(tm)
    expect(s.org_unit_id).toBe(adminChoice)
    expect(s.via).toBeNull()
  })

  it('refuses when the current unit was retired after selection', async () => {
    const store = makePlacementStore(t.db)
    const unit = await mkUnit(emeaId)
    const tm = await mkBill(unit)
    await store.setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-old' })
    await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${unit}::uuid`

    expect(await store.placeTeammateIfStillSelected(restamp(tm, unit))).toBe('refused')
    expect((await stateOf(tm)).owner).toBe('owner-old')
  })
})
