// @vitest-environment node
/*
 * privileged-identity-cleanup worker — applies the directory-exclusion policy
 * (mig 0083) retroactively. REPORT by default; destructive apply is gated,
 * capped, and only touches provably-inert developer rows with no standing.
 *
 * Mock directory: dir-oid-0007-cld (upn rtanaka-cld@contoso.onmicrosoft.com)
 * and dir-oid-0008 (upn kwong@contoso.onmicrosoft.com) are onmicrosoft
 * accounts; dir-oid-0001 (sasha.kumar@example.com) is a standard account.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runPrivilegedIdentityCleanup } from '../../../server/workers/privileged-identity-cleanup'
import { _resetGraphTokenCache, getDirectoryUserByOidStrict } from '../../../server/azure/directory'

let t: TestDb
let regionId = ''
let unitId = ''

const PATTERN = '*@contoso.onmicrosoft.com'

async function seedPattern(pattern = PATTERN) {
  await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES (${pattern})`
}

async function seed(oid: string, opts?: { role?: string; email?: string }): Promise<string> {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
    VALUES (${oid}, ${opts?.email ?? oid + '@x.test'}, 'Seed', ${regionId}::uuid, ${unitId}::uuid, ${opts?.role ?? 'developer'}, 'directory')
    RETURNING id::text AS id`
  return r!.id
}

const oidActive = async (id: string) =>
  (await t.client<{ is_active: boolean }[]>`SELECT is_active FROM teammate WHERE id = ${id}::uuid`)[0]!.is_active

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb()
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pc', 'PC') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${regionId}::uuid, NULL, 'pc'::ltree, 'default', 'PC', 'bu', true) RETURNING id::text AS id`
  unitId = u!.id
  // Padding: a realistic active population (source='manual' survives beforeEach;
  // entra_oid resolves to null in the mock → never excluded, just counted) so a
  // single candidate is a small fraction and the proportion cap doesn't fire.
  for (let i = 0; i < 15; i++) {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES (${'pad-' + i}, ${'pad' + i + '@x.test'}, 'Pad', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'manual')`
  }
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM cou_owner`
  await t.client`DELETE FROM region_leader`
  await t.client`DELETE FROM project_assignment`
  await t.client`DELETE FROM teammate WHERE source = 'directory'`
  await t.client`DELETE FROM directory_exclusion_pattern`
  await t.client`DELETE FROM kv_store WHERE mount = 'privileged-identity-cleanup'`
})

describe('privileged-identity-cleanup worker (#121)', () => {
  it('FAIL-OPEN: no patterns → does nothing, considers nothing', async () => {
    await seed('dir-oid-0007-cld')
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.considered).toBe(0)
    expect(res.cleaned).toBe(0)
  })

  it('REPORT mode (default): counts an excluded inert developer as a candidate, mutates NOTHING', async () => {
    const id = await seed('dir-oid-0007-cld')
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db)
    expect(res.mode).toBe('report')
    expect(res.excluded).toBe(1)
    expect(res.candidates).toBe(1)
    expect(res.cleaned).toBe(0)
    expect(await oidActive(id)).toBe(true) // untouched
  })

  it('APPLY: deactivates an inert excluded developer + closes their (member) assignment', async () => {
    const id = await seed('dir-oid-0007-cld')
    await seedPattern()
    // An open plain-MEMBER assignment is inert attribution → safe to close.
    const [proj] = await t.client<{ id: string }[]>`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id) VALUES ('P1', 'h-p1', 'P1', 'billable', ${regionId}::uuid, ${unitId}::uuid) RETURNING id::text AS id`
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role) VALUES (${proj!.id}::uuid, ${id}::uuid, tstzrange(now(), NULL), 'member')`
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.cleaned).toBe(1)
    expect(await oidActive(id)).toBe(false)
    const [asg] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM project_assignment WHERE teammate_id = ${id}::uuid AND upper_inf(effective)`
    expect(asg!.n).toBe('0') // closed
  })

  it('does NOT touch a standard (non-excluded) account', async () => {
    const id = await seed('dir-oid-0001')
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.excluded).toBe(0)
    expect(await oidActive(id)).toBe(true)
  })

  it('FLAGS (never deactivates) an excluded row with an elevated role', async () => {
    const id = await seed('dir-oid-0007-cld', { role: 'admin' })
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.excluded).toBe(1)
    expect(res.flagged).toBe(1)
    expect(res.candidates).toBe(0)
    expect(await oidActive(id)).toBe(true)
  })

  it('FLAGS (never deactivates) an excluded developer who ACTIVELY OWNS a cost centre', async () => {
    // Rob's shape: the CLD row owns Cyber Security. Removing an owner leaves a
    // P&L gap a human must fill, so it is flagged, not silently de-owned.
    const id = await seed('dir-oid-0007-cld')
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${unitId}::uuid, ${id}::uuid)`
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.flagged).toBe(1)
    expect(res.candidates).toBe(0)
    expect(await oidActive(id)).toBe(true)
    const [own] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM cou_owner WHERE teammate_id = ${id}::uuid AND revoked_at IS NULL`
    expect(own!.n).toBe('1') // ownership untouched
  })

  it('FLAGS (never deactivates) an excluded row that is a region_leader', async () => {
    const id = await seed('dir-oid-0007-cld')
    await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email) VALUES (${regionId}::uuid, 'dir-oid-0007-cld', 'x@x.test')`
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    expect(res.flagged).toBe(1)
    expect(await oidActive(id)).toBe(true)
  })

  /*
   * The run deadline. A fake clock: every directory lookup costs 100 s of the
   * 150 s budget, so a run finishes two rows and stops before the third.
   */
  const slowLookup = (seen: string[], clock: { t: number }, costMs = 100_000) => async (oid: string) => {
    seen.push(oid)
    clock.t += costMs
    return getDirectoryUserByOidStrict(oid) // the mock directory
  }

  it('DEADLINE (report): a stopped run resumes after the last row it finished; successive runs reach every row once, then wrap', async () => {
    await seed('dir-oid-0007-cld')
    await seed('dir-oid-0008')
    await seedPattern()
    const population = (await t.client<{ entra_oid: string }[]>`
      SELECT entra_oid FROM teammate WHERE is_active AND NOT provisional
        AND entra_oid NOT LIKE 'bill:%' AND entra_oid NOT LIKE 'provisional:%'`).map((r) => r.entra_oid)

    const clock = { t: 0 }
    const seen: string[] = []
    const first = await runPrivilegedIdentityCleanup(t.db, { now: () => clock.t, lookupByOid: slowLookup(seen, clock) })
    expect(first.deadlineHit).toBe(true)
    expect(first.considered).toBe(2)

    let runs = 1
    let last = first
    while (last.deadlineHit && runs < population.length + 2) {
      last = await runPrivilegedIdentityCleanup(t.db, { now: () => clock.t, lookupByOid: slowLookup(seen, clock) })
      runs++
    }
    expect(last.deadlineHit).toBe(false)
    // Every row examined exactly once across the passes — none skipped, none repeated.
    expect([...seen].sort()).toEqual([...population].sort())
    // Reached the end → cursor cleared → the next run starts from the first row again.
    const cursor = await t.client`SELECT 1 FROM kv_store WHERE mount = 'privileged-identity-cleanup'`
    expect(cursor).toHaveLength(0)
  })

  it('DEADLINE (apply): a scan cut short ABORTS — no candidate found so far is deactivated, and no cursor is kept', async () => {
    const ids = [await seed('dir-oid-0007-cld'), await seed('dir-oid-0008')]
    await seedPattern()
    const clock = { t: 0 }
    const seen: string[] = []
    // 1 ms per lookup against a budget one short of the population: the scan
    // examines every row but the last, so any candidate it found was found
    // BEFORE the stop.
    const [{ n }] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM teammate WHERE is_active AND NOT provisional`
    const res = await runPrivilegedIdentityCleanup(t.db, {
      apply: true,
      cap: { maxAbs: 100, maxPct: 1 },
      now: () => clock.t,
      budgetMs: n - 1,
      lookupByOid: slowLookup(seen, clock, 1),
    })
    expect(res.deadlineHit).toBe(true)
    expect(res.aborted).toBe(true)
    expect(res.cleaned).toBe(0)
    for (const id of ids) expect(await oidActive(id)).toBe(true)
    const [audit] = await t.client<{ reason: string }[]>`
      SELECT payload->>'reason' AS reason FROM audit_event
      WHERE event_type = 'privileged-identity-cleanup-aborted' ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit!.reason).toBe('incomplete-scan')
    expect(await t.client`SELECT 1 FROM kv_store WHERE mount = 'privileged-identity-cleanup'`).toHaveLength(0)
  })

  it('CAP: aborts (mutates nothing) when candidates exceed the absolute cap', async () => {
    const ids = [await seed('dir-oid-0007-cld'), await seed('dir-oid-0008')]
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true, cap: { maxAbs: 1, maxPct: 1 } })
    expect(res.candidates).toBe(2)
    expect(res.aborted).toBe(true)
    expect(res.cleaned).toBe(0)
    for (const id of ids) expect(await oidActive(id)).toBe(true)
  })

  it('CAP: aborts on PROPORTION even when the absolute count is small (no dead zone)', async () => {
    // 2 candidates but a low maxPct → proportion trigger fires regardless of the
    // small absolute count (the PCT_FLOOR dead-zone this replaced).
    await seed('dir-oid-0007-cld')
    await seed('dir-oid-0008')
    await seedPattern()
    const res = await runPrivilegedIdentityCleanup(t.db, { apply: true, cap: { maxAbs: 100, maxPct: 0.01 } })
    expect(res.aborted).toBe(true)
    expect(res.cleaned).toBe(0)
  })

  /*
   * The DEFAULT wiring in real-Graph mode behind a stubbed fetch. A Graph failure
   * is an ERROR for that row — never "not in the directory", and never a step
   * toward deactivation — while the rest of the run (including a real candidate)
   * proceeds. Before the strict lookup a throttled row was silently read as "not
   * excluded" and not counted at all.
   */
  it('APPLY: a Graph failure on any row makes the scan partial — the run ABORTS and deactivates nobody', async () => {
    const throttled = await seed('oid-throttled')
    const cld = await seed('oid-cld')
    await seedPattern()
    const env = {
      NUXT_GRAPH_DIRECTORY_MODE: 'graph',
      NUXT_GRAPH_BASE_URL: 'https://graph.example.test/v1.0',
      NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID: 'cid',
      NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET: 'secret',
      NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL: 'https://login.example.test/token',
    }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    _resetGraphTokenCache()
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input)
      if (url.startsWith(env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL)) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('/users/oid-throttled')) return new Response(null, { status: 503, headers: { 'retry-after': '0' } })
      if (url.includes('/users/oid-cld')) {
        return new Response(JSON.stringify({
          id: 'oid-cld', displayName: 'CLD', mail: null, userPrincipalName: 'x-cld@contoso.onmicrosoft.com',
          department: null, jobTitle: null, companyName: null, country: null, officeLocation: null, state: null,
        }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    })
    let res
    try {
      res = await runPrivilegedIdentityCleanup(t.db, { apply: true })
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs() // back to the mock directory
      _resetGraphTokenCache()
    }
    expect(res.errors).toBe(1)
    expect(res.aborted).toBe(true)
    expect(res.cleaned).toBe(0)
    expect(await oidActive(throttled)).toBe(true)
    // The visible candidate is NOT acted on: the cap cannot be judged on part of the population.
    expect(await oidActive(cld)).toBe(true)
    const [audit] = await t.client<{ reason: string }[]>`
      SELECT payload->>'reason' AS reason FROM audit_event
      WHERE event_type = 'privileged-identity-cleanup-aborted' AND payload ? 'scanErrors'`
    expect(audit?.reason).toBe('incomplete-scan')
  })

  it('REPORT: a scan that reaches its limit exactly at a page boundary keeps its cursor (the rows past it are examined next run)', async () => {
    await seedPattern()
    // 15 padding rows exist; add enough directory rows that a 500-row limit ends
    // exactly on the first page's last row with more rows behind it.
    await t.client`
      INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      SELECT 'pb-' || g, 'pb' || g || '@x.test', 'Pb', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'directory'
      FROM generate_series(1, 500) g`
    const first = await runPrivilegedIdentityCleanup(t.db, { limit: 500, lookupByOid: async () => null })
    expect(first.considered).toBe(500)
    expect(first.saturated).toBe(true)
    const [cur] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM kv_store WHERE mount = 'privileged-identity-cleanup'`
    expect(cur?.n).toBe('1')
    const second = await runPrivilegedIdentityCleanup(t.db, { limit: 500, lookupByOid: async () => null })
    expect(second.considered).toBe(15)
  })
})
