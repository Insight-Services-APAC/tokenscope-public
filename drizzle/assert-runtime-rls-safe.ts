/*
 * drizzle/assert-runtime-rls-safe.ts — the boot gate that refuses to start the
 * server when binding it to the non-owner role would break it.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 *
 * The cutover is three independent Bicep flags: `provisionAppRole` creates the
 * role, `runRlsCutoverSweep` disables the tables no phase has vetted, and
 * `useAppRoleAtRuntime` points the runtime pools at the role. Their ORDER is
 * load-bearing, and until this file it was enforced by a comment in the param
 * block. Set `useAppRoleAtRuntime` alone — a plausible one-line apply, since
 * the other two are the ones that "do something" — and the app comes up as the
 * non-owner against a schema where `oauth_token` is still RLS-ENABLED. The
 * bearer lookup discovers the teammate FROM that table, so it returns zero rows
 * for every device on the fleet, /setup/redeem 500s every enrolment, and the
 * deploy reports healthy throughout. That is the exact outage this whole branch
 * exists to prevent, reachable by the one flag that sounds like the safe one.
 *
 * ── WHY IT IS FATAL, AND WHY THAT IS THE SAFE DIRECTION ─────────────────────
 *
 * Refusing to boot is not the cautious half of this trade — it is the cheap
 * half. A refusal fails the revision, Container Apps keeps the previous
 * revision serving, and the operator gets a named reason. Booting anyway keeps
 * a green deploy that silently stops the entire emit fleet, which is the
 * failure mode nobody notices until the data is missing.
 *
 * The gate is scoped so it can only ever fire on a deliberate cutover:
 *
 *   - `TOKENSCOPE_APP_DATABASE_URL` unset → DORMANT. No connection, no query,
 *     no cost. Every deploy that is not doing the cutover — which is all of
 *     them today — is untouched, and cannot be made slower or more fragile by
 *     this file.
 *   - Set → the operator has asked for the runtime to bind to the role, so the
 *     precondition for that request is checked before it is honoured.
 *
 * This is also what makes the sweep's exit 4 safe to keep NON-fatal. Refusing
 * to sweep is the right answer when the owner still connects (nothing is
 * broken, and a boot loop would strand an environment nobody here can reach).
 * It stops being the right answer only when the runtime is about to bind — and
 * that is precisely when this gate is armed.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not read the sweep's ledger. The ledger records that a step RAN; this
 * gate asks whether the DATABASE is in a state the app can bind to, which is
 * the question that actually matters and is true or false independently of who
 * made it so — a hand-shipped migration, an older image, or the sweep. Gating
 * on the stamp would refuse a correctly-prepared estate whose stamp is missing
 * and accept a stamped one that has since drifted.
 *
 * ── WHAT THE PASS ACTUALLY MEANS, EXACTLY ───────────────────────────────────
 *
 * "Refuses if the schema is not ready" is the shape of the guarantee, not its
 * precise extent, and the difference matters to anyone relying on it:
 *
 *   - IT IS ONE SNAPSHOT. The posture is read once, before Nitro starts. A
 *     phase, a migration or an operator changing RLS between that read and the
 *     server binding is not seen. Nothing at boot can close that window; the
 *     gate makes the ORDERING of the cutover flags safe, not the whole
 *     lifetime of the process.
 *   - A BOOTSTRAP TABLE THAT DOES NOT EXIST IS NOT A HAZARD HERE. Predicate 1
 *     asks whether a bootstrap table is ENABLEd; a missing one is simply
 *     absent from the catalog and passes. The sweep is what refuses on a
 *     schema it does not recognise; migrations run before both and are fatal.
 *   - THE IDENTITY CHECK RULES OUT A DIFFERENT DATABASE, NOT A DIFFERENT
 *     CLUSTER. It compares what each server reports about itself; two hosts
 *     genuinely sharing a database name, listener address and port — a pooler
 *     in front of a failover pair, say — agree here. It closes the
 *     wrong-database case, which is the one that was reachable.
 *   - PARTITIONS ARE READ AS THEMSELVES. A child of an ENABLE+FORCEd parent is
 *     born unprotected and this gate reports it as un-enabled, which is true of
 *     the child and says nothing about the parent's phase (design §7).
 *
 * AND IT IS A PROPERTY OF THE CONTAINER, NOT OF THE PROCESS. It runs from
 * `entrypoint.sh`, so it covers every deployed start. It does NOT cover
 * `npm run dev` or `npm run preview`, which start Nitro directly: set
 * `TOKENSCOPE_APP_DATABASE_URL` in a local shell against an unswept database
 * and `getDb()` will bind to the app role with nothing consulted. That is
 * stated rather than fixed on purpose — a developer's machine has no app role
 * to bind to, the blast radius is one confusing local session, and putting a
 * database round-trip in the server's own startup path would buy that with a
 * new failure mode on every boot. Say "the deployed runtime", never "the
 * runtime".
 */
import { createDbClient } from './connect'
import type { BootDb } from './boot-sql'
import {
  GATE_TAG as TAG,
  assertRuntimeRlsSafe,
  bypassReasons,
  identityMismatch,
  readBindingPrivileges,
  readServerIdentity,
} from './rls-binding'

/** Refused: the runtime was asked to bind to the role and the estate is not ready. */
const EXIT_UNSAFE = 6

const CONNECT_TIMEOUT_S = 10
const STATEMENT_TIMEOUT = '10s'

/**
 * Bounded like every other boot step. A gate that can hang is a gate that
 * converts a misconfiguration into a startup-probe timeout, which reports as a
 * different fault entirely.
 *
 * IT COVERS THREE SERIAL ROUND TRIPS, not one: the posture read on the owner
 * connection, the owner's identity, and the app connection's identity — the
 * last of which includes establishing a second connection. At 10s a healthy but
 * slow estate spending 4s + 3s + 4s would be fatally refused with every
 * individual timeout still satisfied, which is the false-refusal failure this
 * whole gate has to avoid being. The per-operation bounds (CONNECT_TIMEOUT_S,
 * STATEMENT_TIMEOUT) are what stop any single step hanging; this is the total,
 * and it is sized for the sum rather than for one of the terms.
 */
const GATE_BUDGET_MS = Number(process.env.TOKENSCOPE_RLS_GATE_BUDGET_MS) || 25_000

async function main(): Promise<void> {
  const configured = process.env.TOKENSCOPE_APP_DATABASE_URL?.trim()
  if (!configured) {
    console.warn(
      `${TAG} dormant — TOKENSCOPE_APP_DATABASE_URL is unset, so the runtime connects as the owner and no binding precondition applies. Nothing read.`,
    )
    return
  }
  /*
   * The OWNER's URL on purpose. The question is what the TABLES look like, and
   * the owner can see every one of them; probing as the app role would ask the
   * table set through the very filtering this gate exists to detect.
   */
  const ownerUrl = process.env.DATABASE_URL?.trim()
  if (!ownerUrl) {
    throw new Error(
      `${TAG} TOKENSCOPE_APP_DATABASE_URL is set but DATABASE_URL is not, so the binding precondition cannot be checked. Refusing to start rather than binding the runtime to the role unchecked.`,
    )
  }

  const opts = {
    max: 1,
    idle_timeout: 5,
    connect_timeout: CONNECT_TIMEOUT_S,
    connection: { TimeZone: 'UTC', statement_timeout: STATEMENT_TIMEOUT },
  } as const
  const sql = createDbClient(ownerUrl, opts)
  const appSql = createDbClient(configured, opts)
  let budget: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      checkBinding(sql, appSql),
      new Promise<never>((_resolve, reject) => {
        budget = setTimeout(
          () =>
            reject(
              new Error(
                `${TAG} the binding check did not finish within ${GATE_BUDGET_MS / 1000}s. Refusing to start: an unchecked precondition is not a passed one.`,
              ),
            ),
          GATE_BUDGET_MS,
        )
      }),
    ])
  } finally {
    if (budget) clearTimeout(budget)
    await Promise.all([
      sql.end({ timeout: 5 }).catch(() => undefined),
      appSql.end({ timeout: 5 }).catch(() => undefined),
    ])
  }
}

/**
 * The two halves, in order: the estate must be safe AND it must be the estate
 * the runtime will actually reach.
 *
 * ── WHY THE SECOND HALF EXISTS ──────────────────────────────────────────────
 *
 * The posture read has to run on the OWNER url — the owner sees every table,
 * where probing as the app role would ask the table set through the very
 * filtering this gate exists to detect. But NITRO binds the APP url, and until
 * this check nothing in the boot path required those two to name the same
 * database. They are separate Key Vault secrets, rewritten by separate paths:
 * the owner url is re-derived on an infrastructure apply while the app url is
 * deliberately retained unless the password-writing path runs. After a server
 * restore or replacement, an old app database can still be reachable and still
 * authenticate as the app role — so the gate would certify the NEW, swept
 * database and Nitro would then bind to the OLD, unswept one, which is the
 * original outage with an extra step in front of it.
 *
 * Certifying a database nobody is going to use is not a weaker guarantee than
 * having no gate; it is a FALSE one, which is worse.
 */
async function checkBinding(sql: BootDb, appSql: BootDb): Promise<void> {
  await assertRuntimeRlsSafe(sql)

  const owner = await readServerIdentity(sql)
  let app: Awaited<ReturnType<typeof readServerIdentity>>
  try {
    app = await readServerIdentity(appSql)
  } catch (err) {
    /*
     * The app credential cannot even answer. Nitro is about to bind to exactly
     * this url, so this is a certain failure rather than a risk — refusing is
     * the same call as everywhere else in this file. The credential CLASSIFIER
     * in provision-app-role.ts is what names the cause (auth, missing database,
     * unreachable); this only has to decline to certify.
     */
    throw new Error(
      `${TAG} REFUSING TO START — the posture is safe, but TOKENSCOPE_APP_DATABASE_URL could not be queried, and that is the url Nitro is about to bind to. ` +
        `Certifying the owner's view of a database the runtime cannot reach would be a false guarantee. Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  /*
   * THE ROLE MUST ACTUALLY BE BOUND BY THE POLICIES — checked BEFORE the
   * identity match is accepted, because a role that bypasses RLS makes the
   * whole cutover a no-op no matter which database it reaches. This is the half
   * the gate was missing: everything else asks about the ESTATE, and a
   * `tokenscope_app` carrying BYPASSRLS passed all of it (measured: exit 0)
   * while every one of the 40 policies stayed inert.
   */
  const bypasses = bypassReasons(await readBindingPrivileges(appSql), app.user)
  if (bypasses.length > 0) {
    throw new Error(
      `${TAG} REFUSING TO START — the runtime credential authenticates, but the role it authenticates as is NOT SUBJECT to row-level security:\n` +
        bypasses.map((r) => `  · ${r}`).join('\n') +
        '\nBinding to it would report a successful cutover and leave every policy inert — the exact state this enablement exists to end. ' +
        'Provisioning creates the role without these attributes; a role that has them was created or altered outside it. Fix the role, then re-deploy.',
    )
  }

  const differences = identityMismatch(owner, app)
  if (differences.length > 0) {
    throw new Error(
      `${TAG} REFUSING TO START — the posture was checked on DATABASE_URL, but TOKENSCOPE_APP_DATABASE_URL reaches a DIFFERENT database: ${differences.join('; ')}. ` +
        'The gate would be certifying an estate the runtime never touches. Point both at the same server and database, then re-deploy.',
    )
  }
  console.warn(
    `${TAG} both urls agree on database name, listener address and port ('${owner.database}' at ${owner.address}:${owner.port}) — the owner connecting as '${owner.user}', the runtime as '${app.user}'. ` +
      'Each server was asked separately, so this is agreement between two answers rather than one atomic observation; it rules out the wrong-database case and is not a proof of cluster identity. ' +
      'The runtime role is neither SUPERUSER nor BYPASSRLS and owns no table in public, so the policies will actually bind it.',
  )
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(EXIT_UNSAFE)
  })
