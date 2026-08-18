/*
 * drizzle/rls-binding.ts — the ONE definition of "is it safe to bind the app to
 * the non-owner role?", shared by the two boot steps that each need to answer
 * it about a different moment.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `cutover-rls-sweep.ts` asked this question about work IT had just committed
 * (`verify()`), and nothing asked it about the state the RUNTIME is about to
 * bind to. Those are not the same moment, and the gap between them was a real
 * outage door: `useAppRoleAtRuntime` emits `TOKENSCOPE_APP_DATABASE_URL` on its
 * own flag (`infra/modules/container-app.bicep`), with no dependency on the
 * sweep having run. The ordering was stated in prose in the param block and
 * enforced by nothing — so one flag, set alone, boots the app as the non-owner
 * while `oauth_token` is still RLS-ENABLED, the bearer lookup returns zero rows
 * for every device, and the emit fleet stops against a deploy that looks green.
 *
 * A documented ordering is not a safety property. This module is the property.
 *
 * ── THE TWO PREDICATES ──────────────────────────────────────────────────────
 *
 * Both come from design §5 and §7 and both are about a NON-OWNER, which is what
 * the app becomes at cutover:
 *
 *   1. A BOOTSTRAP table that is still RLS-ENABLED. These are read BEFORE any
 *      RLS identity can exist (the bearer lookup discovers the teammate FROM
 *      `oauth_token`; /setup/redeem reads `instance_attestation`; the
 *      pre-identity paths audit themselves). `ENABLE` alone binds a non-owner —
 *      `FORCE` is only what additionally binds the OWNER — so these do not need
 *      to be FORCEd to stop every device. Design §5's fleet-stop.
 *
 *   2. Any table that is ENABLED but NOT FORCEd. `FORCE` is how a rollout phase
 *      says "deliberately on, policy blockers fixed, hands off" (design §7). A
 *      table that is enabled without it has been vetted by nobody, and it starts
 *      filtering the app the instant the app connects as the role.
 *
 * Note the asymmetry, because it is the whole point: predicate 2 is about
 * tables nobody vetted, so it does NOT fire on a phase's `ENABLE`+`FORCE`. The
 * gate refuses un-vetted enforcement; it never refuses deliberate enforcement.
 */
import type { BootDb } from './boot-sql'
import { RLS_BOOTSTRAP_TABLE_NAMES } from '../scripts/rls-roles'

export interface TablePosture {
  relname: string
  /** `pg_class.relrowsecurity` — binds a NON-OWNER on its own. */
  enabled: boolean
  /** `pg_class.relforcerowsecurity` — what additionally binds the OWNER. */
  forced: boolean
}

/**
 * Every `public` table and partitioned table with its two RLS flags.
 *
 * On partitions, measured rather than assumed: a child made by `CREATE TABLE …
 * PARTITION OF` does NOT inherit the parent's `relrowsecurity` /
 * `relforcerowsecurity` — it is born `false`/`false` whatever the parent's
 * posture. Reading through the PARENT still applies the parent's policies
 * correctly; reading a child BY NAME as a non-owner returns everything,
 * unfiltered. Partitions are `relkind='r'`, so they appear here and read as
 * un-enabled, which is the truth about them and therefore never trips
 * predicate 2. The residual risk is a raw-SQL path that names a partition
 * directly — out of this gate's reach, recorded in design §7.
 */
export async function readPosture(sql: BootDb): Promise<TablePosture[]> {
  return await sql<TablePosture[]>`
    SELECT c.relname::text AS relname,
           c.relrowsecurity      AS enabled,
           c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  `
}

export interface BindingHazards {
  /** Bootstrap tables still RLS-ENABLED — predicate 1. */
  bootstrapStillEnabled: string[]
  /** Tables ENABLED but not FORCEd — predicate 2. */
  bindingUnvetted: string[]
}

/**
 * The shared predicate. Returns the offenders rather than a boolean so both
 * callers can name them: an empty pair on both lists means the app may bind to
 * the non-owner role without a table filtering it that no phase vetted.
 */
export function bindingHazards(posture: readonly TablePosture[]): BindingHazards {
  const byName = new Map(posture.map((t) => [t.relname, t]))
  return {
    bootstrapStillEnabled: RLS_BOOTSTRAP_TABLE_NAMES.filter((t) => byName.get(t)?.enabled),
    bindingUnvetted: posture.filter((t) => t.enabled && !t.forced).map((t) => t.relname),
  }
}

export function hasBindingHazard(h: BindingHazards): boolean {
  return h.bootstrapStillEnabled.length > 0 || h.bindingUnvetted.length > 0
}

/** Tag shared with the boot gate, so the refusal and its log line agree. */
export const GATE_TAG = '[assert-runtime-rls-safe]'

/**
 * The refusal, as one message. Lives HERE and not in the gate script because
 * this module has no side effects: the gate calls `main()` at module scope (the
 * convention its two siblings set), so anything importable for a unit test has
 * to sit outside it.
 */
export function refusalMessage(h: BindingHazards): string {
  const lines = [
    `${GATE_TAG} REFUSING TO START — TOKENSCOPE_APP_DATABASE_URL is set, so the runtime pools would connect as the non-owner role, but the schema is not ready for that.`,
  ]
  if (h.bootstrapStillEnabled.length > 0) {
    lines.push(
      `  · design §5 — bootstrap table(s) ${h.bootstrapStillEnabled.join(', ')} are still RLS-ENABLED. ${BOOTSTRAP_ENABLED_CONSEQUENCE}`,
    )
  }
  if (h.bindingUnvetted.length > 0) {
    lines.push(
      `  · design §7 — table(s) ${h.bindingUnvetted.join(', ')} are ENABLED but not FORCEd. ${UNVETTED_CONSEQUENCE}`,
    )
  }
  lines.push(
    'Boot is refused rather than served: the previous revision keeps running, where booting this one would stop the emit fleet against a deploy that reports healthy.',
    'To proceed, either run the cutover sweep (set runRlsCutoverSweep=true for one deploy) so these tables are DISABLEd, or unset useAppRoleAtRuntime until they are.',
  )
  return lines.join('\n')
}

export interface ServerIdentity {
  database: string
  /** `inet_server_addr()` — NULL over a unix socket, which production never uses. */
  address: string | null
  port: number | null
  user: string
}

/**
 * WHO AM I ACTUALLY TALKING TO. Asked of both connections, because the gate
 * reads posture through the OWNER url while Nitro binds the APP url, and
 * nothing else in the boot path ever checks that those two name the same
 * database.
 *
 * The server answers for itself rather than the client parsing two URL strings:
 * a URL comparison would be defeated by an alias, a private-endpoint CNAME or a
 * pooler in front of one of them, and would report a difference where there is
 * none. `inet_server_addr()`/`inet_server_port()` are what the SERVER says its
 * own listener is, and need no special privilege.
 */
export async function readServerIdentity(sql: BootDb): Promise<ServerIdentity> {
  const [row] = await sql<{ database: string; address: string | null; port: number | null; user: string }[]>`
    SELECT current_database()::text     AS database,
           inet_server_addr()::text     AS address,
           inet_server_port()           AS port,
           current_user::text           AS user
  `
  if (!row) throw new Error('the server returned no identity row')
  return row
}

/**
 * Do the two connections reach the same database on the same server?
 *
 * Returns the reasons they cannot be shown to, empty when they agree.
 *
 * WHAT AGREEMENT HERE DOES AND DOES NOT PROVE. It compares what each server
 * says about itself — database name, listener address, listener port — at one
 * instant. That is enough to rule out the case this exists for: the app url
 * reaching a DIFFERENT database, or a different server, from the one whose
 * posture was just certified. It is NOT a proof of cluster identity: it does
 * not establish a shared system identifier, storage or timeline, and two hosts
 * that genuinely share an address and port (a pooler in front of a failover
 * pair, say) would agree here. Claim the narrow thing.
 *
 * ── WHY A NULL ADDRESS IS A REFUSAL AND NOT A SKIP ──────────────────────────
 *
 * `inet_server_addr()` is NULL over a unix socket. The first version of this
 * function treated a NULL on either side as "not a mismatch" and compared only
 * what it had — which quietly defeats the whole check in the one shape it most
 * needed to catch: an owner on a local socket and an app url reaching a
 * DIFFERENT server whose database happens to carry the same name. Both
 * addresses drop out of the comparison, the names match, and the unsafe remote
 * estate is certified.
 *
 * A check that exists to prevent a FALSE CERTIFICATION cannot treat "I could
 * not tell" as "they agree". Production is TCP on both urls, so an unverifiable
 * pair is a misconfiguration rather than a supported topology, and refusing
 * costs a named error on a deploy that was already wrong.
 *
 * Note what is deliberately NOT compared: hostnames as written in the urls. An
 * alias, a private-endpoint CNAME or a pooler makes two spellings of one server
 * look different, so the SERVER is asked for its own listener instead.
 */
export function identityMismatch(owner: ServerIdentity, app: ServerIdentity): string[] {
  const differences: string[] = []
  if (owner.database !== app.database) {
    differences.push(`database (owner sees '${owner.database}', the app credential reaches '${app.database}')`)
  }
  if (owner.address === null || app.address === null) {
    differences.push(
      `server address could not be compared (owner ${owner.address ?? 'NULL'}, app ${app.address ?? 'NULL'} — a NULL means a unix socket). ` +
        'Both urls must be TCP for the two to be shown to reach the same server, and an unverifiable pair is not a verified one',
    )
  } else if (owner.address !== app.address) {
    differences.push(`server address (owner '${owner.address}', app '${app.address}')`)
  }
  if (owner.port === null || app.port === null) {
    differences.push(`server port could not be compared (owner ${owner.port ?? 'NULL'}, app ${app.port ?? 'NULL'})`)
  } else if (owner.port !== app.port) {
    differences.push(`server port (owner ${owner.port}, app ${app.port})`)
  }
  return differences
}

export interface BindingPrivileges {
  /** `rolsuper` — bypasses RLS UNCONDITIONALLY, `FORCE` included. */
  superuser: boolean
  /** `rolbypassrls` — the attribute whose entire purpose is to skip policies. */
  bypassRls: boolean
  /** Tables in `public` whose OWNER's privileges this role holds, directly or by inheritance. */
  ownedTables: number
}

/**
 * IS THE ROLE ACTUALLY SUBJECT TO RLS? Asked of the APP connection, about
 * itself.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Everything else here checks the ESTATE: are the tables in a state the app can
 * bind to. Nothing checked the ROLE, and the role is half of the sentence. The
 * credential probe accepted on NAME alone (`current_user === tokenscope_app`),
 * so a `tokenscope_app` that is SUPERUSER, carries BYPASSRLS, or inherits the
 * table owner's privileges passed every check and booted with all 40 policies
 * inert — the exact "policies exist and none of them execute" state this whole
 * design exists to end, reported as safe by the gate named for asserting it.
 *
 * MEASURED, not reasoned: with a drifted `tokenscope_app LOGIN BYPASSRLS` and a
 * fully swept estate, the gate exited 0.
 *
 * It is reachable because `provisionAppRole` and `useAppRoleAtRuntime` are
 * deliberately not coupled — a role can be dropped or drift while provisioning
 * is off — so nothing in the boot path necessarily created or corrected the
 * role this runtime is about to use. Provisioning creates it NOINHERIT and
 * without these attributes; this checks that the role you actually got is the
 * role that was designed.
 *
 * The three are not interchangeable. `superuser` and `bypassRls` skip policies
 * even on a FORCEd table, so they are wrong at every phase. OWNERSHIP is closed
 * by `FORCE` — but `FORCE` is what no table has yet, so today an owning role
 * bypasses everything, and a runtime role that owns its tables is not a
 * non-owner lane at all.
 */
export async function readBindingPrivileges(sql: BootDb): Promise<BindingPrivileges> {
  const [row] = await sql<{ superuser: boolean; bypass_rls: boolean; owned: number }[]>`
    SELECT r.rolsuper      AS superuser,
           r.rolbypassrls  AS bypass_rls,
           (SELECT count(*)::int
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relkind IN ('r', 'p')
               AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owned
      FROM pg_roles r
     WHERE r.rolname = current_user
  `
  if (!row) throw new Error('the server returned no role row for current_user')
  return { superuser: row.superuser, bypassRls: row.bypass_rls, ownedTables: row.owned }
}

/** The reasons this role would NOT be bound by the policies; empty when it would. */
export function bypassReasons(p: BindingPrivileges, roleName: string): string[] {
  const reasons: string[] = []
  if (p.superuser) {
    reasons.push(
      `'${roleName}' is a SUPERUSER, which bypasses row-level security unconditionally — FORCE does not bind it either`,
    )
  }
  if (p.bypassRls) {
    reasons.push(
      `'${roleName}' carries BYPASSRLS, the attribute whose whole purpose is to skip policies — FORCE does not bind it either`,
    )
  }
  if (p.ownedTables > 0) {
    reasons.push(
      `'${roleName}' holds the OWNER's privileges on ${p.ownedTables} table(s) in public (directly or by inheritance), and an owner bypasses RLS on every table that is not FORCEd — which today is all of them`,
    )
  }
  return reasons
}

/**
 * Throws {@link refusalMessage} when the app must not bind to the role.
 *
 * ONLY THE POSTURE HALF. The caller still has to establish that the url the
 * runtime will bind reaches the database this posture was read from, so the
 * line below must not announce the whole decision: it ran FIRST, and an
 * unreachable or wrong-database app url would otherwise print "safe to bind"
 * immediately followed by "REFUSING TO START".
 */
export async function assertRuntimeRlsSafe(sql: BootDb): Promise<void> {
  const hazards = bindingHazards(await readPosture(sql))
  if (hasBindingHazard(hazards)) throw new Error(refusalMessage(hazards))
  console.warn(
    `${GATE_TAG} posture is safe: every bootstrap table is DISABLEd and no RLS-enabled table binds the app un-FORCEd. Checking that the runtime url reaches this same database...`,
  )
}

/** Why predicate 1 stops the fleet — one sentence, so both callers say it identically. */
export const BOOTSTRAP_ENABLED_CONSEQUENCE =
  'A non-owner is bound by ENABLE alone, so the bearer lookup and /setup/redeem return zero rows and every device fails to authenticate.'

/** Why predicate 2 is un-vetted enforcement. */
export const UNVETTED_CONSEQUENCE =
  'A non-owner is bound by ENABLE alone, so these filter the app the instant it connects as the role — before any phase has fixed their policy blockers (design §7).'
