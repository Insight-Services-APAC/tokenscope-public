// @vitest-environment node
/*
 * THE STRUCTURAL HALF OF THE CUTOVER SWEEP'S CONTRACT.
 *
 * The behaviour is proven against a real Postgres in
 * `tests/integration/db/cutover-rls-sweep.test.ts`. What CANNOT be proven there
 * is the shape of the thing — that the sweep is one script with one opt-in, that
 * the FORCE rule is unconditional rather than a branch some ledger can bypass,
 * and that nothing has quietly grown a second RLS-mutating path. That is what
 * kept going wrong: the sweep's trigger was wrong three adversarial rounds
 * running, and each fix was a new predicate rather than a change of shape.
 *
 * A grep is the right instrument for a shape. It goes red on the recurrence,
 * which a behavioural test written against the current design cannot.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const sweep = readFileSync(resolve(ROOT, 'drizzle/cutover-rls-sweep.ts'), 'utf8')
const provision = readFileSync(resolve(ROOT, 'drizzle/provision-app-role.ts'), 'utf8')
const binding = readFileSync(resolve(ROOT, 'drizzle/rls-binding.ts'), 'utf8')
const gate = readFileSync(resolve(ROOT, 'drizzle/assert-runtime-rls-safe.ts'), 'utf8')

describe('the sweep is one script with one opt-in', () => {
  it('is dormant unless its OWN flag is set — not provisioning’s, not a ledger’s', () => {
    expect(sweep).toContain("process.env.TOKENSCOPE_RLS_CUTOVER_SWEEP !== 'true'")
    expect(sweep, 'the provisioning opt-in must not gate the sweep').not.toContain('TOKENSCOPE_PROVISION_APP_ROLE')
    expect(sweep, 'nor the password, which the sweep has no use for').not.toContain('TOKENSCOPE_APP_DB_PASSWORD')
  })

  it('is the ONLY script in the boot path that changes RLS posture', () => {
    const rlsDdl = /ALTER TABLE[^\n]*ROW LEVEL SECURITY/i
    const codeLines = (src: string): string[] =>
      src
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .filter((line) => rlsDdl.test(line))
    expect(codeLines(sweep).length, 'the sweep issues exactly one kind of RLS statement').toBeGreaterThan(0)
    expect(codeLines(provision), 'provisioning creates a role and nothing else').toEqual([])
  })

  it('only ever DISABLEs — it can never enable or force, so re-running converges', () => {
    const enabling = sweep
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .filter((line) => /ALTER TABLE[^\n]*(ENABLE|FORCE) ROW LEVEL SECURITY/i.test(line))
      // `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` is not an ALTER; `NO FORCE`
      // appears only inside the refusal message an operator is told to run.
      .filter((line) => !line.includes('conflictMessage') && !line.includes('NO FORCE'))
    expect(
      enabling,
      'a step that can enable as well as disable can oscillate; this one is monotone, which is what makes the flag safe to leave on',
    ).toEqual([])
  })
})

describe('the FORCE rule is unconditional', () => {
  /*
   * THE RULE THAT KILLS ALL FOUR RECURRENCES: a table that is ENABLED **and**
   * FORCEd is never disabled. It is expressed as a pure function of the catalog
   * — one readable predicate — precisely so it cannot become a property of the
   * order some statements happened to run in, which is what it was when a ledger
   * could authorise reverting a phase.
   */
  it('is one predicate over the catalog, not a branch inside the apply loop', () => {
    const plan = sweep.slice(sweep.indexOf('function planSweep('), sweep.indexOf('/** The sweep version already'))
    expect(plan, 'FORCEd tables never enter toDisable').toContain('if (!t.forced) plan.toDisable.push(t.relname)')
    expect(plan, 'a FORCEd bootstrap table is the conflict, not a sweep target').toContain(
      'else if (bootstrap.has(t.relname)) plan.conflicts.push(t.relname)',
    )
    expect(plan, 'and a FORCEd table outside the set belongs to a phase').toContain(
      'else plan.leftForced.push(t.relname)',
    )
    expect(plan, 'the ledger has no say in WHAT may be swept').not.toContain('VERSION')
  })

  /*
   * "A phase turned this on" is the CONJUNCTION, and that is measured rather
   * than assumed. MEASURED on PostgreSQL 16.13: `relforcerowsecurity` SURVIVES
   * `ALTER TABLE … DISABLE ROW LEVEL SECURITY` and comes back live on a later
   * bare `ENABLE`. So a table swept by an older build keeps `forced = true`
   * forever, and a predicate reading that flag alone would call every swept
   * table phase-owned.
   */
  it('reads relrowsecurity AND relforcerowsecurity, because FORCE is sticky', () => {
    // The read itself moved to drizzle/rls-binding.ts when the boot gate began
    // sharing it; the measurement that JUSTIFIES reading both stays here, where
    // the sweep's rule is argued.
    expect(binding).toContain('c.relrowsecurity      AS enabled')
    expect(binding).toContain('c.relforcerowsecurity AS forced')
    expect(sweep, 'the measurement is recorded where the next person will read it').toContain('FORCE SURVIVES')
  })

  /*
   * The sweep and the runtime gate must never disagree about what a safe estate
   * is, so they share ONE predicate rather than two that happen to match. This
   * pins that: `verify()` derives its offender lists from `bindingHazards`, and
   * the sweep no longer carries a second copy of either the query or the rule.
   */
  it('shares the binding predicate with the runtime gate instead of copying it', () => {
    expect(sweep).toContain("from './rls-binding'")
    expect(sweep, 'verify() uses the shared predicate').toContain(
      'const { bootstrapStillEnabled, bindingUnvetted } = bindingHazards(await readPosture(sql))',
    )
    expect(sweep, 'no second posture query in the sweep').not.toContain('FROM pg_class c JOIN pg_namespace n')
    expect(gate, 'the gate calls the shared assertion rather than re-deriving it').toContain(
      'assertRuntimeRlsSafe',
    )
  })

  it('re-reads the posture UNDER the lock before acting, so a phase cannot lose a race', () => {
    const apply = sweep.slice(sweep.indexOf('async function applySweep('), sweep.indexOf('async function verify('))
    const lockAt = apply.indexOf('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE')
    const rereadAt = apply.indexOf('const under = await readPosture(tx)')
    const alterAt = apply.indexOf('ALTER TABLE %I DISABLE ROW LEVEL SECURITY')
    expect(lockAt, 'the plan is locked first').toBeGreaterThan(-1)
    expect(rereadAt, 'then re-read').toBeGreaterThan(lockAt)
    expect(alterAt, 'and only then applied').toBeGreaterThan(rereadAt)
    expect(apply, 'the locked set includes every bootstrap table, whatever its current posture').toContain(
      '...RLS_BOOTSTRAP_TABLE_NAMES',
    )
  })
})

describe('the conflict is refused, not resolved', () => {
  it('exits 4 and says so, rather than picking a winner between §5 and §7', () => {
    expect(sweep).toContain('const EXIT_SWEEP_CONFLICT = 4')
    expect(sweep).toContain('process.exit(EXIT_SWEEP_CONFLICT)')
    // Both resolutions, because naming only one IS picking a winner.
    expect(sweep, 'the §5 resolution').toContain('RLS_BOOTSTRAP_TABLE_NAMES in scripts/rls-roles.ts')
    expect(sweep, 'the §7 resolution').toContain('NO FORCE ROW LEVEL SECURITY')
    /*
     * The recovery has to be executable by someone who has this repo and
     * nothing else. Bare SQL is not: there is no DBA on this project and no
     * interactive database access, so "run this ALTER" strands the environment
     * until somebody independently works out that it must be shipped.
     */
    expect(sweep, 'the §7 resolution ships as a migration, not as SQL to run by hand').toContain(
      'drizzle/migrations/',
    )
  })

  it('never stamps the ledger on the path that refused', () => {
    /*
     * The PRE-TRANSACTION refusal throws before `commitSweep` is ever called, so
     * the stamp is unreachable from it — asserted by the call ordering inside
     * `run`, because the stamp itself lives one function away.
     */
    const run = sweep.slice(sweep.indexOf('async function run('), sweep.indexOf('async function main('))
    const conflictThrow = run.indexOf('if (plan.conflicts.length > 0) throw new SweepConflictError')
    const commit = run.indexOf('await commitSweep(sql, plan)')
    expect(conflictThrow, 'the pre-transaction refusal').toBeGreaterThan(-1)
    expect(commit, 'the only path to the stamp').toBeGreaterThan(conflictThrow)
    // …and the IN-TRANSACTION one rolls the stamp back with everything else,
    // because both live in the same `sql.begin`.
    const commitBody = sweep.slice(sweep.indexOf('async function commitSweep('), sweep.indexOf('async function run('))
    expect(commitBody, 'the stamp is inside the transaction').toContain('INSERT INTO seed_state')
    expect(commitBody, 'and so is the apply that can raise the conflict').toContain('await applySweep(tx, plan)')
    expect(sweep.slice(sweep.indexOf('async function applySweep('))).toContain('throw new SweepConflictError(conflicts')
  })

  /*
   * `instanceof` is not enough: the conflict can be raised INSIDE `sql.begin`,
   * and a driver that rolls back and rewraps would turn the one exit code this
   * state exists for into a plain 1.
   */
  it('recognises the conflict through a cause chain, not by instanceof alone', () => {
    expect(sweep).toContain('function isSweepConflict(')
    expect(sweep).toContain('if (isSweepConflict(err)) process.exit(EXIT_SWEEP_CONFLICT)')
    expect(sweep, 'a cause chain can be cyclic').toMatch(/hops < \d+/)
  })
})

describe('the deadline reaches the exit path', () => {
  it('rejects a race rather than exiting from inside the timer', () => {
    const budgetBlock = sweep.slice(sweep.indexOf('const budget = new Promise'), sweep.indexOf('await Promise.race'))
    expect(budgetBlock).toContain('reject(')
    expect(budgetBlock, 'exiting from a timer skips the finally and the conflict classification').not.toContain(
      'process.exit',
    )
  })

  it('can say "the outcome is unknown" for a deadline that lands mid-COMMIT', () => {
    expect(sweep).toContain('progress.txStarted = true')
    expect(sweep).toContain('OUTCOME IS UNKNOWN')
  })

  /*
   * …and "in flight" must mean "outcome NOT OBSERVED". A rejected `sql.begin`
   * has already rolled back, and the in-transaction CONFLICT rejects — so
   * reporting that as unknown would put a hedge on the one message an operator
   * reads most.
   */
  it('clears the in-flight flag as soon as the transaction settles, either way', () => {
    const body = sweep.slice(sweep.indexOf('async function commitSweep('), sweep.indexOf('async function run('))
    expect(body).toContain('progress.txStarted = true')

    /*
     * A rejection means ROLLBACK, which is a KNOWN outcome — so BOTH flags go
     * back to false. `writesIssued` matters most: it is the one the exit code
     * reads, and leaving it set after a rejection would report "the ledger may
     * be stamped" for a transaction postgres.js had already rolled back.
     */
    const catchBlock = body.slice(body.indexOf('} catch (err) {'))
    expect(catchBlock, 'the in-flight flag clears on rejection').toContain('progress.txStarted = false')
    expect(catchBlock, 'and so does the one the exit code reads').toContain('progress.writesIssued = false')

    /*
     * `writesIssued` is set INSIDE the transaction callback, after the ledger
     * INSERT and before the callback returns — i.e. at the one instant when
     * every write has landed and only the COMMIT is outstanding. Set it any
     * earlier (as `txStarted` is) and a deadline while acquiring the connection
     * or locking the first table reports a possibly-stamped ledger for a run
     * that wrote nothing.
     */
    const txBody = body.slice(body.indexOf('sql.begin('), body.indexOf('} catch (err) {'))
    expect(txBody, 'the flag lives inside the transaction').toContain('progress.writesIssued = true')
    expect(
      txBody.indexOf('seed_state'),
      'and is set AFTER the ledger write, which is the last one',
    ).toBeLessThan(txBody.indexOf('progress.writesIssued = true'))

    const guard = sweep.slice(sweep.indexOf('progress.committed = true'))
    expect(guard.indexOf('progress.txStarted = false')).toBeGreaterThan(-1)
    expect(guard.indexOf('progress.txStarted = false')).toBeLessThan(guard.indexOf('progress.disabled ='))
  })
})
