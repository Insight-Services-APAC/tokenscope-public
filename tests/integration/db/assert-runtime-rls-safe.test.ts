/*
 * drizzle/assert-runtime-rls-safe.ts, run as entrypoint.sh runs it.
 *
 * ── THE HOLE THIS GATE CLOSES, AND WHY IT NEEDS A REAL DATABASE ─────────────
 *
 * The cutover is three independent Bicep flags and their ORDER is load-bearing.
 * Until this gate, that order was enforced by a comment: `useAppRoleAtRuntime`
 * emits `TOKENSCOPE_APP_DATABASE_URL` on its own flag, with no dependency on
 * the sweep having run. Set it alone and the app boots as a non-owner against a
 * schema where `oauth_token` is still RLS-ENABLED — and `ENABLE` alone binds a
 * non-owner, so the bearer lookup that DISCOVERS the teammate returns zero rows
 * for every device on the fleet while the deploy reports healthy.
 *
 * WHAT THIS FILE PROVES, STATED EXACTLY. It exercises the gate's CLASSIFICATION
 * of real catalog state and its contract with the shell — the opt-in, the exit
 * codes and the log. It does NOT re-prove that a non-owner is bound by `ENABLE`
 * alone: that is `tests/integration/db/cutover-rls-sweep.test.ts`, which mints
 * a real non-owner login role and reads through it. An earlier version of this
 * header claimed the fleet-stop was asserted "directly" here with "a real
 * non-owner login role", which was false — every case runs the gate against
 * catalog state, and the app url it is handed is the same connection string.
 * The one case that DOES distinguish the two urls is the mismatch case below.
 *
 * The child-process shape is the same contract argument as the sweep's own test
 * file: the exit code and the log ARE the surface entrypoint.sh consumes, and an
 * imported function skips both.
 *
 * Properties held here:
 *   1. DORMANT with no TOKENSCOPE_APP_DATABASE_URL — no connection, so an
 *      unrelated deploy cannot be made slower or more fragile by this file.
 *   2. REFUSES while a bootstrap table is still ENABLEd (design §5), and the
 *      refusal is non-zero so the shell aborts the boot.
 *   3. REFUSES while any table is ENABLED-but-not-FORCEd (design §7).
 *   4. PASSES on a swept estate, and passes with a phase's ENABLE+FORCE in
 *      place — it refuses UN-VETTED enforcement, never DELIBERATE enforcement.
 *   5. Refuses rather than skipping when it cannot check at all.
 *   6. REFUSES when the two urls reach DIFFERENT databases — otherwise the gate
 *      certifies an estate the runtime never touches, which is a false
 *      guarantee rather than a weak one.
 *   7. Its own deadline fires and refuses, rather than hanging into the
 *      platform's startup probe where it would report as a different fault.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { RLS_BOOTSTRAP_TABLE_NAMES } from '../../../scripts/rls-roles'

const REPO_ROOT = resolve(__dirname, '../../..')

/** A git worktree has no node_modules of its own — walk up for the real tsx. */
function resolveTsx(): string {
  for (let dir = REPO_ROOT; ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'node_modules/.bin/tsx')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) throw new Error('tsx not found — entrypoint.sh runs the script with it')
  }
}
const TSX_BIN = resolveTsx()

/** Refused: the runtime was asked to bind to the role and the estate is not ready. */
const EXIT_UNSAFE = 6

let t: TestDb

interface RunResult {
  code: number
  out: string
}

/** Spawn the gate exactly as entrypoint.sh does, with a controlled env. */
function runGate(env: Record<string, string>): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    execFile(
      process.execPath,
      [TSX_BIN, 'drizzle/assert-runtime-rls-safe.ts'],
      {
        cwd: REPO_ROOT,
        // NOT process.env: an ambient DATABASE_URL would make these cases lie.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        const raw = err ? (err as { code?: number | string }).code : 0
        done({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout}${stderr}` })
      },
    )
  })
}

/** Every table DISABLEd — the state a completed sweep leaves behind. */
async function sweepAll(): Promise<void> {
  const rows = await t.client<{ relname: string }[]>`
    SELECT c.relname::text AS relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  `
  for (const r of rows) {
    await t.client.unsafe(`ALTER TABLE "${r.relname}" NO FORCE ROW LEVEL SECURITY`)
    await t.client.unsafe(`ALTER TABLE "${r.relname}" DISABLE ROW LEVEL SECURITY`)
  }
}

/**
 * A credential shaped like the real runtime one: LOGIN, no SUPERUSER, no
 * BYPASSRLS, not a member of the table owner.
 *
 * The pass-path cases used to hand the gate `t.url` — the testcontainers
 * SUPERUSER and table owner — as the app url. They passed only because nothing
 * looked at the role, which is exactly the defect this file now covers: the
 * gate certified any credential that authenticated. Testing the happy path with
 * a credential the gate must REFUSE is not testing the happy path.
 */
const APP_ROLE = 'gate_app_role'
const APP_PW = '9a1e-gate-app'

function appUrl(): string {
  const u = new URL(t.url)
  u.username = APP_ROLE
  u.password = APP_PW
  return u.toString()
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}'`)
  await t.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`)
  await t.client.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('the runtime binding gate', () => {
  it('is DORMANT and opens no connection when the runtime is not bound to the role', async () => {
    /*
     * The URL is deliberately unreachable. If the gate connected despite having
     * no TOKENSCOPE_APP_DATABASE_URL, this would fail rather than pass quietly
     * — which is the whole claim: a deploy that is not doing the cutover pays
     * nothing and cannot be broken by this step.
     */
    const r = await runGate({ DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none' })
    expect(r.code, 'dormant is a clean exit').toBe(0)
    expect(r.out).toContain('dormant')
    expect(r.out, 'and it says it read nothing').toContain('Nothing read')
  })

  it('REFUSES while a bootstrap table is still RLS-ENABLED — design §5', async () => {
    await sweepAll()
    const victim = RLS_BOOTSTRAP_TABLE_NAMES[0]!
    await t.client.unsafe(`ALTER TABLE "${victim}" ENABLE ROW LEVEL SECURITY`)

    const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: appUrl() })
    expect(r.code, 'non-zero, so entrypoint.sh aborts the boot').toBe(EXIT_UNSAFE)
    expect(r.out).toContain('REFUSING TO START')
    expect(r.out).toContain(victim)
    expect(r.out, 'names the consequence, not just the state').toContain('fails to authenticate')
    expect(r.out, 'and a recovery').toContain('runRlsCutoverSweep')

    await t.client.unsafe(`ALTER TABLE "${victim}" DISABLE ROW LEVEL SECURITY`)
  })

  it('REFUSES while any table is ENABLED but not FORCEd — design §7', async () => {
    await sweepAll()
    await t.client.unsafe(`ALTER TABLE "allocation" ENABLE ROW LEVEL SECURITY`)

    const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: appUrl() })
    expect(r.code).toBe(EXIT_UNSAFE)
    expect(r.out).toContain('REFUSING TO START')
    expect(r.out).toContain('allocation')
    expect(r.out).toContain('design §7')

    await t.client.unsafe(`ALTER TABLE "allocation" DISABLE ROW LEVEL SECURITY`)
  })

  it('PASSES on a swept estate', async () => {
    await sweepAll()
    const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: appUrl() })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('posture is safe')
    /*
     * The line that means the WHOLE decision passed. The posture line prints
     * first and is only half of it — asserting on that alone would pass for a
     * run that went on to refuse on a wrong-database url.
     */
    expect(r.out, 'the identity half must also have confirmed').toContain('both urls agree')
  })

  it("PASSES with a phase's ENABLE+FORCE in place — it refuses UN-VETTED enforcement, not deliberate enforcement", async () => {
    /*
     * The distinction the whole branch turns on. A rollout phase says
     * "deliberately on, hands off" with FORCE; a gate that refused on any
     * enabled table would make the documented rollout impossible to complete,
     * which is the same shape of mistake as the sweep undoing phase 2.
     */
    await sweepAll()
    await t.client.unsafe(`ALTER TABLE "allocation" ENABLE ROW LEVEL SECURITY`)
    await t.client.unsafe(`ALTER TABLE "allocation" FORCE ROW LEVEL SECURITY`)

    const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: appUrl() })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('posture is safe')
    expect(r.out).toContain('both urls agree')

    await t.client.unsafe(`ALTER TABLE "allocation" NO FORCE ROW LEVEL SECURITY`)
    await t.client.unsafe(`ALTER TABLE "allocation" DISABLE ROW LEVEL SECURITY`)
  })

  it('REFUSES when the app url reaches a DIFFERENT database from the one it certified', async () => {
    /*
     * The hole the identity check closes. The posture read must run on the
     * OWNER url, but Nitro binds the APP url — and they are separate Key Vault
     * secrets rewritten by separate paths. After a restore or a server
     * replacement, an old app database can still be reachable and still
     * authenticate, so the gate would certify the NEW swept database while the
     * runtime binds the OLD unswept one: the original outage with a green
     * check in front of it.
     *
     * `postgres` always exists on the server, so it stands in for "some other
     * database on a server this credential can still reach".
     */
    await sweepAll()
    const otherDb = appUrl().replace(/\/[^/?]+(\?|$)/, '/postgres$1')
    expect(otherDb, 'the fixture must actually name a different database').not.toBe(appUrl())

    const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: otherDb })
    expect(r.code, r.out).toBe(EXIT_UNSAFE)
    expect(r.out).toContain('REFUSING TO START')
    expect(r.out, 'it must name WHICH url disagrees, not just that one does').toContain('DIFFERENT database')
    expect(r.out).toContain('postgres')
  })

  it('REFUSES when the app url cannot be queried at all — the url Nitro is about to bind', async () => {
    await sweepAll()
    const unreachable = 'postgres://nobody:nobody@127.0.0.1:1/none'
    const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: unreachable })
    expect(r.code, r.out).toBe(EXIT_UNSAFE)
    expect(r.out).toContain('could not be queried')
    /*
     * AND IT MUST NOT HAVE CLAIMED SUCCESS FIRST. The posture check runs before
     * the identity check, so an early line announcing the whole decision would
     * print "safe to bind" and then "REFUSING TO START" — the operator reads
     * the first one. The posture line now says only what it checked.
     */
    expect(r.out, 'a refusal must not be preceded by a success claim').not.toContain('safe to bind')
    expect(r.out).not.toContain('both urls agree')
  })

  it('its own deadline REFUSES rather than hanging into the startup probe', async () => {
    /*
     * A gate that hangs converts a misconfiguration into a startup-probe
     * timeout, which reports as a different fault entirely — so the budget has
     * to end in the gate's own exit code, not in a SIGKILL.
     */
    await sweepAll()
    const r = await runGate({
      DATABASE_URL: t.url,
      TOKENSCOPE_APP_DATABASE_URL: t.url,
      TOKENSCOPE_RLS_GATE_BUDGET_MS: '1',
    })
    expect(r.code, r.out).toBe(EXIT_UNSAFE)
    expect(r.out).toContain('did not finish within')
    expect(r.out, 'an unchecked precondition is not a passed one').toContain('not a passed one')
  })

  /*
   * ── THE ROLE MUST BE SUBJECT TO THE POLICIES ──────────────────────────────
   *
   * Every other case here asks about the ESTATE. These ask about the ROLE, and
   * the gate did not: the credential probe accepted on NAME alone, so a
   * `tokenscope_app` carrying BYPASSRLS passed the whole gate (measured: exit
   * 0) and the runtime bound with all 40 policies inert — the exact state this
   * enablement exists to end, certified by the step named for asserting it.
   *
   * Reachable because `provisionAppRole` and `useAppRoleAtRuntime` are
   * deliberately uncoupled, so nothing in the boot path necessarily created the
   * role the runtime is about to use.
   */
  for (const attr of ['BYPASSRLS', 'SUPERUSER'] as const) {
    it(`REFUSES a runtime role with ${attr} — it authenticates, but no policy binds it`, async () => {
      await sweepAll()
      const role = `drifted_${attr.toLowerCase()}`
      await t.client.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' ${attr}`)
      try {
        await t.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
        const u = new URL(t.url)
        u.username = role
        u.password = 'pw'

        const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: u.toString() })
        expect(r.code, `a role no policy binds must not be certified.\n${r.out}`).toBe(EXIT_UNSAFE)
        expect(r.out).toContain('NOT SUBJECT')
        expect(r.out, 'it must name the attribute, not just refuse').toContain(attr)
        expect(r.out, 'and why it matters at every phase').toContain('FORCE does not bind it either')
      } finally {
        await t.client.unsafe(`REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => undefined)
        await t.client.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
      }
    })
  }

  it('REFUSES a runtime role that holds the table OWNER\'s privileges', async () => {
    /*
     * Ownership is the third bypass and the one FORCE closes — but FORCE is
     * what no table has yet, so today an owning role bypasses everything. A
     * runtime role that owns its tables is not a non-owner lane at all.
     */
    await sweepAll()
    const [owner] = await t.client<{ o: string }[]>`
      SELECT pg_get_userbyid(c.relowner)::text AS o
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' LIMIT 1
    `
    await t.client.unsafe(`CREATE ROLE drifted_owner LOGIN PASSWORD 'pw' IN ROLE "${owner!.o}"`)
    try {
      const u = new URL(t.url)
      u.username = 'drifted_owner'
      u.password = 'pw'

      const r = await runGate({ DATABASE_URL: t.url, TOKENSCOPE_APP_DATABASE_URL: u.toString() })
      expect(r.code, `an owning role bypasses every un-FORCEd table.\n${r.out}`).toBe(EXIT_UNSAFE)
      expect(r.out).toContain('NOT SUBJECT')
      expect(r.out).toContain("holds the OWNER's privileges")
    } finally {
      await t.client.unsafe(`DROP ROLE IF EXISTS drifted_owner`).catch(() => undefined)
    }
  })

  it('REFUSES rather than skipping when it cannot check at all', async () => {
    // The runtime is bound to the role but there is no owner URL to read the
    // catalog with. An unchecked precondition is not a passed one.
    const r = await runGate({ TOKENSCOPE_APP_DATABASE_URL: t.url })
    expect(r.code).toBe(EXIT_UNSAFE)
    expect(r.out).toContain('cannot be checked')
  })
})
