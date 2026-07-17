// @vitest-environment node
/*
 * Bill-driven placement — end-to-end against testcontainers Postgres. Validates the
 * parts the dev CW can't run: the mig-0066 region trigger (H-A), bill-teammate
 * provisioning + cost-centre placement, owed-bill replay (M-B), and the
 * bind-or-adopt sign-in path (H2 — bill row then login = ONE teammate, no 500).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { makePlacementStore, enqueueOwedBill } from '../../../server/reconciliation/placement-store'
import { provisionAndPlace } from '../../../server/reconciliation/placement-service'
import { resolveOrCreateTeammate } from '../../../server/auth/jit-teammate'
import { runPlacementSync } from '../../../server/workers/placement-sync'
import type { DirectoryUser } from '../../../server/azure/directory'

let t: TestDb
let apacOrgUnit = ''

const dir = (email: string, costCenter: string | null): DirectoryUser => ({
  oid: 'na', email, displayName: 'Dir Name', department: null, jobTitle: null, costCenter, division: null,
})

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac', 'APAC')`
  const [rg] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='apac'`
  await t.client`INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit, cost_centre_code)
    VALUES (gen_random_uuid(), ${rg!.id}, 'apac.digital', 'apac-digital', 'APAC Digital', 'practice', true, 'CC-4310')`
  const [ou] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='apac-digital'`
  apacOrgUnit = ou!.id
})
afterAll(async () => { await stopTestDb(t) })
beforeEach(async () => {
  // Only the deletable, count-sensitive tables. We do NOT delete teammates — every
  // test uses a distinct email so they never collide, and audit_event (which FKs
  // the teammate) is append-only (DELETE is trigger-denied), so a teammate sweep
  // is both unnecessary and impossible.
  await t.client`DELETE FROM actual_spend WHERE tool IN ('claude-code','copilot-cli')`
  await t.client`DELETE FROM pending_placement`
})

describe('mig-0066 region trigger (H-A)', () => {
  it('teammate.region_id is derived from org_unit_id and follows a re-home', async () => {
    const store = makePlacementStore(t.db)
    const unplaced = await store.unplacedOrgUnitId()
    const id = await store.createBillTeammate({ email: 'trig@example.com', displayName: null, orgUnitId: unplaced })
    const [a] = await t.client<{ region_code: string }[]>`
      SELECT r.code AS region_code FROM teammate tm JOIN region r ON r.id=tm.region_id WHERE tm.id=${id}::uuid`
    expect(a!.region_code).toBe('__unassigned__') // followed the unplaced node's region
    await store.homeTeammate(id, apacOrgUnit)
    const [b] = await t.client<{ region_code: string }[]>`
      SELECT r.code AS region_code FROM teammate tm JOIN region r ON r.id=tm.region_id WHERE tm.id=${id}::uuid`
    expect(b!.region_code).toBe('apac') // region followed the re-home, never drifts
  })
})

describe('provisionAndPlace', () => {
  it('matching cost centre → bill teammate homed to the matched node (region follows)', async () => {
    const store = makePlacementStore(t.db)
    const r = await provisionAndPlace('Dev@example.com', { store, lookupDirectory: async (e) => dir(e, 'CC-4310') })
    expect(r).toMatchObject({ created: true, placed: true, reason: 'matched' })
    const [tm] = await t.client<{ oid: string; src: string; ou: string; region_code: string }[]>`
      SELECT tm.entra_oid AS oid, tm.source AS src, tm.org_unit_id::text AS ou, r.code AS region_code
      FROM teammate tm JOIN region r ON r.id=tm.region_id WHERE lower(tm.email)='dev@example.com'`
    expect(tm!.oid).toMatch(/^bill:/)
    expect(tm!.src).toBe('bill')
    expect(tm!.ou).toBe(apacOrgUnit)
    expect(tm!.region_code).toBe('apac')
  })

  it('no matching cost centre → __UNPLACED__ holding (rolls to the unassigned region, no CC)', async () => {
    const store = makePlacementStore(t.db)
    const r = await provisionAndPlace('ghost@example.com', { store, lookupDirectory: async (e) => dir(e, 'CC-NONE') })
    expect(r).toMatchObject({ placed: false, reason: 'no-match' })
    const [tm] = await t.client<{ region_code: string; cc: string | null }[]>`
      SELECT r.code AS region_code, ou.cost_centre_code AS cc
      FROM teammate tm JOIN org_unit ou ON ou.id=tm.org_unit_id JOIN region r ON r.id=tm.region_id
      WHERE lower(tm.email)='ghost@example.com'`
    expect(tm!.region_code).toBe('__unassigned__')
    expect(tm!.cc).toBeNull() // unplaced: no cost centre
  })

  it('replays owed bills into actual_spend, idempotently (M-B)', async () => {
    const store = makePlacementStore(t.db)
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'owed@example.com', tool: 'claude-code', date: '2026-06-10', costUsd: 12.5, inputTokens: 100, outputTokens: 50 })
    const r1 = await provisionAndPlace('owed@example.com', { store, lookupDirectory: async (e) => dir(e, 'CC-4310') })
    expect(r1.replayedBills).toBe(1)
    const [row] = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM actual_spend WHERE tool='claude-code'`
    expect(row!.cost).toBe('12.500000')
    // second run is idempotent — no duplicate actual_spend, no re-replay
    const r2 = await provisionAndPlace('owed@example.com', { store, lookupDirectory: async (e) => dir(e, 'CC-4310') })
    expect(r2.replayedBills).toBe(0)
    const [{ cnt }] = await t.client<{ cnt: string }[]>`SELECT count(*)::text AS cnt FROM actual_spend WHERE tool='claude-code'`
    expect(cnt).toBe('1')
  })
})

describe('bind-or-adopt sign-in (H2)', () => {
  it('a bill teammate, then that user logs in → ONE teammate (oid adopted), no 500', async () => {
    const store = makePlacementStore(t.db)
    await store.createBillTeammate({ email: 'join@example.com', displayName: null, orgUnitId: apacOrgUnit })
    const r = await resolveOrCreateTeammate(t.db, { oid: 'oid-real-1', email: 'join@example.com', name: 'Joiner' })
    expect(r.created).toBe(false) // adopted, not created
    const [{ cnt }] = await t.client<{ cnt: string }[]>`SELECT count(*)::text AS cnt FROM teammate WHERE lower(email)='join@example.com'`
    expect(cnt).toBe('1') // no duplicate
    const [tm] = await t.client<{ oid: string; src: string }[]>`SELECT entra_oid AS oid, source AS src FROM teammate WHERE lower(email)='join@example.com'`
    expect(tm!.oid).toBe('oid-real-1') // placeholder adopted
    expect(tm!.src).toBe('entra')
  })

  it('a brand-new login (no bill row) creates normally', async () => {
    const r = await resolveOrCreateTeammate(t.db, { oid: 'oid-real-2', email: 'fresh@example.com', name: 'Fresh' })
    expect(r.created).toBe(true)
  })

  it('email already owned by a different REAL oid → explicit error, not a raw 500', async () => {
    await resolveOrCreateTeammate(t.db, { oid: 'oid-real-3', email: 'dupe@example.com', name: 'A' })
    await expect(
      resolveOrCreateTeammate(t.db, { oid: 'oid-real-4', email: 'dupe@example.com', name: 'B' }),
    ).rejects.toThrow(/already owned by another identity/)
    // M4: the collision must leave an audit signal so an admin sees the cause — the
    // caller otherwise swallows the throw into a silent 401 loop. subject_id points at
    // the colliding real teammate; payload carries the rejected oid + email.
    const audit = await t.client<{ subject_id: string | null; payload: Record<string, unknown> }[]>`
      SELECT subject_id::text AS subject_id, payload
      FROM audit_event
      WHERE event_type = 'teammate-bind-collision' AND payload->>'email' = 'dupe@example.com'`
    expect(audit.length).toBe(1)
    expect(audit[0]!.payload.oid).toBe('oid-real-4')
    const [owner] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-real-3'`
    expect(audit[0]!.subject_id).toBe(owner!.id)
  })

  it('email recycled to a new oid in a DIFFERENT CASE → still the explicit guard, no case-variant duplicate (mig 0067)', async () => {
    // The exact-case unique index (mig 0057) let `First.Last@` and `first.last@` occupy
    // distinct slots, so a case-differing recycle bypassed the guard and minted a dup.
    // mig 0067 makes the index lower(email), so the lower-collision raises 23505 and the
    // guard fires.
    await resolveOrCreateTeammate(t.db, { oid: 'oid-recycle-1', email: 'Case.Recycle@example.com', name: 'A' })
    await expect(
      resolveOrCreateTeammate(t.db, { oid: 'oid-recycle-2', email: 'case.recycle@example.com', name: 'B' }),
    ).rejects.toThrow(/already owned by another identity/)
    const [{ cnt }] = await t.client<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt FROM teammate WHERE lower(email) = 'case.recycle@example.com'`
    expect(cnt).toBe('1') // exactly one real teammate, no case-variant duplicate
  })
})

describe('runPlacementSync (drain worker, end-to-end)', () => {
  it('drains the queue: provisions, places by cost centre, replays into actual_spend; idempotent', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'queued@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 7.25, inputTokens: 80, outputTokens: 20 })
    const r = await runPlacementSync(t.db, { lookupDirectory: async (e) => dir(e, 'CC-4310') })
    expect(r).toMatchObject({ emailsConsidered: 1, provisioned: 1, placed: 1, errors: 0 })
    const [tm] = await t.client<{ ou: string; region_code: string }[]>`
      SELECT tm.org_unit_id::text AS ou, r.code AS region_code
      FROM teammate tm JOIN region r ON r.id=tm.region_id WHERE lower(tm.email)='queued@example.com'`
    expect(tm!.ou).toBe(apacOrgUnit)
    expect(tm!.region_code).toBe('apac')
    const [row] = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM actual_spend WHERE tool='claude-code'`
    expect(row!.cost).toBe('7.250000') // owed bill replayed
    // queue marked placed → a re-run drains nothing
    const r2 = await runPlacementSync(t.db, { lookupDirectory: async (e) => dir(e, 'CC-4310') })
    expect(r2.emailsConsidered).toBe(0)
  })

  it('email not in the directory → provisioned but unplaced (rolls to unassigned region)', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'nodir@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 1 })
    const r = await runPlacementSync(t.db, { lookupDirectory: async () => null })
    expect(r).toMatchObject({ provisioned: 1, placed: 0 })
    const [tm] = await t.client<{ region_code: string }[]>`
      SELECT r.code AS region_code FROM teammate tm JOIN region r ON r.id=tm.region_id WHERE lower(tm.email)='nodir@example.com'`
    expect(tm!.region_code).toBe('__unassigned__')
  })
})

describe('region derivation (mig 0068) — department + manager-chain → per-region __UNPLACED__', () => {
  let emeaId = ''
  beforeAll(async () => {
    await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'emea', 'EMEA') ON CONFLICT (code) DO NOTHING`
    const [rg] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='emea'`
    emeaId = rg!.id
    await t.client`INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id)
      VALUES ('department', 'exact', 'emea data & ai', 'EMEA Data & AI', ${emeaId}) ON CONFLICT DO NOTHING`
    await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email, kind)
      VALUES (${emeaId}, 'boss-oid', 'boss@example.com', 'region-svp')`
  })

  const enrich = (department: string | null, costCenter: string | null, oid: string) =>
    async (email: string): Promise<DirectoryUser> => ({
      oid, email, displayName: 'Dir', department, jobTitle: null, costCenter, division: null,
    })

  const regionOf = async (email: string) => {
    const [tm] = await t.client<{ region_code: string; ou_code: string }[]>`
      SELECT r.code AS region_code, ou.code AS ou_code
      FROM teammate t JOIN org_unit ou ON ou.id=t.org_unit_id JOIN region r ON r.id=t.region_id
      WHERE lower(t.email)=${email}`
    return tm!
  }

  it('DEPARTMENT maps → homed to that region __UNPLACED__ (no manager call needed)', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'deptuser@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 3 })
    const r = await runPlacementSync(t.db, {
      lookupDirectory: enrich('EMEA Data & AI', 'CC-NONE', 'deptuser-oid'),
      getManager: async () => { throw new Error('manager walk must not run when department maps') },
    })
    expect(r.viaAttribute).toBe(1)
    const tm = await regionOf('deptuser@example.com')
    expect(tm.region_code).toBe('emea')
    expect(tm.ou_code).toBe('__UNPLACED__')
  })

  it('no department but MANAGER chain hits a leader → that region, via manager', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'mgruser@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 2 })
    const r = await runPlacementSync(t.db, {
      lookupDirectory: enrich(null, 'CC-NONE', 'mgruser-oid'),
      getManager: async (oid) => (oid === 'mgruser-oid' ? { oid: 'boss-oid', email: 'boss@example.com' } : null),
    })
    expect(r.viaManager).toBe(1)
    expect((await regionOf('mgruser@example.com')).region_code).toBe('emea')
  })

  it('neither signal resolves → GLOBAL __unassigned__ fallback', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'nosignal@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 1 })
    const r = await runPlacementSync(t.db, {
      lookupDirectory: enrich(null, 'CC-NONE', 'nosignal-oid'),
      getManager: async () => null,
    })
    expect(r.fellToGlobal).toBe(1)
    expect((await regionOf('nosignal@example.com')).region_code).toBe('__unassigned__')
  })

  it('cost-centre match still WINS over derivation (department ignored)', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'ccuser@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 5 })
    const r = await runPlacementSync(t.db, {
      lookupDirectory: enrich('EMEA Data & AI', 'CC-4310', 'ccuser-oid'), // CC-4310 matches apac-digital
      getManager: async () => null,
    })
    expect(r.viaCostCentre).toBe(1)
    expect((await regionOf('ccuser@example.com')).region_code).toBe('apac') // cost centre wins, not EMEA dept
  })
})

describe('manager-chain UNIT (practice) placement — cou_owner is the manager→unit map', () => {
  // apac-digital (apacOrgUnit) is a cost-owning unit (CC-4310). Make a real-oid owner of it.
  beforeAll(async () => {
    const [rg] = await t.client<{ id: string }[]>`SELECT region_id::text AS id FROM org_unit WHERE id=${apacOrgUnit}::uuid`
    await t.client`INSERT INTO teammate (entra_oid, email, region_id, org_unit_id, source)
      VALUES ('owner-oid-real', 'practice.owner@example.com', ${rg!.id}::uuid, ${apacOrgUnit}::uuid, 'manual')`
    const [own] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE lower(email)='practice.owner@example.com'`
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${apacOrgUnit}::uuid, ${own!.id}::uuid)`
    // A BILL-placeholder owner of the same unit (must be excluded as a magnet).
    await t.client`INSERT INTO teammate (entra_oid, email, region_id, org_unit_id, source)
      VALUES ('bill:'||gen_random_uuid(), 'bill.owner@example.com', ${rg!.id}::uuid, ${apacOrgUnit}::uuid, 'bill')`
  })

  const enrich = (oid: string) => async (email: string): Promise<DirectoryUser> => ({
    oid, email, displayName: 'Report', department: 'Services', jobTitle: null, costCenter: 'CC-NONE', division: null,
  })
  const homeOf = async (email: string) => {
    const [tm] = await t.client<{ ou_code: string; cou: boolean; via: string | null }[]>`
      SELECT ou.code AS ou_code, ou.is_cost_owning_unit AS cou, t.metadata->>'placedVia' AS via
      FROM teammate t JOIN org_unit ou ON ou.id=t.org_unit_id WHERE lower(t.email)=${email}`
    return tm!
  }

  it('a report whose chain hits a real-oid unit-owner → placed in the OWNED cost-owning unit, provenance stamped', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'report1@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 4 })
    const r = await runPlacementSync(t.db, {
      lookupDirectory: enrich('report1-oid'),
      getManager: async (oid) => (oid === 'report1-oid' ? { oid: 'owner-oid-real', email: 'practice.owner@example.com' } : null),
    })
    expect(r.viaUnit).toBe(1)
    const tm = await homeOf('report1@example.com')
    expect(tm.ou_code).toBe('apac-digital') // the OWNED cost-owning unit, not __UNPLACED__
    expect(tm.cou).toBe(true)
    expect(tm.via).toBe('manager-chain') // provenance for re-enrichment
  })

  it('a bill-placeholder owner is NOT a magnet → report chaining only to it falls to global', async () => {
    await enqueueOwedBill(t.db, { provider: 'anthropic', actualSource: 'anthropic-analytics-api:o1', email: 'report2@example.com', tool: 'claude-code', date: '2026-06-12', costUsd: 1 })
    // report2 → the bill: owner (real-oid 'bill-owner-oid' is NOT in the directory chain; the
    // owner teammate's entra_oid is 'bill:...', excluded by loadActiveUnitOwners).
    const [billOwner] = await t.client<{ oid: string }[]>`SELECT entra_oid AS oid FROM teammate WHERE lower(email)='bill.owner@example.com'`
    const r = await runPlacementSync(t.db, {
      lookupDirectory: enrich('report2-oid'),
      getManager: async (oid) => (oid === 'report2-oid' ? { oid: billOwner!.oid, email: 'bill.owner@example.com' } : null),
    })
    expect(r.viaUnit).toBe(0)
    expect((await homeOf('report2@example.com')).ou_code).toBe('__UNPLACED__') // global fallback, not the unit
  })
})
