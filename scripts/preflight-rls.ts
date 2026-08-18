/*
 * scripts/preflight-rls.ts — the RLS CAPABILITY PROBE. Read-only.
 *
 * WHAT THIS IS FOR. Turning the 40 inert RLS policies into a real boundary
 * (docs/design/rls-enforcement.md) requires the app to connect as a NON-OWNER
 * role, and creating that role requires a connection that can run `CREATE ROLE`.
 * The migration runner connects as the Azure Flexible Server
 * `administratorLogin`, which Azure documents as a member of `azure_pg_admin`
 * and therefore — supposedly — able to create roles without a DBA.
 *
 * "Supposedly" is the whole problem. That is an INFERENCE from vendor
 * documentation, not a measurement of OUR instance, and a plan that rests on it
 * is a plan resting on a fact nobody has checked. Nobody can reach the dev
 * database from outside (VNet + private endpoints), so the only place the
 * measurement can be taken is INSIDE the deployed app. This module takes it.
 *
 * WHAT IT REPORTS (all four are questions the runbook currently guesses at):
 *   1. Can THIS connection provision the role?  — current_user, rolsuper,
 *      rolcreaterole, and azure_pg_admin membership.
 *   2. Does the app role exist yet?             — presence, LOGIN, grants.
 *   3. The live RLS posture per table           — relrowsecurity,
 *      relforcerowsecurity, policy count, and whether the policies actually
 *      APPLY to the connection asking.
 *   4. Which connection is in use               — owner, app-role, or neither.
 *
 * IT PROVISIONS NOTHING. Every statement below reads pg_catalog. No CREATE, no
 * ALTER, no GRANT. Design §9's runbook is somebody else's change; this exists so
 * that change can be planned against a measurement instead of a document.
 *
 * ── WHY THIS LIVES IN scripts/ AND NOT server/ ──────────────────────────────
 * The runtime image copies `node_modules`, `.output`, `drizzle/`, `scripts/` and
 * `entrypoint.sh` — and NOT `server/` or `shared/` (Dockerfile stage 4). Boot
 * runs under tsx against those raw files, so a module the pre-flight imports
 * CANNOT live under server/: it would resolve in dev and be missing in
 * production. `scripts/preflight.ts` carries the same constraint and the same
 * shape — the canonical probe lives here and the admin diagnostics route imports
 * it (nitro bundles it at build).
 *
 * The role NAMES live one door along in `scripts/rls-roles.ts` (constants only,
 * zero imports) for the same reason, and `server/db/rls-bootstrap.ts` re-exports
 * `RLS_APP_ROLE` so server-side code has one obvious import site beside
 * `RLS_BOOTSTRAP_TABLES`. One spelling in the tree, whichever door you use.
 *
 * NO TOP-LEVEL EXECUTION, for the reason at the foot of scripts/preflight.ts:
 * nitro evaluates route modules at server startup, so a module the routes import
 * must have no side effects. The boot caller is scripts/preflight-run.ts.
 */
import { sql, type SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { consola } from 'consola'
import { createDbClient } from '../drizzle/connect'
import { RLS_APP_ROLE, AZURE_PG_ADMIN_ROLE, CREATEROLE_VIA_SET_ROLE_SQL } from './rls-roles'

export { RLS_APP_ROLE, AZURE_PG_ADMIN_ROLE }

/*
 * ── `relkind IN ('r','p')`, NOT `= 'r'` ─────────────────────────────────────
 *
 * MEASURED: `attribution_record` is a PARTITIONED table — `relkind = 'p'` — it
 * is RLS-enabled and carries two policies. Filtering on `'r'` alone dropped it
 * from every query here, so this probe reported **22** tables and 22
 * RLS-enabled while the estate has 23, and the design doc's "all 23 tables"
 * was quietly disagreeing with the instrument built to measure it.
 *
 * It is the worst possible table to lose: the money ledger, and the one whose
 * policies the whole enforcement effort exists to make real. Grant coverage
 * under-reported the same way, so `canSelect` could read as full coverage with
 * the ledger missing from both numerator and denominator.
 *
 * `drizzle/rls-binding.ts` — the cutover sweep and the boot gate — already read
 * `('r','p')`, so this was also two disagreeing definitions of "the table set"
 * in one branch. Found by review, not by a test; hence the assertion in
 * `tests/integration/db/rls-posture-probe.test.ts` that the parent is present.
 *
 * (Its CHILD partitions are `relkind = 'r'` and are born un-enabled — see
 * design §7. They appear here as themselves, which is the truth about them.)
 */

/** How a connection is (or is not) able to run `CREATE ROLE`. */
export type ProvisionBasis = 'superuser' | 'createrole' | 'set-role' | 'none'

export interface RlsProvisioningCapability {
  /** The role the queries actually ran as. */
  currentUser: string
  /** The role that authenticated, before any SET ROLE. */
  sessionUser: string
  isSuperuser: boolean
  /** The CREATEROLE attribute ON THIS ROLE. */
  canCreateRole: boolean
  /** The BYPASSRLS attribute — a third way for policies not to run. */
  canBypassRls: boolean
  azurePgAdmin: {
    /** false on any non-Azure Postgres; the membership question is then moot. */
    rolePresent: boolean
    /** null (not false) when the role does not exist — an unknown, not a no. */
    isMember: boolean | null
  }
  /**
   * Roles carrying CREATEROLE/SUPERUSER that this connection could `SET ROLE` to.
   *
   * Postgres does NOT inherit role ATTRIBUTES through membership the way it
   * inherits object privileges: "you must actually SET ROLE to a specific role
   * having such an attribute in order to make use of the attribute". So
   * membership of `azure_pg_admin` grants CREATEROLE only via SET ROLE, and a
   * verdict computed from `rolcreaterole` alone would read "no" on an instance
   * that can in fact provision the role.
   *
   * Membership is NOT the test — `GRANT … WITH SET FALSE` (PG 16) still reports
   * as MEMBER while the server refuses the transition. The predicate lives in
   * `CREATEROLE_VIA_SET_ROLE_SQL` with the measurements that chose it, and
   * `drizzle/provision-app-role.ts` issues the `SET ROLE` this field promises.
   */
  createRoleViaSetRole: string[]
  /** The measured answer to "can this connection provision the app role?" */
  canProvisionRole: boolean
  provisionBasis: ProvisionBasis
}

export interface RlsAppRoleStatus {
  /** The role name looked for — echoed so the report is self-describing. */
  roleName: string
  exists: boolean
  /** null when the role does not exist. */
  canLogin: boolean | null
  isSuperuser: boolean | null
  canBypassRls: boolean | null
  /** NOINHERIT (design §9 step 1) shows here as false. */
  inherits: boolean | null
  /** Roles granted TO the app role. */
  memberOf: string[]
  /** null when the role does not exist — never a misleading zero. */
  grants: RlsAppRoleGrants | null
}

/** What the app role has actually been granted on the public schema. */
export interface RlsAppRoleGrants {
  schemaUsage: boolean
  tablesTotal: number
  canSelect: number
  canInsert: number
  canUpdate: number
  canDelete: number
}

export interface RlsTablePosture {
  table: string
  /** `pg_class.relrowsecurity` — binds a NON-OWNER on its own. */
  rlsEnabled: boolean
  /** `pg_class.relforcerowsecurity` — what additionally binds the OWNER. */
  rlsForced: boolean
  policyCount: number
  owner: string
  /**
   * True when the probing connection holds the owner's privileges (directly or
   * through an inherited grant) — the ownership bypass, which `FORCE` is what
   * closes.
   */
  currentUserOwns: boolean
  /** In `RLS_BOOTSTRAP_TABLES` — must be DISABLED before the role switch. */
  bootstrap: boolean
  /** Do this table's policies actually filter the probing connection? */
  policiesApply: boolean
}

export type ConnectionLane = 'owner' | 'app-role' | 'other'

export interface RlsConnectionPosture {
  currentUser: string
  lane: ConnectionLane
  /** Of the reported tables, how many this connection owns. */
  ownedTables: number
  /** Every route by which policies can fail to run for this connection. */
  bypass: { superuser: boolean; bypassRls: boolean; owner: boolean }
}

export interface RlsPostureSummary {
  tablesReported: number
  rlsEnabled: number
  rlsForced: number
  policies: number
  /**
   * Tables whose policies actually filter THIS connection. The headline number:
   * 0 out of N enabled is the "40 policies, none of them execute" state the
   * design doc opens with.
   */
  policiesApply: number
  /**
   * Bootstrap tables still RLS-enabled. Harmless while the app connects as the
   * owner; the moment it does not, these are the reads that happen before any
   * identity exists — design §5's fleet-stop.
   */
  bootstrapStillEnabled: string[]
}

export interface RlsPostureReport {
  /** Server-resolved instant of the measurement (an instant, not a day bucket). */
  measuredAt: string
  capability: RlsProvisioningCapability
  appRole: RlsAppRoleStatus
  connection: RlsConnectionPosture
  summary: RlsPostureSummary
  tables: RlsTablePosture[]
  /** The same posture as one log line — see {@link formatRlsPostureLine}. */
  line: string
}

/**
 * The narrowest shape this probe needs: anything that can run a drizzle `SQL`
 * and hand back rows. Satisfied by `PostgresJsDatabase`, by the transaction
 * handle `withRequestRls` yields, and by a bare `drizzle(client)` at boot — so
 * the same queries serve the route and the pre-flight without a second client
 * abstraction.
 */
export interface RlsProbeDb {
  execute(query: SQL): Promise<Iterable<Record<string, unknown>>>
}

/*
 * ONE cast, here, on purpose.
 *
 * The interface above is deliberately NOT generic in the row type. Drizzle's own
 * `execute<T>` resolves its result through `Assume<T, Row>`, which TypeScript
 * cannot prove assignable to a caller-supplied `T` — so a generic
 * `execute<T>(): Promise<Iterable<T>>` makes BOTH real handles (the request-lane
 * transaction and a bare `drizzle(client)`) unassignable to it. Rows returned by
 * raw SQL are unvalidated whichever way this is spelled; drizzle's generic is the
 * same cast wearing a type parameter. Confining it to this one function is the
 * honest version.
 */
async function queryRows<T extends Record<string, unknown>>(
  db: RlsProbeDb,
  query: SQL,
): Promise<T[]> {
  return [...(await db.execute(query))] as T[]
}

export interface RlsProbeOptions {
  /** Defaults to {@link RLS_APP_ROLE}; injectable so tests can prove detection. */
  appRole?: string
  /**
   * `RLS_BOOTSTRAP_TABLE_NAMES`, passed in rather than imported: this module is
   * loaded at boot from an image that has no `server/` directory (see header).
   * Omitted at boot, supplied by the admin route.
   */
  bootstrapTables?: readonly string[]
}

interface CapabilityRow extends Record<string, unknown> {
  current_user_name: string
  session_user_name: string
  is_superuser: boolean
  can_create_role: boolean
  can_bypass_rls: boolean
  azure_pg_admin_present: boolean
  azure_pg_admin_member: boolean | null
  create_role_via_set_role: string[]
}

/*
 * The azure_pg_admin membership is read through a SCALAR SUBQUERY over pg_roles
 * rather than a bare `pg_has_role(current_user, 'azure_pg_admin', 'member')`,
 * which ERRORS with `role "azure_pg_admin" does not exist` on any non-Azure
 * Postgres — i.e. on every developer machine and in every test container. A
 * subquery with no matching row never evaluates its select list, so the value is
 * NULL and the probe reports "unknown" instead of dying. `to_regrole` answers
 * the existence question without erroring for the same reason.
 *
 * `MEMBER` is the right predicate HERE and the wrong one below: this field
 * answers "is this connection a member of azure_pg_admin", which is a fact about
 * the grant. Whether that membership can be USED — `SET ROLE` — is a different
 * question with a different answer under `WITH SET FALSE`, and it is
 * `create_role_via_set_role` that has to get it right (see
 * `CREATEROLE_VIA_SET_ROLE_SQL`). Reporting both is deliberate: a member that
 * cannot SET ROLE is exactly the shape an operator needs to see named.
 */
const CAPABILITY_SQL = sql`
  SELECT current_user::text  AS current_user_name,
         session_user::text  AS session_user_name,
         r.rolsuper          AS is_superuser,
         r.rolcreaterole     AS can_create_role,
         r.rolbypassrls      AS can_bypass_rls,
         (to_regrole(${AZURE_PG_ADMIN_ROLE}) IS NOT NULL) AS azure_pg_admin_present,
         (SELECT pg_has_role(current_user, g.oid, 'MEMBER')
            FROM pg_roles g
           WHERE g.rolname = ${AZURE_PG_ADMIN_ROLE}::name) AS azure_pg_admin_member,
         ARRAY(${sql.raw(CREATEROLE_VIA_SET_ROLE_SQL)}) AS create_role_via_set_role
    FROM pg_roles r
   WHERE r.rolname = current_user
`

interface AppRoleRow extends Record<string, unknown> {
  can_login: boolean
  is_superuser: boolean
  can_bypass_rls: boolean
  inherits: boolean
  member_of: string[]
}

const appRoleSql = (appRole: string): SQL => sql`
  SELECT r.rolcanlogin  AS can_login,
         r.rolsuper     AS is_superuser,
         r.rolbypassrls AS can_bypass_rls,
         r.rolinherit   AS inherits,
         ARRAY(
           SELECT g.rolname::text
             FROM pg_auth_members m
             JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = r.oid
            ORDER BY 1
         ) AS member_of
    FROM pg_roles r
   WHERE r.rolname = ${appRole}::name
`

interface GrantsRow extends Record<string, unknown> {
  schema_usage: boolean
  tables_total: number
  can_select: number
  can_insert: number
  can_update: number
  can_delete: number
}

/*
 * Only ever run for a role that EXISTS: has_table_privilege / has_schema_privilege
 * raise `role "…" does not exist` otherwise, which would turn "the role has not
 * been created yet" — the expected answer today — into a 502.
 */
const grantsSql = (appRole: string): SQL => sql`
  SELECT has_schema_privilege(${appRole}::name, 'public', 'USAGE') AS schema_usage,
         count(*)::int AS tables_total,
         count(*) FILTER (WHERE has_table_privilege(${appRole}::name, c.oid, 'SELECT'))::int AS can_select,
         count(*) FILTER (WHERE has_table_privilege(${appRole}::name, c.oid, 'INSERT'))::int AS can_insert,
         count(*) FILTER (WHERE has_table_privilege(${appRole}::name, c.oid, 'UPDATE'))::int AS can_update,
         count(*) FILTER (WHERE has_table_privilege(${appRole}::name, c.oid, 'DELETE'))::int AS can_delete
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
`

interface TableRow extends Record<string, unknown> {
  table_name: string
  rls_enabled: boolean
  rls_forced: boolean
  policy_count: number
  table_owner: string
  current_user_owns: boolean
}

/*
 * `pg_has_role(current_user, c.relowner, 'USAGE')` and not `relowner =
 * current_user::regrole`: Postgres decides the owner bypass with
 * has_privs_of_role(), so a connection GRANTed the owning role (with INHERIT)
 * bypasses RLS exactly as the owner does. Provisioning `tokenscope_app` and then
 * granting it the owner role would silently keep every policy inert, and an
 * equality check would report the switch as done.
 */
const TABLES_SQL = sql`
  SELECT c.relname::text                  AS table_name,
         c.relrowsecurity                 AS rls_enabled,
         c.relforcerowsecurity            AS rls_forced,
         pg_get_userbyid(c.relowner)::text AS table_owner,
         pg_has_role(current_user, c.relowner, 'USAGE') AS current_user_owns,
         (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY c.relname
`

function basisFor(cap: {
  isSuperuser: boolean
  canCreateRole: boolean
  createRoleViaSetRole: string[]
}): ProvisionBasis {
  if (cap.isSuperuser) return 'superuser'
  if (cap.canCreateRole) return 'createrole'
  if (cap.createRoleViaSetRole.length > 0) return 'set-role'
  return 'none'
}

/**
 * Do this table's policies filter the probing connection?
 *
 * Four conditions, and only the last is obvious. RLS must be ENABLEd at all; a
 * superuser is never filtered (its BYPASSRLS attribute is irrelevant — the two
 * are separable and either one is enough); a BYPASSRLS role is never filtered;
 * an OWNER is filtered only under FORCE. Which leaves the clause four separate
 * sections of the design doc got wrong independently: a NON-OWNER is filtered as
 * soon as RLS is ENABLEd, and FORCE has nothing to do with it. Computed here
 * rather than left to a reader, because reading it off the flags is what kept
 * going wrong.
 */
function policiesApplyTo(
  table: { rlsEnabled: boolean; rlsForced: boolean; currentUserOwns: boolean },
  bypass: { superuser: boolean; bypassRls: boolean },
): boolean {
  if (!table.rlsEnabled) return false
  if (bypass.superuser || bypass.bypassRls) return false
  if (table.currentUserOwns && !table.rlsForced) return false
  return true
}

/**
 * Measure the live RLS capability + posture. Read-only: three SELECTs against
 * pg_catalog, plus a fourth only when the app role exists (privilege functions
 * error on a role that does not).
 */
export async function probeRlsPosture(
  db: RlsProbeDb,
  options: RlsProbeOptions = {},
): Promise<RlsPostureReport> {
  const appRoleName = options.appRole ?? RLS_APP_ROLE
  const bootstrap = new Set(options.bootstrapTables ?? [])

  const [capRow] = await queryRows<CapabilityRow>(db, CAPABILITY_SQL)
  if (!capRow) {
    // pg_roles always has a row for current_user; if it does not, something is
    // wrong enough that a fabricated report would be worse than a failure.
    throw new Error('rls posture probe: pg_roles has no row for current_user')
  }
  const capability: RlsProvisioningCapability = {
    currentUser: capRow.current_user_name,
    sessionUser: capRow.session_user_name,
    isSuperuser: capRow.is_superuser,
    canCreateRole: capRow.can_create_role,
    canBypassRls: capRow.can_bypass_rls,
    azurePgAdmin: {
      rolePresent: capRow.azure_pg_admin_present,
      isMember: capRow.azure_pg_admin_present ? (capRow.azure_pg_admin_member ?? false) : null,
    },
    createRoleViaSetRole: capRow.create_role_via_set_role ?? [],
    canProvisionRole: false,
    provisionBasis: 'none',
  }
  capability.provisionBasis = basisFor(capability)
  capability.canProvisionRole = capability.provisionBasis !== 'none'

  const [appRow] = await queryRows<AppRoleRow>(db, appRoleSql(appRoleName))
  let grants: RlsAppRoleGrants | null = null
  if (appRow) {
    const [g] = await queryRows<GrantsRow>(db, grantsSql(appRoleName))
    if (g) {
      grants = {
        schemaUsage: g.schema_usage,
        tablesTotal: g.tables_total,
        canSelect: g.can_select,
        canInsert: g.can_insert,
        canUpdate: g.can_update,
        canDelete: g.can_delete,
      }
    }
  }
  const appRole: RlsAppRoleStatus = {
    roleName: appRoleName,
    exists: Boolean(appRow),
    canLogin: appRow ? appRow.can_login : null,
    isSuperuser: appRow ? appRow.is_superuser : null,
    canBypassRls: appRow ? appRow.can_bypass_rls : null,
    inherits: appRow ? appRow.inherits : null,
    memberOf: appRow?.member_of ?? [],
    grants,
  }

  // The two connection-WIDE bypasses. The third (ownership) is per table, so it
  // is applied inside policiesApplyTo and summarised afterwards.
  const roleBypass = { superuser: capability.isSuperuser, bypassRls: capability.canBypassRls }

  const allTables = await queryRows<TableRow>(db, TABLES_SQL)
  // Report the tables that carry (or must NOT carry) row security: everything
  // RLS-enabled, everything holding a policy, and every bootstrap table — the
  // last of those because the runbook DISABLEs them, and a table that vanished
  // from the report the moment it was disabled would hide the very step whose
  // completion the operator is checking.
  const tables: RlsTablePosture[] = allTables
    .filter((r) => r.rls_enabled || r.policy_count > 0 || bootstrap.has(r.table_name))
    .map((r) => {
      const shape = {
        rlsEnabled: r.rls_enabled,
        rlsForced: r.rls_forced,
        currentUserOwns: r.current_user_owns,
      }
      return {
        table: r.table_name,
        ...shape,
        policyCount: r.policy_count,
        owner: r.table_owner,
        bootstrap: bootstrap.has(r.table_name),
        policiesApply: policiesApplyTo(shape, roleBypass),
      }
    })

  const ownedTables = tables.filter((t) => t.currentUserOwns).length
  const lane: ConnectionLane =
    capability.currentUser === appRoleName ? 'app-role' : ownedTables > 0 ? 'owner' : 'other'

  const connection: RlsConnectionPosture = {
    currentUser: capability.currentUser,
    lane,
    ownedTables,
    bypass: { ...roleBypass, owner: ownedTables > 0 },
  }

  const summary: RlsPostureSummary = {
    tablesReported: tables.length,
    rlsEnabled: tables.filter((t) => t.rlsEnabled).length,
    rlsForced: tables.filter((t) => t.rlsForced).length,
    policies: tables.reduce((n, t) => n + t.policyCount, 0),
    policiesApply: tables.filter((t) => t.policiesApply).length,
    bootstrapStillEnabled: tables.filter((t) => t.bootstrap && t.rlsEnabled).map((t) => t.table),
  }

  const measured = {
    measuredAt: new Date().toISOString(),
    capability,
    appRole,
    connection,
    summary,
    tables,
  }
  return { ...measured, line: formatRlsPostureLine(measured) }
}

/**
 * The whole posture as ONE line, for a deploy log.
 *
 * e.g. `rls: owner-connection as 'tokenscope', 0/23 forced, 0/23 enforced,
 * app-role 'tokenscope_app' absent, can-create-role=yes (superuser)`
 *
 * NEVER interpolates a URL, a password or anything but catalog identifiers.
 */
export function formatRlsPostureLine(report: Omit<RlsPostureReport, 'line'>): string {
  const { summary, connection, appRole, capability } = report
  const roleState = !appRole.exists
    ? 'absent'
    : appRole.canLogin
      ? 'present (LOGIN)'
      : 'present (NOLOGIN)'
  const basis =
    capability.provisionBasis === 'set-role'
      ? `set-role ${capability.createRoleViaSetRole.join('/')}`
      : capability.provisionBasis
  const parts = [
    `${connection.lane}-connection as '${connection.currentUser}'`,
    `${summary.rlsForced}/${summary.rlsEnabled} forced`,
    `${summary.policiesApply}/${summary.rlsEnabled} enforced`,
    `${summary.policies} policies`,
    `app-role '${appRole.roleName}' ${roleState}`,
    `can-create-role=${capability.canProvisionRole ? 'yes' : 'no'} (${basis})`,
  ]
  if (summary.bootstrapStillEnabled.length > 0) {
    parts.push(`bootstrap-still-enabled=${summary.bootstrapStillEnabled.length}`)
  }
  return `rls: ${parts.join(', ')}`
}

/*
 * MEASURED BEFORE MIGRATIONS, and the log line says so.
 *
 * entrypoint.sh runs the pre-flight first and migrations second, so a deploy
 * whose migration changes RLS posture (or creates the app role) logs the state
 * as it was BEFORE that migration. Saying "0/23 forced" without that
 * qualification would be the kind of sentence that is true when written and
 * false by the time anyone reads it. The admin route is the live truth.
 */
/**
 * The whole probe's wall clock, so the boot arithmetic has ONE term for it
 * rather than a product of "how many queries does it run today".
 *
 * 12s is generous for five catalog reads and deliberately small: this line is
 * INFORMATIONAL, and an informational step that can eat a fifth of the
 * container's start window is mispriced. Everything it reports is also served
 * live by /api/v1/admin/diagnostics/rls-posture.
 */
const POSTURE_PROBE_BUDGET_MS = Number(process.env.TOKENSCOPE_RLS_POSTURE_BUDGET_MS) || 12_000

const BOOT_LINE_SUFFIX =
  ' (measured BEFORE migrations; /api/v1/admin/diagnostics/rls-posture is live)'

/**
 * Log the RLS posture as one boot line. INFORMATIONAL ONLY — it opens its own
 * short-lived connection, never throws, and never blocks boot. A failure here
 * costs a warning; Postgres reachability is already gated by
 * `scripts/preflight.ts` and migrations remain the real gate.
 *
 * The bootstrap-table highlight is deliberately absent: `RLS_BOOTSTRAP_TABLES`
 * lives under `server/`, which the runtime image does not ship (see header).
 * The admin route supplies it.
 *
 * @returns the line logged, or null when the probe was skipped or failed.
 */
export async function reportRlsPostureAtBoot(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<string | null> {
  const url = env.DATABASE_URL
  if (!url) {
    log('[preflight] rls: skipped (DATABASE_URL unset)')
    return null
  }
  let client: ReturnType<typeof createDbClient> | null = null
  try {
    client = createDbClient(url, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      /*
       * `statement_timeout` as well as `connect_timeout`, because this probe
       * runs INSIDE the pre-flight step and the startup budget counts
       * pre-flight as a bounded 30s. It was not: `connect_timeout` bounds only
       * the connect, so a server that accepted the connection and stalled on
       * the catalog queries left this waiting indefinitely — an unbounded step
       * inside a total the arithmetic claimed was bounded. Informational and
       * non-fatal either way; the timeout just makes the claim true. A bare
       * integer is MILLISECONDS to Postgres, which is also what this option is
       * typed as here.
       */
      connection: { TimeZone: 'UTC', statement_timeout: 10_000 },
    })
    /*
     * ONE WALL-CLOCK BOUND FOR THE WHOLE PROBE, not five statement timeouts.
     *
     * `probeRlsPosture` runs FIVE serial queries. With only a per-statement
     * timeout the step's worst case is five times that plus teardown, and the
     * startup arithmetic in `provision-app-role-contract.test.ts` has to model
     * it — which it got wrong twice, first by omitting this probe entirely and
     * then by counting it as a single connect+statement pair.
     *
     * A number that must be re-derived every time a query is added to this
     * function will go stale again. So the probe gets a deadline of its own and
     * becomes ONE term the arithmetic can state exactly, whatever it does
     * inside. Non-fatal, like everything else here: losing the race costs the
     * posture line and nothing more.
     */
    const report = await Promise.race([
      probeRlsPosture(drizzle(client)),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`posture probe exceeded ${POSTURE_PROBE_BUDGET_MS / 1000}s`)),
          POSTURE_PROBE_BUDGET_MS,
        ).unref(),
      ),
    ])
    const line = report.line + BOOT_LINE_SUFFIX
    log(`[preflight] ${line}`)
    return line
  } catch (err) {
    // Raw error to the log at full fidelity (the redact-probe-error contract's
    // server-side half) — postgres.js never puts the password in a message, and
    // this line never interpolates the URL.
    consola.warn('[preflight] rls: posture probe unavailable (non-fatal; boot continues)', err)
    return null
  } finally {
    await client?.end({ timeout: 5 }).catch(() => undefined)
  }
}
