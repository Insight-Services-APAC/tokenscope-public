/*
 * The RLS capability probe, measured against real Postgres from BOTH sides.
 *
 * A probe that reports "this connection can create roles" no matter who asks is
 * worthless — it would certify the very assumption it exists to replace. So
 * every verdict here is asserted twice: once as the owner/superuser (what
 * production connects as today) and once as a GENUINE NON-OWNER login role
 * created in the test, following the shape of rls-bootstrap-set.test.ts.
 *
 * The sharpest case is the one the design doc got wrong in four separate
 * sections: `ENABLE ROW LEVEL SECURITY` binds a NON-OWNER on its own, and
 * `FORCE` is what additionally binds the OWNER. `policiesApply` encodes that,
 * and the "ENABLE vs FORCE" suite below drives a real table through all four
 * (owner × forced) combinations rather than restating the rule.
 *
 * Nothing here writes to the app schema. The probe itself is read-only; the DDL
 * in these tests exists only to manufacture the roles and postures the probe is
 * asked to describe, and each case drops what it created.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  probeRlsPosture,
  reportRlsPostureAtBoot,
  RLS_APP_ROLE,
  AZURE_PG_ADMIN_ROLE,
  type RlsPostureReport,
} from '../../../scripts/preflight-rls'
import { RLS_BOOTSTRAP_TABLE_NAMES } from '../../../server/db/rls-bootstrap'

let t: TestDb
/** Per-run suffix: role names are CLUSTER-wide, and TEST_PG_URL shares one. */
const sfx = randomUUID().replace(/-/g, '').slice(0, 10)
const NON_OWNER = `probe_plain_${sfx}`
const OWNER_ROLE = `probe_owner_${sfx}`
const APP_ROLE = `probe_app_${sfx}`
const GROUP_ROLE = `probe_group_${sfx}`
const OWNED_TABLE = `probe_owned_${sfx}`
const PASSWORD = 'probe-pw'

/** Open a client as `role`, run the probe, close it. */
async function probeAs(
  role: string,
  options?: Parameters<typeof probeRlsPosture>[1],
): Promise<RlsPostureReport> {
  const url = new URL(t.url)
  url.username = role
  url.password = PASSWORD
  const client = postgres(url.toString(), {
    max: 1,
    idle_timeout: 5,
    connection: { TimeZone: 'UTC' },
  })
  try {
    return await probeRlsPosture(drizzle(client), options)
  } finally {
    await client.end({ timeout: 5 })
  }
}

const bootstrapOpts = { bootstrapTables: RLS_BOOTSTRAP_TABLE_NAMES }

beforeAll(async () => {
  t = await startTestDb()
  // A plain non-owner login: no CREATEROLE, no grants, owns nothing. This is
  // the role every "does it distinguish?" assertion is measured against.
  await t.client.unsafe(`CREATE USER ${NON_OWNER} WITH LOGIN PASSWORD '${PASSWORD}'`)
}, 180_000)

afterAll(async () => {
  await t?.client.unsafe(`DROP USER IF EXISTS ${NON_OWNER}`).catch(() => undefined)
  await stopTestDb(t)
})

describe('as the table OWNER + superuser — what production connects as today', () => {
  it('reports the owner lane, and that NOT ONE policy executes', async () => {
    const r = await probeRlsPosture(t.db, bootstrapOpts)

    expect(r.connection.lane).toBe('owner')
    expect(r.connection.ownedTables).toBeGreaterThan(0)
    expect(r.connection.bypass.owner).toBe(true)
    expect(r.capability.isSuperuser).toBe(true)

    // The design doc's opening claim, measured rather than quoted: policies
    // exist in quantity and none of them filter this connection.
    expect(r.summary.rlsEnabled).toBeGreaterThan(0)
    expect(r.summary.policies).toBeGreaterThan(0)
    expect(r.summary.policiesApply).toBe(0)
    expect(r.tables.every((tbl) => tbl.policiesApply === false)).toBe(true)
  })

  /*
   * THE PARTITIONED PARENT MUST BE IN THE REPORT.
   *
   * `attribution_record` is `relkind = 'p'`, and both of this probe's queries
   * filtered `relkind = 'r'` — so the money ledger, RLS-enabled and carrying
   * two policies, was absent from the table list, from `rlsEnabled`, from the
   * policy count and from grant coverage. The probe said 22 tables while the
   * estate has 23 and the design doc says 23; nothing compared them.
   *
   * It is measured against the catalog rather than asserted as a name, so the
   * test cannot pass by agreeing with the same mistake twice.
   */
  it('includes the PARTITIONED parent — the ledger is relkind=p, not r', async () => {
    const r = await probeRlsPosture(t.db, bootstrapOpts)

    const [catalog] = await t.client<{ n: number; kind: string }[]>`
      SELECT count(*)::int AS n, max(c.relkind::text) AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'attribution_record'
    `
    expect(catalog?.n, 'the fixture must actually have the ledger').toBe(1)
    expect(catalog?.kind, 'and it must really be partitioned, or this proves nothing').toBe('p')

    const ledger = r.tables.find((tbl) => tbl.table === 'attribution_record')
    expect(ledger, 'the probe must not silently drop a partitioned table').toBeDefined()
    expect(ledger!.rlsEnabled).toBe(true)
    expect(ledger!.policyCount, 'and must count its policies').toBeGreaterThan(0)

    // Every RLS-enabled relation in the catalog, of either kind, is reported.
    const [expected] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
    `
    expect(r.summary.rlsEnabled, 'the summary must match the catalog, not a subset of it').toBe(expected!.n)
  })

  it('can provision the app role, and says on what basis', async () => {
    const r = await probeRlsPosture(t.db, bootstrapOpts)
    expect(r.capability.canProvisionRole).toBe(true)
    expect(r.capability.provisionBasis).toBe('superuser')
    expect(r.capability.currentUser).toBe(r.capability.sessionUser)
  })

  it('reports the app role ABSENT — the state this branch exists to change', async () => {
    const r = await probeRlsPosture(t.db, bootstrapOpts)
    expect(r.appRole.roleName).toBe(RLS_APP_ROLE)
    expect(r.appRole.exists).toBe(false)
    expect(r.appRole.canLogin).toBeNull()
    // null, not a zeroed grants object: "not created" and "created with nothing
    // granted" are different answers and must not render the same.
    expect(r.appRole.grants).toBeNull()
    expect(r.line).toContain(`app-role '${RLS_APP_ROLE}' absent`)
  })

  it('highlights the bootstrap set, and reports it still enabled', async () => {
    const r = await probeRlsPosture(t.db, bootstrapOpts)
    const flagged = r.tables
      .filter((tbl) => tbl.bootstrap)
      .map((tbl) => tbl.table)
      .sort()
    expect(flagged).toEqual([...RLS_BOOTSTRAP_TABLE_NAMES].sort())
    // Every bootstrap table ships with RLS ENABLEd, which is exactly why the
    // runbook's step 0 is a DISABLE sweep — the probe must show that state.
    expect(r.summary.bootstrapStillEnabled.sort()).toEqual([...RLS_BOOTSTRAP_TABLE_NAMES].sort())
  })

  it('does not flag bootstrap tables when the caller supplies no set (the boot path)', async () => {
    const r = await probeRlsPosture(t.db)
    expect(r.tables.some((tbl) => tbl.bootstrap)).toBe(false)
    expect(r.summary.bootstrapStillEnabled).toEqual([])
  })
})

describe('as a GENUINE NON-OWNER — the role the app is to switch to', () => {
  it('is a real non-owner: not the owner, not a superuser', async () => {
    const r = await probeAs(NON_OWNER, bootstrapOpts)
    expect(r.capability.currentUser).toBe(NON_OWNER)
    expect(r.capability.isSuperuser).toBe(false)
    expect(r.connection.ownedTables).toBe(0)
    expect(r.connection.bypass).toEqual({ superuser: false, bypassRls: false, owner: false })
  })

  it('reports EVERY rls-enabled table as enforced — no FORCE required', async () => {
    const r = await probeAs(NON_OWNER, bootstrapOpts)
    // The distinction the whole story turns on. Same database, same tables, same
    // zero FORCEd tables as the owner case above — different connection, and
    // suddenly every policy runs.
    expect(r.summary.rlsForced).toBe(0)
    expect(r.summary.rlsEnabled).toBeGreaterThan(0)
    expect(r.summary.policiesApply).toBe(r.summary.rlsEnabled)
  })

  it('CANNOT provision the app role — the verdict is not a constant', async () => {
    const r = await probeAs(NON_OWNER, bootstrapOpts)
    expect(r.capability.canProvisionRole).toBe(false)
    expect(r.capability.provisionBasis).toBe('none')
    expect(r.capability.createRoleViaSetRole).toEqual([])
    expect(r.line).toContain('can-create-role=no')
  })

  it("lane is 'other' when the connection is neither owner nor the named app role", async () => {
    const r = await probeAs(NON_OWNER, bootstrapOpts)
    expect(r.connection.lane).toBe('other')
  })
})

describe('the can-provision verdict tracks the real privilege', () => {
  it('flips to yes when CREATEROLE is granted directly, and back when revoked', async () => {
    await t.client.unsafe(`ALTER ROLE ${NON_OWNER} CREATEROLE`)
    try {
      const granted = await probeAs(NON_OWNER)
      expect(granted.capability.canCreateRole).toBe(true)
      expect(granted.capability.provisionBasis).toBe('createrole')
      expect(granted.capability.canProvisionRole).toBe(true)
    } finally {
      await t.client.unsafe(`ALTER ROLE ${NON_OWNER} NOCREATEROLE`)
    }
    const revoked = await probeAs(NON_OWNER)
    expect(revoked.capability.canProvisionRole).toBe(false)
  })

  it('sees CREATEROLE reachable only through SET ROLE — the azure_pg_admin shape', async () => {
    // Role ATTRIBUTES are not inherited: membership of a CREATEROLE role confers
    // it only after SET ROLE. A verdict read off `rolcreaterole` alone would say
    // "no" here and send the org looking for a DBA it does not have.
    await t.client.unsafe(`
      CREATE ROLE ${GROUP_ROLE} NOLOGIN CREATEROLE;
      GRANT ${GROUP_ROLE} TO ${NON_OWNER};
    `)
    try {
      const r = await probeAs(NON_OWNER)
      expect(r.capability.canCreateRole, 'the attribute itself is still off').toBe(false)
      expect(r.capability.createRoleViaSetRole).toContain(GROUP_ROLE)
      expect(r.capability.provisionBasis).toBe('set-role')
      expect(r.capability.canProvisionRole).toBe(true)
      expect(r.line).toContain(`set-role ${GROUP_ROLE}`)
    } finally {
      await t.client.unsafe(`REVOKE ${GROUP_ROLE} FROM ${NON_OWNER}; DROP ROLE ${GROUP_ROLE};`)
    }
    const after = await probeAs(NON_OWNER)
    expect(after.capability.createRoleViaSetRole).not.toContain(GROUP_ROLE)
  })

  /*
   * `WITH SET FALSE` — PG 16's new grant option, and the case that made
   * `pg_has_role(…, 'MEMBER')` the wrong predicate.
   *
   * A membership granted WITH SET FALSE still reports as MEMBER, so a probe
   * asking that question says "provision-capable" while the server refuses the
   * transition — on the exact instance (an Azure admin whose CREATEROLE comes
   * from azure_pg_admin) this whole change is built for. The case below asserts
   * BOTH halves in one place: the server really does refuse `SET ROLE`, and the
   * probe really does say no. Without the second half the first is a test of
   * Postgres; without the first the second could be green for the wrong reason.
   *
   * `'USAGE'` is not the answer either, and the third assertion pins why: it
   * reports on INHERITANCE, and role ATTRIBUTES are never inherited — a member
   * with INHERIT TRUE still cannot CREATE ROLE without SET ROLE.
   */
  it('a WITH SET FALSE membership reports MEMBER but is NOT provision-capable', async () => {
    await t.client.unsafe(`
      CREATE ROLE ${GROUP_ROLE} NOLOGIN CREATEROLE;
      GRANT ${GROUP_ROLE} TO ${NON_OWNER} WITH SET FALSE;
    `)
    try {
      // 1. The catalog still calls it a membership…
      const [flags] = await t.client<{ member: boolean; setpriv: boolean; setopt: boolean }[]>`
        SELECT pg_has_role(${NON_OWNER}::name, ${GROUP_ROLE}::name, 'MEMBER') AS member,
               pg_has_role(${NON_OWNER}::name, ${GROUP_ROLE}::name, 'SET')    AS setpriv,
               (SELECT m.set_option FROM pg_auth_members m
                  JOIN pg_roles g ON g.oid = m.roleid
                  JOIN pg_roles u ON u.oid = m.member
                 WHERE g.rolname = ${GROUP_ROLE} AND u.rolname = ${NON_OWNER}) AS setopt
      `
      expect(flags!.member, 'MEMBER is true — which is exactly the trap').toBe(true)
      expect(flags!.setpriv).toBe(false)
      expect(flags!.setopt).toBe(false)

      // 2. …and the server refuses the transition the probe would be promising.
      const url = new URL(t.url)
      url.username = NON_OWNER
      url.password = PASSWORD
      const client = postgres(url.toString(), { max: 1, idle_timeout: 5 })
      try {
        await expect(client.unsafe(`SET ROLE ${GROUP_ROLE}`)).rejects.toThrow(/permission denied to set role/)
      } finally {
        await client.end({ timeout: 5 })
      }

      // 3. So the verdict must be NO.
      const r = await probeAs(NON_OWNER)
      expect(r.capability.createRoleViaSetRole).not.toContain(GROUP_ROLE)
      expect(r.capability.provisionBasis).toBe('none')
      expect(r.capability.canProvisionRole).toBe(false)
      expect(r.line).toContain('can-create-role=no')
    } finally {
      await t.client.unsafe(`REVOKE ${GROUP_ROLE} FROM ${NON_OWNER}; DROP ROLE ${GROUP_ROLE};`)
    }
  })

  it("INHERIT does not make CREATEROLE usable — so 'USAGE' is the wrong predicate too", async () => {
    await t.client.unsafe(`
      CREATE ROLE ${GROUP_ROLE} NOLOGIN CREATEROLE;
      GRANT ${GROUP_ROLE} TO ${NON_OWNER} WITH INHERIT TRUE, SET FALSE;
    `)
    try {
      const [flags] = await t.client<{ usage: boolean; setpriv: boolean }[]>`
        SELECT pg_has_role(${NON_OWNER}::name, ${GROUP_ROLE}::name, 'USAGE') AS usage,
               pg_has_role(${NON_OWNER}::name, ${GROUP_ROLE}::name, 'SET')   AS setpriv
      `
      // USAGE says yes, SET says no — a verdict built on USAGE would be wrong
      // here, and wrong the other way for the plain NOINHERIT grant above.
      expect(flags!.usage).toBe(true)
      expect(flags!.setpriv).toBe(false)

      const url = new URL(t.url)
      url.username = NON_OWNER
      url.password = PASSWORD
      const client = postgres(url.toString(), { max: 1, idle_timeout: 5 })
      try {
        await expect(client.unsafe(`CREATE ROLE ${GROUP_ROLE}_child NOLOGIN`)).rejects.toThrow(
          /permission denied to create role/,
        )
      } finally {
        await client.end({ timeout: 5 })
      }

      const r = await probeAs(NON_OWNER)
      expect(r.capability.canProvisionRole).toBe(false)
    } finally {
      await t.client.unsafe(`REVOKE ${GROUP_ROLE} FROM ${NON_OWNER}; DROP ROLE ${GROUP_ROLE};`)
    }
  })
})

describe('azure_pg_admin — the Azure-only role, degrading on plain Postgres', () => {
  it('does not error where the role does not exist, and reports UNKNOWN not false', async () => {
    const r = await probeRlsPosture(t.db, bootstrapOpts)
    expect(r.capability.azurePgAdmin.rolePresent).toBe(false)
    // null is the honest answer: on a database with no such role there is no
    // membership to have. Reporting `false` would read as "checked, and no".
    expect(r.capability.azurePgAdmin.isMember).toBeNull()
  })

  it('reports membership when the role DOES exist (the Flexible Server shape)', async () => {
    // Simulate what the probe will meet on Azure. The name is fixed by Azure, so
    // it is created only if absent and dropped only if this test created it.
    const [pre] = await t.client<{ present: boolean }[]>`
      SELECT to_regrole(${AZURE_PG_ADMIN_ROLE}) IS NOT NULL AS present
    `
    const created = !pre!.present
    if (created) await t.client.unsafe(`CREATE ROLE ${AZURE_PG_ADMIN_ROLE} NOLOGIN`)
    try {
      const before = await probeAs(NON_OWNER)
      expect(before.capability.azurePgAdmin.rolePresent).toBe(true)
      expect(before.capability.azurePgAdmin.isMember, 'present but not a member').toBe(false)

      await t.client.unsafe(`GRANT ${AZURE_PG_ADMIN_ROLE} TO ${NON_OWNER}`)
      const after = await probeAs(NON_OWNER)
      expect(after.capability.azurePgAdmin.isMember).toBe(true)
      await t.client.unsafe(`REVOKE ${AZURE_PG_ADMIN_ROLE} FROM ${NON_OWNER}`)
    } finally {
      if (created) await t.client.unsafe(`DROP ROLE IF EXISTS ${AZURE_PG_ADMIN_ROLE}`)
    }
  })
})

describe('app-role detection — exists, can log in, and what it holds', () => {
  it('reports a real app role with its LOGIN attribute and its grants', async () => {
    await t.client.unsafe(`
      CREATE ROLE ${GROUP_ROLE} NOLOGIN;
      CREATE USER ${APP_ROLE} WITH LOGIN PASSWORD '${PASSWORD}' NOINHERIT;
      GRANT ${GROUP_ROLE} TO ${APP_ROLE};
      GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    `)
    try {
      const r = await probeRlsPosture(t.db, { ...bootstrapOpts, appRole: APP_ROLE })
      expect(r.appRole.roleName).toBe(APP_ROLE)
      expect(r.appRole.exists).toBe(true)
      expect(r.appRole.canLogin).toBe(true)
      expect(r.appRole.isSuperuser).toBe(false)
      expect(r.appRole.inherits, 'created NOINHERIT, per design §9 step 1').toBe(false)
      expect(r.appRole.memberOf).toContain(GROUP_ROLE)
      expect(r.appRole.grants).not.toBeNull()
      expect(r.appRole.grants!.schemaUsage).toBe(true)
      expect(r.appRole.grants!.tablesTotal).toBeGreaterThan(0)
      expect(r.appRole.grants!.canSelect).toBe(r.appRole.grants!.tablesTotal)
      expect(r.appRole.grants!.canDelete).toBe(r.appRole.grants!.tablesTotal)
      expect(r.line).toContain(`app-role '${APP_ROLE}' present (LOGIN)`)

      // …and the lane flips when the probe is RUN as that role.
      const asApp = await probeAs(APP_ROLE, { ...bootstrapOpts, appRole: APP_ROLE })
      expect(asApp.connection.lane).toBe('app-role')
      expect(asApp.summary.policiesApply).toBe(asApp.summary.rlsEnabled)
    } finally {
      await t.client.unsafe(`
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE};
        REVOKE ALL ON SCHEMA public FROM ${APP_ROLE};
        DROP USER IF EXISTS ${APP_ROLE};
        DROP ROLE IF EXISTS ${GROUP_ROLE};
      `)
    }
  })

  it('reports a NOLOGIN role as present-but-unusable rather than absent', async () => {
    await t.client.unsafe(`CREATE ROLE ${GROUP_ROLE} NOLOGIN`)
    try {
      const r = await probeRlsPosture(t.db, { appRole: GROUP_ROLE })
      expect(r.appRole.exists).toBe(true)
      expect(r.appRole.canLogin).toBe(false)
      expect(r.line).toContain('present (NOLOGIN)')
    } finally {
      await t.client.unsafe(`DROP ROLE IF EXISTS ${GROUP_ROLE}`)
    }
  })
})

describe('ENABLE vs FORCE, driven through all four combinations', () => {
  /*
   * The distinction four sections of the design doc got wrong independently.
   * A non-superuser OWNER is required to see it at all — the default
   * testcontainers user is a superuser and bypasses RLS unconditionally, which
   * would make every assertion below pass vacuously.
   */
  beforeAll(async () => {
    await t.client.unsafe(`
      CREATE USER ${OWNER_ROLE} WITH LOGIN PASSWORD '${PASSWORD}';
      GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE};
      CREATE TABLE ${OWNED_TABLE} (id int primary key);
      ALTER TABLE ${OWNED_TABLE} OWNER TO ${OWNER_ROLE};
      CREATE POLICY ${OWNED_TABLE}_all ON ${OWNED_TABLE} USING (true);
      GRANT SELECT ON ${OWNED_TABLE} TO ${NON_OWNER};
    `)
  })

  afterAll(async () => {
    await t.client
      .unsafe(
        `
        DROP TABLE IF EXISTS ${OWNED_TABLE};
        REVOKE ALL ON SCHEMA public FROM ${OWNER_ROLE};
        DROP USER IF EXISTS ${OWNER_ROLE};
      `,
      )
      .catch(() => undefined)
  })

  const rowFor = (r: RlsPostureReport) => r.tables.find((tbl) => tbl.table === OWNED_TABLE)

  it('RLS off: nobody is filtered, and the table is still reported (it has a policy)', async () => {
    await t.client.unsafe(`ALTER TABLE ${OWNED_TABLE} DISABLE ROW LEVEL SECURITY`)
    const owner = rowFor(await probeAs(OWNER_ROLE))
    const other = rowFor(await probeAs(NON_OWNER))
    expect(owner, 'a table carrying a policy is reported even with RLS off').toBeTruthy()
    expect(owner!.rlsEnabled).toBe(false)
    expect(owner!.policyCount).toBe(1)
    expect(owner!.policiesApply).toBe(false)
    expect(other!.policiesApply).toBe(false)
  })

  it('ENABLE alone: the NON-OWNER is bound, the OWNER is not', async () => {
    await t.client.unsafe(`ALTER TABLE ${OWNED_TABLE} ENABLE ROW LEVEL SECURITY`)
    const owner = rowFor(await probeAs(OWNER_ROLE))
    const other = rowFor(await probeAs(NON_OWNER))
    expect(owner!.currentUserOwns).toBe(true)
    expect(owner!.rlsForced).toBe(false)
    expect(owner!.policiesApply, 'the owner bypass — why 40 policies do nothing').toBe(false)
    expect(other!.currentUserOwns).toBe(false)
    expect(other!.policiesApply, 'ENABLE alone binds a non-owner; FORCE is not needed').toBe(true)
  })

  it('ENABLE + FORCE: the OWNER is bound too', async () => {
    await t.client.unsafe(`ALTER TABLE ${OWNED_TABLE} FORCE ROW LEVEL SECURITY`)
    const owner = rowFor(await probeAs(OWNER_ROLE))
    expect(owner!.rlsForced).toBe(true)
    expect(owner!.policiesApply).toBe(true)
    // …and the owner lane is still reported as the owner lane.
    const full = await probeAs(OWNER_ROLE)
    expect(full.connection.lane).toBe('owner')
    expect(full.connection.bypass.owner).toBe(true)
  })

  it('ENABLE + FORCE: a SUPERUSER is STILL not bound — FORCE has no hold on it', async () => {
    await t.client.unsafe(`
      ALTER TABLE ${OWNED_TABLE} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${OWNED_TABLE} FORCE ROW LEVEL SECURITY;
    `)
    // The trap the design doc names: run a harness as the default testcontainers
    // user and every RLS assertion passes vacuously. The probe has to say so.
    const su = rowFor(await probeRlsPosture(t.db))
    expect(su!.rlsEnabled).toBe(true)
    expect(su!.rlsForced).toBe(true)
    expect(su!.policiesApply, 'a superuser bypasses RLS unconditionally').toBe(false)
  })

  it('ENABLE + FORCE: SUPERUSER bypasses even when its BYPASSRLS attribute is OFF', async () => {
    /*
     * The two attributes are separable — `CREATE ROLE … SUPERUSER NOBYPASSRLS`
     * is legal — and a superuser bypasses row security whatever `rolbypassrls`
     * says. Without this case the superuser arm of the verdict is untestable:
     * initdb's own superuser carries rolbypassrls too, so the BYPASSRLS arm
     * alone would produce the same answer and the superuser arm could be
     * deleted with the suite still green.
     */
    const su = `probe_su_${sfx}`
    await t.client.unsafe(`
      ALTER TABLE ${OWNED_TABLE} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${OWNED_TABLE} FORCE ROW LEVEL SECURITY;
      CREATE USER ${su} WITH LOGIN PASSWORD '${PASSWORD}' SUPERUSER NOBYPASSRLS;
    `)
    try {
      const r = await probeAs(su)
      expect(r.capability.isSuperuser).toBe(true)
      expect(r.capability.canBypassRls, 'the attribute is off — the bypass is not').toBe(false)
      expect(rowFor(r)!.rlsForced).toBe(true)
      expect(rowFor(r)!.policiesApply).toBe(false)
      expect(r.summary.policiesApply).toBe(0)
    } finally {
      await t.client.unsafe(`DROP USER IF EXISTS ${su}`)
    }
  })

  it('ENABLE + FORCE: a BYPASSRLS role is not bound either — the third bypass', async () => {
    await t.client.unsafe(`
      ALTER TABLE ${OWNED_TABLE} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${OWNED_TABLE} FORCE ROW LEVEL SECURITY;
      ALTER ROLE ${NON_OWNER} BYPASSRLS;
    `)
    try {
      const r = await probeAs(NON_OWNER)
      expect(r.connection.bypass.bypassRls).toBe(true)
      expect(rowFor(r)!.policiesApply).toBe(false)
      // …and it is not one table: BYPASSRLS silences the whole estate. Granting
      // it to the app role would undo the switch while every other signal on
      // this card still read "done".
      expect(r.summary.policiesApply).toBe(0)
    } finally {
      await t.client.unsafe(`ALTER ROLE ${NON_OWNER} NOBYPASSRLS`)
    }
  })

  it('FORCE without ENABLE: still nobody is filtered', async () => {
    await t.client.unsafe(`ALTER TABLE ${OWNED_TABLE} DISABLE ROW LEVEL SECURITY`)
    const owner = rowFor(await probeAs(OWNER_ROLE))
    const other = rowFor(await probeAs(NON_OWNER))
    expect(owner!.rlsForced, 'FORCE survives a DISABLE — and does nothing on its own').toBe(true)
    expect(owner!.rlsEnabled).toBe(false)
    expect(owner!.policiesApply).toBe(false)
    expect(other!.policiesApply).toBe(false)
  })
})

describe('the boot line', () => {
  it('logs one line against a real database and returns it', async () => {
    const lines: string[] = []
    const line = await reportRlsPostureAtBoot({ DATABASE_URL: t.url } as NodeJS.ProcessEnv, (l) =>
      lines.push(l),
    )
    expect(line).toBeTruthy()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[preflight] rls:')
    expect(lines[0]).toContain('forced')
    expect(lines[0]).toContain(`app-role '${RLS_APP_ROLE}' absent`)
    // The line is measured before migrations run, and says so — see the
    // BOOT_LINE_SUFFIX rationale in scripts/preflight-rls.ts.
    expect(lines[0]).toContain('measured BEFORE migrations')
    // Never a URL, never a credential.
    expect(lines[0]).not.toContain('postgres://')
    expect(lines[0]).not.toContain('postgresql://')
    expect(lines[0]).not.toContain(t.url)
  })

  it('skips cleanly with no DATABASE_URL', async () => {
    const lines: string[] = []
    const line = await reportRlsPostureAtBoot({} as NodeJS.ProcessEnv, (l) => lines.push(l))
    expect(line).toBeNull()
    expect(lines[0]).toContain('skipped (DATABASE_URL unset)')
  })

  it('is actually WIRED: running the entrypoint pre-flight prints it', async () => {
    /*
     * A tested module with no caller is not a feature (CLAUDE.md rule 16). The
     * assertions above prove the function works; only running the file
     * entrypoint.sh runs proves the line reaches a deploy log. So run it —
     * `node node_modules/.bin/tsx scripts/preflight-run.ts`, exactly as the
     * entrypoint does. Deleting the call from preflight-run.ts turns this red;
     * nothing else in the suite would notice.
     */
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { resolve, dirname } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const root = resolve(__dirname, '../../..')
    // Walk up for node_modules/.bin/tsx: a git worktree has no node_modules of
    // its own and resolves against the checkout it was branched from.
    let tsxBin = ''
    for (let dir = root; ; dir = dirname(dir)) {
      const candidate = resolve(dir, 'node_modules/.bin/tsx')
      if (existsSync(candidate)) {
        tsxBin = candidate
        break
      }
      if (dirname(dir) === dir) break
    }
    expect(tsxBin, 'tsx is what entrypoint.sh runs the pre-flight with').toBeTruthy()
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [tsxBin, 'scripts/preflight-run.ts'],
      { cwd: root, env: { ...process.env, DATABASE_URL: t.url }, timeout: 90_000 },
    )
    expect(stdout).toContain('[preflight] rls:')
    expect(stdout).toContain('measured BEFORE migrations')
  }, 120_000)

  it('never throws when the database refuses the connection — boot must not break', async () => {
    const lines: string[] = []
    const line = await reportRlsPostureAtBoot(
      { DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none' } as NodeJS.ProcessEnv,
      (l) => lines.push(l),
    )
    expect(line).toBeNull()
    expect(lines).toEqual([])
  })
})
