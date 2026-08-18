/*
 * drizzle/cutover-rls-sweep.ts — the ONE-TIME cutover step that turns row-level
 * security OFF on the tables no rollout phase has vetted yet, so that pointing
 * the runtime at the non-owner role does not make all 23 RLS-enabled tables
 * start filtering at once.
 *
 * ── WHY THIS IS ITS OWN SCRIPT, WITH ITS OWN OPT-IN ─────────────────────────
 *
 * It used to live inside `drizzle/provision-app-role.ts`, and its TRIGGER was
 * wrong three adversarial rounds running. Each answer was a different shape of
 * the same mistake:
 *
 *   - sweep on EVERY boot → design §7 phase 2 `ENABLE`s + `FORCE`s `org_unit`,
 *     `teammate` and `instance_attestation`, and the bootstrap set was disabled
 *     unconditionally, so the next replica restart undid phase 2 and the
 *     documented rollout could not proceed past phase 1;
 *   - sweep only when this boot CREATEd the role → the role exists on every
 *     environment past its first boot, so the sweep could never fire on one and
 *     the documented version-bump lever was dead code;
 *   - sweep whenever the version ledger is behind → a version bump, or a
 *     restored database whose stamp is old or absent, DISABLEs the very tables
 *     phase 2 had FORCEd, and stamps the destructive result as done.
 *
 * Every answer to "when should PROVISIONING sweep?" was wrong because the
 * QUESTION is wrong. Provisioning creates a role. **The sweep is a cutover — a
 * distinct, deliberate, once-per-environment operation** — and a step that a
 * container restart performs as a side effect cannot be that. So it is a
 * separate script behind a separate flag, and provisioning no longer touches RLS
 * posture at all (it still REPORTS it; it never mutates it).
 *
 * ── THE RULE THAT KILLS ALL FOUR RECURRENCES ────────────────────────────────
 *
 *   **A table that is RLS-ENABLED *and* FORCEd is never disabled BY THIS STEP.**
 *
 * "By this step" is load-bearing and not modesty. A MIGRATION can disable such
 * a table, and shipping one is the documented resolution of the §5-vs-§7
 * conflict below. The guarantee is about what a BOOT SCRIPT does without being
 * asked — the class of change nobody reviewed — not about what the repository
 * can express.
 *
 * `FORCE` is how a phase says "deliberately enabled, hands off" (design §7).
 * Strictly it records POSTURE, not PROVENANCE — a migration or an operator can
 * produce the same conjunction without any phase — which is exactly why the
 * rule is to leave it alone: this step cannot tell who set it, so it treats
 * every instance as deliberate rather than guessing.
 * That rule is UNCONDITIONAL: the ledger decides WHETHER this step sweeps, and
 * this rule decides WHAT it may sweep. The ledger cannot authorise destroying a
 * phase's work, which is exactly the authority the previous design gave it.
 *
 * The rule collides with design §5 in one place, and that collision is REPORTED
 * AND REFUSED rather than silently resolved — see {@link EXIT_SWEEP_CONFLICT}.
 * §5 says the bootstrap tables must be readable before any identity exists (the
 * bearer lookup discovers the teammate FROM `oauth_token`), so the cutover
 * DISABLEs them. §7 says a FORCEd table belongs to a phase. A bootstrap table
 * that is ENABLEd and FORCEd satisfies neither reading, and picking a winner
 * here would either stop the emit fleet or revert a phase — the two failures
 * this whole design exists to avoid. So it names the tables, names both
 * resolutions, changes nothing, and exits 4.
 *
 * ── ENABLE vs FORCE, MEASURED, BECAUSE FOUR SECTIONS OF THE DESIGN GOT IT WRONG
 * `FORCE` binds the table's OWNER. A NON-OWNER is bound by `ENABLE` ALONE. So
 * "not in the FORCE set" is not protection for the app role, and the cutover
 * step is a `DISABLE` sweep rather than a `FORCE` sweep (design §7). The plan is
 * therefore derived from `pg_class.relrowsecurity`, never from a hardcoded list.
 *
 * MEASURED on PostgreSQL 16.13, and it is why the marker is the CONJUNCTION:
 *
 *     fresh                      enabled=false forced=false
 *     after ENABLE               enabled=true  forced=false
 *     after FORCE                enabled=true  forced=true
 *     after DISABLE              enabled=false forced=TRUE   ← FORCE SURVIVES
 *     after re-ENABLE            enabled=true  forced=true   ← and comes back live
 *     FORCE while disabled       enabled=false forced=true   ← representable
 *
 * `relforcerowsecurity` is sticky: a table swept by an older version of this
 * code keeps `forced = true` forever. Reading that flag ALONE would therefore
 * treat swept tables as phase-owned. "A phase turned this on" is
 * `relrowsecurity AND relforcerowsecurity`, and nothing less.
 *
 * ── WHAT A BOOT DOES, IN EACH STATE ─────────────────────────────────────────
 *
 *   no opt-in                     → one log line, exit 0. Nothing read/written.
 *   opted in, ledger CURRENT      → reads the catalog, logs the sweep it WOULD
 *                                   have run and any conflict, changes nothing,
 *                                   exit 0. SAFE TO LEAVE THE FLAG ON.
 *   opted in, ledger BEHIND,
 *     a bootstrap table FORCEd    → CONFLICT: logs both resolutions, changes
 *                                   nothing, does NOT stamp, exit 4.
 *   opted in, ledger BEHIND       → one transaction: lock, re-read under the
 *                                   lock, DISABLE the un-FORCEd enabled tables,
 *                                   stamp `seed_state`. Then verify. Exit 0.
 *
 * RE-RUNNING CONVERGES, IT DOES NOT OSCILLATE. The step only ever moves a table
 * from ENABLED to DISABLED and never back, and once the ledger is stamped it
 * stops moving anything. That is what makes the flag safe to leave set.
 *
 * ── THE LOCK-THEN-RE-READ, WHICH IS THE TOCTOU FIX ──────────────────────────
 * The plan is computed from the catalog, and a phase's `FORCE` landing between
 * that read and the `ALTER` would be silently reverted. So inside the
 * transaction every table the plan touches — plus every bootstrap table,
 * whatever its current posture — is locked `ACCESS EXCLUSIVE` (MEASURED: that is
 * the mode `ALTER TABLE … DISABLE ROW LEVEL SECURITY` takes anyway), the posture
 * is re-read UNDER that lock, and the decision is made from the re-read. A table
 * that became FORCEd in the window is skipped and named; a BOOTSTRAP table that
 * became FORCEd rolls the whole transaction back as a conflict.
 *
 * THE COST, STATED: locking a bootstrap table that is ALREADY disabled buys
 * nothing for the sweep itself, and `teammate` / `oauth_token` are the hottest
 * tables in the estate — other replicas are serving while this boots. It is
 * taken anyway because that is the only way to see a phase FORCEing one inside
 * the window, and the alternative is to catch it in verification AFTER the
 * commit, when the choice has already been made. The transaction carries
 * `lock_timeout` so a busy table fails this step rather than queueing behind it,
 * and the sweep runs a handful of times per environment, not per restart.
 *
 * ── EXIT CODES (entrypoint.sh reads them) ───────────────────────────────────
 *   0  dormant, nothing to do, or swept and verified.
 *   1  the step did not finish and NOTHING WAS COMMITTED. Boot continues and the
 *      next boot genuinely retries.
 *
 *      Note what this does NOT say. The transaction may well have STARTED, and
 *      DDL may have executed inside it — a deadline landing while blocked on
 *      the first table lock is exit 1, and so is a statement that threw
 *      half-way through the ALTERs. Neither survives: every write is in one
 *      transaction, so an open transaction that never commits is rolled back,
 *      and the ledger stamp goes with it. "Never started" was the previous
 *      wording here and it was simply false — the tested exit-1 deadline case
 *      happens INSIDE an open transaction.
 *   4  REFUSED on a §5-vs-§7 conflict. Nothing was changed and nothing was
 *      stamped. Boot continues — refusing is already the safe action, and a boot
 *      loop would strand an environment nobody here can reach (design §9: there
 *      is no DBA and no database access) over a question only a human can
 *      answer.
 *   5  THE LEDGER MAY BE STAMPED, so the next boot will NOT retry. Two states
 *      share this code because they share a recovery and differ only in what we
 *      can prove:
 *        · the transaction COMMITTED and verification then failed;
 *        · the transaction was IN FLIGHT when the deadline fired, so its
 *          outcome is genuinely unknown — a deadline can land while Postgres is
 *          completing the COMMIT, and the client learns nothing.
 *      Either way the ledger may now be current, which sends every later boot
 *      down the report-only branch to exit 0 forever. Recovery is to read the
 *      posture and bump RLS_CUTOVER_SWEEP_VERSION — never a restart.
 *
 *      THIS CODE EXISTS BECAUSE CODE 1's MESSAGE WAS FALSE FOR BOTH. "The next
 *      boot retries" is true only when nothing was written, and a recovery
 *      instruction that is confidently wrong is worse than none at all.
 *
 *   TOKENSCOPE_RLS_CUTOVER_SWEEP=true DATABASE_URL=… tsx drizzle/cutover-rls-sweep.ts
 */
import type postgres from 'postgres'
import { createDbClient } from './connect'
import { bootDdl, pgCode, type BootDb } from './boot-sql'
/*
 * The posture read and the "safe to bind the app role" predicate are SHARED
 * with `drizzle/assert-runtime-rls-safe.ts`. Two copies of this predicate is
 * how the runtime gate and this step could come to disagree about what a safe
 * estate is, which is the one thing they must never do.
 */
import {
  BOOTSTRAP_ENABLED_CONSEQUENCE,
  UNVETTED_CONSEQUENCE,
  bindingHazards,
  readPosture,
  type TablePosture,
} from './rls-binding'
/*
 * From scripts/, NOT server/db/ — the runtime image has no server/ (Dockerfile
 * stage 4) and this runs at BOOT under tsx against raw files.
 * `tests/unit/scripts/boot-path-imports.test.ts` makes that mechanical.
 */
import {
  RLS_BOOTSTRAP_TABLE_NAMES,
  RLS_CUTOVER_SWEEP_SEED_NAME,
  RLS_CUTOVER_SWEEP_VERSION,
  RLS_PROVISION_LOCK_CLASS,
  RLS_CUTOVER_SWEEP_LOCK_KEY,
} from '../scripts/rls-roles'

const TAG = '[cutover-rls-sweep]'
const { assertSafeIdentifier, execDdl } = bootDdl(TAG)

/** See the exit-code block at the top of this file. */
const EXIT_SWEEP_CONFLICT = 4

/*
 * The ledger MAY be stamped — and therefore the failure that will NOT be
 * retried by the next boot.
 *
 * This needs its own code because the generic failure code is reported by
 * `entrypoint.sh` as "the next boot retries", which is true of every OTHER way
 * this script can fail and false of this one: the ledger is stamped inside the
 * same transaction as the DDL, so once that transaction commits, the next boot
 * reads `sweptVersionBefore >= RLS_CUTOVER_SWEEP_VERSION` and takes the
 * report-only branch forever. It logs what it "would have disabled" on every
 * restart and changes nothing, with a zero exit — an unenforced table
 * announcing itself only as a repeating log line nobody is paged by.
 *
 * The recovery is a version bump, not a restart, so the message has to say so.
 */
const EXIT_COMMITTED_THEN_FAILED = 5

/*
 * ── THE STARTUP BUDGET ──────────────────────────────────────────────────────
 * This runs inside `entrypoint.sh`, before Nitro binds, so the container's
 * Startup probe is what kills an overrun — with SIGKILL, which exits 128+N, a
 * code this file's contract does not define. The deadline exists so the step
 * classifies itself and exits with a code the entrypoint understands instead.
 *
 * It is NOT a container-start guarantee: `drizzle/migrate.ts` runs before this
 * with no bound on the migrations themselves, deliberately (interrupting a
 * schema change mid-flight is worse than overrunning a probe). See the same
 * block in `provision-app-role.ts`.
 *
 * 30s, matching `PROVISION_BUDGET_MS`, because the BOUNDED steps must not be
 * able to consume the start window between them.
 *
 * THE SUM IS NOT WRITTEN OUT HERE, and this header is why that rule exists: it
 * carried `pre-flight 30 + provisioning 30 + classifier 10 + this 30 = 100 <
 * 125` for four rounds after the window became 225s and after two more bounded
 * steps existed. `tests/unit/scripts/provision-app-role-contract.test.ts`
 * derives every term from its own source and requires real headroom; read the
 * numbers there, where they cannot go stale.
 *
 * Overridable so a test can prove the deadline actually fires mid-run rather
 * than asserting arithmetic about it — the same shape as
 * `PREFLIGHT_TIMEOUT_MS` in `scripts/preflight.ts`.
 */
const SWEEP_BUDGET_MS = Number(process.env.TOKENSCOPE_RLS_SWEEP_BUDGET_MS) || 30_000
const CONNECT_TIMEOUT_S = 10
const POOL_STATEMENT_TIMEOUT = '10s'
const TX_STATEMENT_TIMEOUT = '15s'
/**
 * `ALTER TABLE … DISABLE ROW LEVEL SECURITY` takes ACCESS EXCLUSIVE (measured),
 * so it queues behind live traffic. Boot must fail this step rather than hold a
 * table hostage — the next boot retries.
 */
const TX_LOCK_TIMEOUT = '5s'
/**
 * How long to wait for the sweep's advisory lock. MEASURED on PostgreSQL 16.13:
 * `lock_timeout` DOES bound `pg_advisory_lock`, so no polling loop is needed.
 */
const LOCK_WAIT = '15s'
/**
 * …and the connection that DOES that wait needs its `statement_timeout` lifted
 * ABOVE the wait, or the shorter bound wins and the message reports a wait that
 * never happened (measured: statement 4s beats lock 15s, cancelling at 4.0s with
 * 57014 instead of 55P03).
 */
const LOCK_WAIT_STATEMENT_TIMEOUT = '20s'

/** Thrown for the §5-vs-§7 collision, so the exit path can answer it with 4. */
class SweepConflictError extends Error {
  readonly tables: string[]
  constructor(tables: string[], when: string) {
    super(conflictMessage(tables, when))
    this.name = 'SweepConflictError'
    this.tables = tables
  }
}

/**
 * …recognised by NAME and through `cause`, not by `instanceof` alone. The
 * conflict can be raised INSIDE `sql.begin`, and a driver that rolls back and
 * rewraps — or a future `Error(…, { cause })` on the way out — would make a bare
 * `instanceof` answer 1 instead of 4 for the one state this exit code exists
 * for. The walk is bounded because a cause chain can be cyclic.
 */
function isSweepConflict(err: unknown): boolean {
  for (let cur = err, hops = 0; cur instanceof Error && hops < 8; cur = cur.cause, hops++) {
    if (cur.name === 'SweepConflictError') return true
  }
  return false
}

function conflictMessage(tables: string[], when: string): string {
  const list = tables.join(', ')
  const first = tables[0]!
  return (
    `${TAG} CONFLICT — REFUSING TO SWEEP (${when}). Nothing was changed and the ledger was NOT stamped.\n` +
    `Bootstrap table(s) ${list} are RLS-ENABLED **and** FORCEd, and the two things that are true of them cannot both be honoured:\n` +
    `  · design §5 — these are read BEFORE any RLS identity can exist (the bearer lookup discovers the teammate FROM oauth_token, joining teammate and org_unit; /setup/redeem reads instance_attestation; the pre-identity paths audit themselves). ` +
    `A non-owner is bound by ENABLE alone, so the cutover must DISABLE them or every device fails to authenticate.\n` +
    `  · design §7 — a table that is ENABLEd and FORCEd was turned on by a rollout phase, and a boot script that reverts one is the defect this step was rewritten to end.\n` +
    `This step will not pick a winner silently. Resolve it deliberately, then re-run.\n` +
    `BOTH resolutions ship as CODE. There is no DBA on this project and no interactive database access: a recovery that begins "connect to Postgres and run" is not executable by anyone here, so neither of these asks you to.\n` +
    `  · if the PHASE is right — the pre-identity reads have been given an identity, so the table no longer has to be readable un-scoped — take it out of RLS_BOOTSTRAP_TABLE_NAMES in scripts/rls-roles.ts (and its entry, with the reason, from RLS_BOOTSTRAP_TABLES in server/db/rls-bootstrap.ts — the drift guard in tests/unit/db/rls-bootstrap-lists-agree.test.ts fails if you change only one) and ship that. ` +
    `tests/integration/db/rls-bootstrap-set.test.ts is what proves each entry is still load-bearing.\n` +
    `  · if the SWEEP is right — the table is still read before any identity exists — undo the phase in a MIGRATION, which is the only door this deployment has: add one to drizzle/migrations/ containing ` +
    `\`ALTER TABLE ${first} NO FORCE ROW LEVEL SECURITY; ALTER TABLE ${first} DISABLE ROW LEVEL SECURITY;\` (and the same for each table named above), then deploy. entrypoint.sh runs migrations before this step, so the next boot sweeps cleanly.\n` +
    `Left as it is, the moment the runtime connects as the non-owner role this table binds the app un-scoped on a path that runs before any identity exists. Which surface breaks depends on which table: oauth_token, teammate or org_unit stops the bearer lookup for every device; instance_attestation makes /setup/redeem 401 a perfectly valid handoff; audit_event rolls back the enrolments that audit themselves — that one is a pre-identity WRITE rather than a read, refused by a policy admitting only global-finops and platform-admin. What they share is running before any identity exists, so none of them can scope itself.`
  )
}

interface SweepPlan {
  /** RLS-ENABLED and NOT FORCEd — nobody has vetted these for the app lane. */
  toDisable: string[]
  /** ENABLED **and** FORCEd outside the bootstrap set: a phase owns these. */
  leftForced: string[]
  /** ENABLED **and** FORCEd INSIDE the bootstrap set: the §5-vs-§7 collision. */
  conflicts: string[]
  /**
   * FORCEd but NOT enabled. Inert today — FORCE binds nobody on a table whose
   * RLS is off — but `relforcerowsecurity` is sticky (measured), so a later bare
   * `ENABLE` binds the OWNER too. Reported so the state is visible; never acted
   * on, because acting on it would be this step inventing a rollout decision.
   */
  forcedButDisabled: string[]
}

/**
 * The whole decision, as a pure function of the catalog. Deliberately free of
 * I/O so the rule that matters — ENABLED **and** FORCEd is never swept — is one
 * readable expression rather than a property of the order some statements ran
 * in.
 */
function planSweep(posture: TablePosture[]): SweepPlan {
  const bootstrap = new Set<string>(RLS_BOOTSTRAP_TABLE_NAMES)
  const plan: SweepPlan = { toDisable: [], leftForced: [], conflicts: [], forcedButDisabled: [] }
  for (const t of posture) {
    if (!t.enabled) {
      if (t.forced) plan.forcedButDisabled.push(t.relname)
      continue
    }
    if (!t.forced) plan.toDisable.push(t.relname)
    else if (bootstrap.has(t.relname)) plan.conflicts.push(t.relname)
    else plan.leftForced.push(t.relname)
  }
  return plan
}

/** The sweep version already applied to this database; 0 = never. */
async function readSweptVersion(sql: BootDb): Promise<number> {
  const [row] = await sql<{ version: number }[]>`
    SELECT version FROM seed_state WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
  `
  return row?.version ?? 0
}

interface Applied {
  disabled: string[]
  /** Planned, but FORCEd by a phase in the window between the plan and the lock. */
  skippedNewlyForced: string[]
}

/**
 * Apply the plan inside one transaction, deciding from a re-read taken UNDER an
 * ACCESS EXCLUSIVE lock rather than from the pre-transaction snapshot.
 *
 * The locked set is the planned tables PLUS every bootstrap table whatever its
 * current posture, so a phase that FORCEs a bootstrap table in the window is
 * caught here and rolls the transaction back instead of being swept away.
 */
async function applySweep(tx: BootDb, plan: SweepPlan): Promise<Applied> {
  const bootstrap = new Set<string>(RLS_BOOTSTRAP_TABLE_NAMES)
  const targets = [...new Set([...plan.toDisable, ...RLS_BOOTSTRAP_TABLE_NAMES])].sort()
  // One order, so two replicas cannot deadlock against each other. (They are
  // already serialised by the advisory lock; this costs nothing and does not
  // rely on that staying true.)
  for (const relname of targets) {
    await execDdl(tx, 'LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', [relname])
  }

  const under = await readPosture(tx)
  const byName = new Map(under.map((t) => [t.relname, t]))
  const conflicts = targets.filter((t) => bootstrap.has(t) && byName.get(t)?.enabled && byName.get(t)?.forced)
  if (conflicts.length > 0) throw new SweepConflictError(conflicts, 'found under the lock, mid-sweep')

  const disabled: string[] = []
  const skippedNewlyForced: string[] = []
  for (const relname of plan.toDisable) {
    const now = byName.get(relname)
    if (!now?.enabled) continue // somebody else disabled it in the window
    if (now.forced) {
      skippedNewlyForced.push(relname)
      continue
    }
    await execDdl(tx, 'ALTER TABLE %I DISABLE ROW LEVEL SECURITY', [relname])
    disabled.push(relname)
  }
  return { disabled, skippedNewlyForced }
}

/**
 * Read back what THIS RUN did. Fatal, unlike the posture line
 * `provision-app-role.ts` prints: that one describes state the rollout owns,
 * this one certifies work this process just committed.
 */
async function verify(sql: BootDb): Promise<void> {
  const { bootstrapStillEnabled, bindingUnvetted } = bindingHazards(await readPosture(sql))
  if (bootstrapStillEnabled.length > 0) {
    throw new Error(
      `${TAG} verification failed: RLS is still ENABLED on ${bootstrapStillEnabled.join(', ')}. ` +
        BOOTSTRAP_ENABLED_CONSEQUENCE,
    )
  }
  if (bindingUnvetted.length > 0) {
    throw new Error(
      `${TAG} verification failed: RLS is ENABLED but not FORCEd on ${bindingUnvetted.join(', ')}. ` +
        UNVETTED_CONSEQUENCE,
    )
  }
  console.warn(
    `${TAG} verified: no RLS-enabled table binds the app un-FORCEd, and every bootstrap table is DISABLEd.`,
  )
}

function describePlan(plan: SweepPlan): string {
  const bootstrap = new Set<string>(RLS_BOOTSTRAP_TABLE_NAMES)
  const bootstrapNamed = plan.toDisable.filter((t) => bootstrap.has(t))
  const otherNamed = plan.toDisable.filter((t) => !bootstrap.has(t))
  // The bootstrap subset is named separately even though it is one sweep: it is
  // load-bearing for a DIFFERENT reason (pre-identity reads, §5), and an
  // operator checking §9's step 0 is looking for exactly these names.
  return (
    `bootstrap set (${bootstrapNamed.length}/${RLS_BOOTSTRAP_TABLE_NAMES.length}): ${
      bootstrapNamed.join(', ') || 'none (already disabled)'
    }; others: ${otherNamed.join(', ') || 'none'}`
  )
}

function reportContext(plan: SweepPlan): void {
  console.warn(`${TAG} left ENABLED because a phase FORCEd them: ${plan.leftForced.join(', ') || 'none'}.`)
  if (plan.forcedButDisabled.length > 0) {
    console.warn(
      `${TAG} FORCEd but DISABLED (inert — FORCE binds nobody while RLS is off — but the flag is sticky, so a bare ENABLE would bind the OWNER too): ${plan.forcedButDisabled.join(
        ', ',
      )}.`,
    )
  }
}

/**
 * What the run had actually DONE when it failed. Reported rather than assumed —
 * "nothing was committed" is exact before the commit and false after it, and the
 * deadline can fire while Postgres is completing the COMMIT, when neither
 * sentence is honest.
 */
const progress = { txStarted: false, writesIssued: false, committed: false, verified: false, disabled: 0 }

function progressLine(): string {
  if (progress.committed) {
    return `the transaction COMMITTED: RLS was disabled on ${progress.disabled} table(s) and the ledger was stamped.`
  }
  if (progress.writesIssued) {
    return 'every write had been ISSUED and only the COMMIT was outstanding, so the OUTCOME IS UNKNOWN — it may or may not have committed. Read the RLS posture (/api/v1/admin/diagnostics/rls-posture) before assuming either way.'
  }
  if (progress.txStarted) {
    return 'the transaction was open but had NOT issued its writes, so nothing was committed — an open transaction that never returns is rolled back when this process exits.'
  }
  return 'nothing was committed — every write is in one transaction and it had not started.'
}

/**
 * The one transaction, plus the bookkeeping that keeps {@link progressLine}
 * honest.
 *
 * `txStarted` means "OPEN, AND ITS OUTCOME HAS NOT BEEN OBSERVED", which is
 * narrower than "a transaction was issued": when `sql.begin` REJECTS, postgres.js
 * has already run the ROLLBACK, so "unknown" would be a worse answer than the
 * true one — and the in-transaction CONFLICT rejects, which is the message an
 * operator reads most. The only genuinely unknown state is the deadline landing
 * while the COMMIT is in flight.
 */
async function commitSweep(sql: postgres.Sql<Record<string, unknown>>, plan: SweepPlan): Promise<Applied> {
  progress.txStarted = true
  try {
    return await sql.begin(async (tx) => {
      // Bound the DDL: every ALTER here takes ACCESS EXCLUSIVE and two replicas
      // booting at once will queue. SET LOCAL, so the bounds die with the
      // transaction.
      await tx.unsafe(`SET LOCAL statement_timeout = '${TX_STATEMENT_TIMEOUT}'`)
      await tx.unsafe(`SET LOCAL lock_timeout = '${TX_LOCK_TIMEOUT}'`)
      const result = await applySweep(tx, plan)
      // GREATEST keeps a recorded version from going backwards if this ever runs
      // from an older image mid-rollout.
      await tx`
        INSERT INTO seed_state (name, version, applied_at)
        VALUES (${RLS_CUTOVER_SWEEP_SEED_NAME}, ${RLS_CUTOVER_SWEEP_VERSION}, now())
        ON CONFLICT (name) DO UPDATE
          SET version = GREATEST(seed_state.version, EXCLUDED.version),
              applied_at = EXCLUDED.applied_at
      `
      /*
       * EVERY write is now issued and only the COMMIT is outstanding. THIS, and
       * not `txStarted`, is the line past which "nothing was written" stops
       * being true — `txStarted` is set before `sql.begin()` even acquires a
       * connection, so using it to pick the exit code sent an operator to bump
       * a version after a deadline that landed while locking the first table,
       * when a plain retry would have worked.
       */
      progress.writesIssued = true
      return result
    })
  } catch (err) {
    /*
     * postgres.js has already run the ROLLBACK by the time `sql.begin` rejects,
     * so nothing survived — both flags go back to false and the run reports
     * "nothing was committed", which is exact.
     */
    progress.txStarted = false
    progress.writesIssued = false
    throw err
  }
}

async function run(url: string): Promise<void> {
  // max: 2 — one connection is RESERVED to hold the session advisory lock and
  // the transaction needs the other. A session lock cannot ride the pool: it
  // belongs to one backend, and postgres.js is free to hand the next query to a
  // different one.
  const sql = createDbClient(url, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: CONNECT_TIMEOUT_S,
    connection: { statement_timeout: POOL_STATEMENT_TIMEOUT },
  })
  let lock: Awaited<ReturnType<typeof sql.reserve>> | undefined
  try {
    lock = await sql.reserve()
    await lock.unsafe(`SET lock_timeout = '${LOCK_WAIT}'`)
    await lock.unsafe(`SET statement_timeout = '${LOCK_WAIT_STATEMENT_TIMEOUT}'`)
    try {
      await lock`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_CUTOVER_SWEEP_LOCK_KEY}::int)`
    } catch (err) {
      throw new Error(
        `${TAG} another replica holds the cutover-sweep lock and did not release it within ${LOCK_WAIT}${
          pgCode(err) ? ` [SQLSTATE ${pgCode(err)}]` : ''
        }. Nothing was read or written; the next boot retries.`,
        { cause: err },
      )
    }
    await lock.unsafe(`SET statement_timeout = '${POOL_STATEMENT_TIMEOUT}'`)

    const posture = await readPosture(sql)
    const present = new Set(posture.map((t) => t.relname))
    const missing = RLS_BOOTSTRAP_TABLE_NAMES.filter((t) => !present.has(t))
    if (missing.length > 0) {
      throw new Error(
        `${TAG} bootstrap table(s) ${missing.join(
          ', ',
        )} do not exist. Migrations run immediately before this step and are fatal, so a missing bootstrap table means the schema is not what RLS_BOOTSTRAP_TABLES describes — refusing to sweep an estate this step does not recognise.`,
      )
    }

    const plan = planSweep(posture)
    const sweptVersionBefore = await readSweptVersion(sql)

    if (sweptVersionBefore >= RLS_CUTOVER_SWEEP_VERSION) {
      /*
       * NOT a to-do list. Once the sweep is stamped the rollout's phases own RLS
       * state (design §7); this line exists to make that state visible in the
       * boot log, never to be acted on by the next restart.
       */
      console.warn(
        `${TAG} NOT re-run — seed_state '${RLS_CUTOVER_SWEEP_SEED_NAME}' is already at v${sweptVersionBefore} (code v${RLS_CUTOVER_SWEEP_VERSION}) and the rollout owns RLS state from here. ` +
          `Would have disabled ${plan.toDisable.length} table(s): ${plan.toDisable.join(', ') || 'none'}. Changed nothing.`,
      )
      reportContext(plan)
      if (plan.conflicts.length > 0) {
        // Loud, but not a refusal: nothing was asked of this run, so there is no
        // decision to refuse. The state still has to be visible.
        console.error(
          `${TAG} CONFLICT PRESENT (reported, not acted on — the ledger is current so this run swept nothing): ` +
            `bootstrap table(s) ${plan.conflicts.join(
              ', ',
            )} are RLS-ENABLED and FORCEd. A non-owner is bound by ENABLE alone, so the bearer lookup returns zero rows for every device the moment the runtime connects as the role. ` +
            `Bumping RLS_CUTOVER_SWEEP_VERSION without resolving this will make the next boot refuse (exit ${EXIT_SWEEP_CONFLICT}).`,
        )
      }
      return
    }

    if (plan.conflicts.length > 0) throw new SweepConflictError(plan.conflicts, 'read before the transaction')

    const applied = await commitSweep(sql, plan)

    /*
     * EVERYTHING PAST THE COMMIT IS INSIDE THIS GUARD. A throw while FORMATTING
     * a report about a database that has already been changed must not be
     * reported as "nothing was committed" — the exact defect the sibling script
     * shipped once.
     */
    try {
      progress.committed = true
      progress.txStarted = false
      progress.disabled = applied.disabled.length
      console.warn(
        `${TAG} APPLIED (seed_state '${RLS_CUTOVER_SWEEP_SEED_NAME}' v${sweptVersionBefore} → v${RLS_CUTOVER_SWEEP_VERSION}). ` +
          `RLS disabled on ${applied.disabled.length} table(s) — ${describePlan({ ...plan, toDisable: applied.disabled })}.`,
      )
      if (applied.skippedNewlyForced.length > 0) {
        console.warn(
          `${TAG} skipped ${applied.skippedNewlyForced.join(
            ', ',
          )} — FORCEd by a phase between the plan and the lock, so the rollout owns them. This step never disables a FORCEd table.`,
        )
      }
      reportContext(plan)
      await verify(sql)
      /*
       * THE WORK IS DONE AND PROVEN. Everything after this point is cleanup —
       * releasing the advisory lock and closing the pool — and the deadline can
       * still fire during it. Without this flag such a run took exit 5 and told
       * the operator to read the posture and bump the version, for a sweep that
       * had committed AND verified. "The recovery is a version bump" is only
       * true when something is unresolved.
       */
      progress.verified = true
    } catch (err) {
      throw new Error(`${TAG} the run COMMITTED and then failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  } finally {
    if (lock) {
      await lock`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_CUTOVER_SWEEP_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      lock.release()
    }
    /*
     * `.catch`, because an error thrown by the teardown REPLACES the error
     * propagating out of the try — including a SweepConflictError, which would
     * silently downgrade exit 4 to exit 1 and lose both resolutions from the
     * log. The sibling gate already guarded its own `end()`; this one did not.
     */
    await sql.end({ timeout: 5 }).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  if (process.env.TOKENSCOPE_RLS_CUTOVER_SWEEP !== 'true') {
    console.warn(
      `${TAG} dormant — set TOKENSCOPE_RLS_CUTOVER_SWEEP=true to run the one-time cutover DISABLE sweep (docs/design/rls-enforcement.md §7, §9 step 0). Nothing was read or written.`,
    )
    return
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(`${TAG} TOKENSCOPE_RLS_CUTOVER_SWEEP=true but DATABASE_URL is not set — nothing to sweep`)
  }
  for (const table of RLS_BOOTSTRAP_TABLE_NAMES) assertSafeIdentifier(table, 'bootstrap table')

  /*
   * THE DEADLINE, as a RACE rather than a `process.exit` inside a timer. An exit
   * from a timer callback skips the `finally` above AND the exit path below, so
   * the run could not report what it had done. Losing the race rejects, and the
   * ordinary exit path answers it — one place where "what happened" is decided.
   */
  let deadline: NodeJS.Timeout | undefined
  const budget = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      reject(
        new Error(
          `${TAG} BUDGET EXCEEDED: the sweep did not finish within ${
            SWEEP_BUDGET_MS / 1000
          }s and was stopped so it could exit with a code entrypoint.sh understands, rather than being SIGKILLed by the platform's start probe. Boot continues; the line below says whether the next boot retries — this message cannot know, because the deadline can land either side of the COMMIT.`,
        ),
      )
    }, SWEEP_BUDGET_MS)
  })
  try {
    await Promise.race([run(url), budget])
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  console.error(`${TAG} ${progressLine()}`)
  if (isSweepConflict(err)) process.exit(EXIT_SWEEP_CONFLICT)
  /*
   * `writesIssued`, NOT `txStarted`. `progress.committed` is set only after
   * `sql.begin()` resolves, so a deadline landing while Postgres completes the
   * COMMIT leaves a transaction that may well have committed — exit 1 would
   * then make exactly the false "the next boot retries" claim exit 5 exists to
   * stop.
   *
   * But `txStarted` is the WRONG widening, and it was the first attempt: it is
   * set before `sql.begin()` acquires a connection, so a deadline during the
   * connect or the first LOCK — with no DDL issued and no ledger row written —
   * also took exit 5 and sent the operator to bump a version when a plain
   * retry would have worked. That is the same defect pointing the other way.
   *
   * `writesIssued` is the real boundary: set inside the transaction once the
   * last write returns, so the only thing outstanding is the COMMIT itself.
   * Before it, a rollback is guaranteed and exit 1 is exact; at or after it,
   * the outcome is genuinely unknowable from here and we do not pretend
   * otherwise.
   */
  /*
   * A run that COMMITTED and VERIFIED did its job; only its cleanup was
   * interrupted. Exiting non-zero here would send an operator to resolve a
   * cutover that is already complete and correct.
   */
  if (progress.verified) {
    console.error(
      `${TAG} the sweep COMMITTED and VERIFIED before this failure, so the cutover itself is complete — only the cleanup after it did not finish. Nothing to resolve; the next boot reports and changes nothing.`,
    )
    process.exit(0)
  }
  if (progress.committed || progress.writesIssued) {
    console.error(
      `${TAG} THE LEDGER MAY BE STAMPED, SO DO NOT ASSUME THE NEXT BOOT RETRIES. ` +
        (progress.committed
          ? `The transaction COMMITTED, so seed_state '${RLS_CUTOVER_SWEEP_SEED_NAME}' is at v${RLS_CUTOVER_SWEEP_VERSION} and every later boot takes the report-only branch and exits 0.`
          : `Every write had been ISSUED and only the COMMIT was outstanding, so it may or may not have committed — a deadline can land while Postgres is finishing the COMMIT, and the client is told nothing either way.`) +
        ' Read the posture (/api/v1/admin/diagnostics/rls-posture), resolve what the lines above name, then bump RLS_CUTOVER_SWEEP_VERSION in scripts/rls-roles.ts and ship it — a restart alone changes nothing.',
    )
    process.exit(EXIT_COMMITTED_THEN_FAILED)
  }
  process.exit(1)
})
