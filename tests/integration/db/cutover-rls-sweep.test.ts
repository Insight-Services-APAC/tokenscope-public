/*
 * drizzle/cutover-rls-sweep.ts, run as entrypoint.sh runs it.
 *
 * WHY A CHILD PROCESS AND NOT AN IMPORTED FUNCTION. What has to be true of this
 * script is a CONTRACT WITH `entrypoint.sh`: the opt-in gate, the exit codes and
 * the log are the entire surface the shell sees, and an imported function skips
 * all three. So every case below spawns the real command line.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * The sweep lived inside `drizzle/provision-app-role.ts` and its TRIGGER was
 * wrong three adversarial rounds running:
 *
 *   round 2  sweep on EVERY boot            → design §7 phase 2 ENABLEs+FORCEs
 *                                             org_unit/teammate/instance_attestation,
 *                                             and the next replica restart undid it.
 *   round 3  sweep only when this boot
 *            CREATEd the role               → never true past an environment's
 *                                             first boot, so the documented
 *                                             version-bump lever was dead code.
 *   round 4  sweep on the ledger alone      → a version bump, or a restored
 *                                             database with an old/absent stamp,
 *                                             DISABLEd the tables phase 2 had
 *                                             FORCEd — and stamped the result.
 *
 * The fix is not a fourth predicate. It is that **the ledger decides WHETHER to
 * sweep and never WHAT may be swept**: a table that is ENABLEd *and* FORCEd is a
 * phase's deliberate work and is never disabled, on any path, for any ledger
 * state. `SWEEPS AGAIN after a version bump` and `REFUSES rather than reverting
 * a FORCEd bootstrap table` below are the two halves of that, and the second is
 * round 4's defect executed directly.
 *
 * The properties this file exists to hold:
 *   1. DORMANT unless its own flag is set, and safe to leave set: re-running
 *      converges rather than oscillating.
 *   2. IT IS THE CUTOVER. Before it, a non-owner's pre-identity bearer read
 *      returns ZERO rows; after it, the real row.
 *   3. IT NEVER DISABLES A FORCEd TABLE.
 *   4. A FORCEd BOOTSTRAP TABLE IS A CONFLICT: reported loudly, refused, nothing
 *      changed, nothing stamped, exit 4.
 *   5. IT DECIDES UNDER THE LOCK, so a FORCE landing between the plan and the
 *      ALTER is honoured rather than silently reverted.
 *   6. BOUNDED, and its deadline reports honestly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  RLS_BOOTSTRAP_TABLE_NAMES,
  RLS_CUTOVER_SWEEP_SEED_NAME,
  RLS_CUTOVER_SWEEP_VERSION,
  RLS_PROVISION_LOCK_CLASS,
  RLS_PROVISION_LOCK_KEY,
  RLS_CUTOVER_SWEEP_LOCK_KEY,
} from '../../../scripts/rls-roles'

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

const sfx = randomUUID().replace(/-/g, '').slice(0, 10)
/** A REAL non-owner login role: the only thing RLS binds without FORCE. */
const READER = `sweep_reader_${sfx}`
const READER_PW = '9a1e-sweep-reader'

// Real uuids (v4 nibbles) — z.uuid() elsewhere in this codebase rejects a
// convenient 0000-…-0001, so the fixtures keep the same shape.
const TEAMMATE_ID = '9a1e0000-0000-4000-8000-000000000201'

let t: TestDb
let accessHash = ''

interface RunResult {
  code: number
  out: string
}

/** Spawn the script exactly as entrypoint.sh does, with a controlled env. */
function runSweep(env: Record<string, string>): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    execFile(
      process.execPath,
      [TSX_BIN, 'drizzle/cutover-rls-sweep.ts'],
      {
        cwd: REPO_ROOT,
        // NOT process.env: an ambient DATABASE_URL or opt-in would make these
        // cases lie in either direction.
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

/** `(relrowsecurity, relforcerowsecurity)` for every ordinary table in public. */
async function posture(): Promise<Map<string, { enabled: boolean; forced: boolean }>> {
  const rows = await t.client<{ relname: string; enabled: boolean; forced: boolean }[]>`
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `
  return new Map(rows.map((r) => [r.relname, { enabled: r.enabled, forced: r.forced }]))
}

async function ledgerVersion(): Promise<number | undefined> {
  const [row] = await t.client<{ version: number }[]>`
    SELECT version FROM seed_state WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
  `
  return row?.version
}

/** A context-less connection AS the fixture non-owner — like a cold request. */
function readerClient(): postgres.Sql {
  const u = new URL(t.url)
  u.username = encodeURIComponent(READER)
  u.password = encodeURIComponent(READER_PW)
  return postgres(u.toString(), { max: 1, idle_timeout: 5, connection: { TimeZone: 'UTC' } })
}

/** The real pre-identity bearer read: oauth_token ⋈ teammate ⋈ org_unit. */
async function bearerRowsAsReader(): Promise<number> {
  const app = readerClient()
  try {
    const rows = await app`
      SELECT tok.teammate_id
        FROM oauth_token tok
        JOIN teammate tm ON tm.id = tok.teammate_id
        JOIN org_unit ou ON ou.id = tm.org_unit_id
       WHERE tok.access_token_hash = ${accessHash}
       LIMIT 1
    `
    return rows.length
  } finally {
    await app.end({ timeout: 5 }).catch(() => undefined)
  }
}

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: 'sw-cutover', displayName: 'Sweep' }).returning()
  const [unit] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'swCutover',
      code: 'default',
      displayName: 'Sweep (default)',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  await t.db.insert(schema.teammate).values({
    id: TEAMMATE_ID,
    entraOid: 'oid-cutover-sweep',
    email: 'sweep@x.test',
    displayName: 'Sweep Dev',
    regionId: region!.id,
    orgUnitId: unit!.id,
    role: 'developer',
  })
  const [client] = await t.db
    .insert(schema.oauthClient)
    .values({
      clientSecretHash: 'csh-sweep',
      clientName: 'sweep',
      redirectUris: ['http://127.0.0.1:7778/callback'],
    })
    .returning()
  accessHash = 'sweep-access-hash'
  const now = Date.now()
  await t.db.insert(schema.oauthToken).values({
    accessTokenHash: accessHash,
    refreshTokenHash: 'sweep-refresh-hash',
    clientId: client!.clientId,
    teammateId: TEAMMATE_ID,
    scope: 'tokenscope.emit',
    accessIssuedAt: new Date(now),
    accessExpiresAt: new Date(now + 3_600_000),
    refreshIssuedAt: new Date(now),
    refreshExpiresAt: new Date(now + 86_400_000),
  })

  /*
   * A GENUINE NON-OWNER. Per design §1 the non-owner is the operative part: RLS
   * binds it as soon as a table has RLS ENABLEd, with no FORCE involved. The
   * default testcontainers user is a SUPERUSER and bypasses RLS unconditionally,
   * so a harness using it would pass every case below vacuously.
   */
  await t.client.unsafe(`
    CREATE ROLE ${READER} LOGIN PASSWORD '${READER_PW}' NOINHERIT;
    GRANT USAGE ON SCHEMA public TO ${READER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${READER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${READER};
  `)
}, 180_000)

afterAll(async () => {
  await t.client.unsafe(`DROP OWNED BY ${READER}`).catch(() => undefined)
  await t.client.unsafe(`DROP ROLE IF EXISTS ${READER}`).catch(() => undefined)
  await stopTestDb(t)
})

describe('dormant unless its own flag is set', () => {
  it('the migrations left every bootstrap table RLS-ENABLED (otherwise nothing below proves anything)', async () => {
    const before = await posture()
    for (const table of RLS_BOOTSTRAP_TABLE_NAMES) {
      expect(before.get(table)?.enabled, `${table} should start RLS-enabled`).toBe(true)
    }
  })

  const dormantCases: Array<[string, Record<string, string>]> = [
    ['no flag at all', {}],
    ['the flag set to something other than true', { TOKENSCOPE_RLS_CUTOVER_SWEEP: '1' }],
    // The PROVISIONING opt-in must not reach this step: that conflation is the
    // whole reason this script exists.
    ['the provisioning opt-in instead of its own', { TOKENSCOPE_PROVISION_APP_ROLE: 'true' }],
  ]

  it.each(dormantCases)('with %s it exits 0, says so, and touches nothing', async (_label, env) => {
    const before = await posture()
    const r = await runSweep({ DATABASE_URL: t.url, ...env })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('dormant')
    expect(await posture()).toEqual(before)
    expect(await ledgerVersion(), 'a dormant run must not stamp').toBeUndefined()
  })

  it('opted in with no DATABASE_URL it fails loudly instead of pretending', async () => {
    const r = await runSweep({ TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('DATABASE_URL')
  })
})

describe('the sweep IS the cutover', () => {
  let sweepOut = ''

  it('BEFORE it, a non-owner cannot run the pre-identity bearer read at all', async () => {
    // The fleet-stop, executed. Not "the policy would filter" — zero rows, from
    // the real join, as a real non-owner, with no GUCs.
    expect(await bearerRowsAsReader(), 'RLS is ENABLEd on oauth_token/teammate/org_unit').toBe(0)
  })

  it('disables RLS on EVERY RLS-enabled table, not just the bootstrap set', async () => {
    const before = await posture()
    const enabledBefore = [...before].filter(([, p]) => p.enabled).map(([n]) => n)
    // Non-vacuity: there must be non-bootstrap RLS tables to move, or a
    // bootstrap-only sweep would satisfy this too.
    const bootstrap = new Set<string>(RLS_BOOTSTRAP_TABLE_NAMES)
    const nonBootstrap = enabledBefore.filter((n) => !bootstrap.has(n))
    expect(nonBootstrap.length).toBeGreaterThan(0)
    expect(nonBootstrap, 'inbox_item_self has no admin arm, so it breaks at cutover, not at phase 2').toContain(
      'inbox_item',
    )

    const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    sweepOut = r.out
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('APPLIED')
    expect(r.out).toContain('verified')

    const after = await posture()
    const stillEnabled = [...after].filter(([, p]) => p.enabled).map(([n]) => n)
    expect(stillEnabled, 'nothing may still bind a non-owner after the cutover sweep').toEqual([])
  })

  it('AFTER it, the same read returns the real row — that is the whole point', async () => {
    expect(await bearerRowsAsReader()).toBe(1)
  })

  it('names the bootstrap subset explicitly — it is load-bearing for a different reason (§5)', () => {
    expect(sweepOut).toContain('bootstrap set')
    for (const table of RLS_BOOTSTRAP_TABLE_NAMES) expect(sweepOut).toContain(table)
    expect(sweepOut).toMatch(/left ENABLED because a phase FORCEd them/)
  })

  it('records it in seed_state, the run-once ledger the org-structure seed uses', async () => {
    expect(await ledgerVersion()).toBe(RLS_CUTOVER_SWEEP_VERSION)
  })

  /*
   * SAFE TO LEAVE THE FLAG ON. The step only ever moves a table from ENABLED to
   * DISABLED and never back, and once stamped it stops moving anything — so a
   * restart converges rather than oscillating.
   */
  it('a second run with the flag still on changes nothing and says what it would have done', async () => {
    const before = await posture()
    const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('NOT re-run')
    expect(r.out).toContain('Changed nothing')
    expect(await posture()).toEqual(before)
  })
})

describe('a FORCEd table is a phase’s work, and the sweep never takes it back', () => {
  afterAll(async () => {
    await t.client
      .unsafe(
        `ALTER TABLE cou_owner NO FORCE ROW LEVEL SECURITY;
         ALTER TABLE cou_owner DISABLE ROW LEVEL SECURITY;
         ALTER TABLE allocation DISABLE ROW LEVEL SECURITY;`,
      )
      .catch(() => undefined)
    await t.client`
      UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
    `
  })

  it('a stamped ledger leaves a phase’s ENABLE+FORCE and an operator’s bare ENABLE alone', async () => {
    await t.client.unsafe(`
      ALTER TABLE cou_owner ENABLE ROW LEVEL SECURITY;
      ALTER TABLE cou_owner FORCE ROW LEVEL SECURITY;
      ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;
    `)
    const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('NOT re-run')
    expect(r.out, 'the plan is still computed and logged, so the state is visible').toContain(
      'Would have disabled 1 table(s): allocation',
    )
    expect(r.out).toContain('left ENABLED because a phase FORCEd them: cou_owner')

    const after = await posture()
    expect(after.get('cou_owner')?.enabled, 'phase 1 FORCEd this').toBe(true)
    expect(after.get('allocation')?.enabled, 'and a stamped ledger is not this script’s to act on').toBe(true)
  })

  /*
   * ── ROUND 4'S DEFECT, EXECUTED ────────────────────────────────────────────
   *
   * A version bump is the DOCUMENTED repair for the mixed-revision window, so it
   * must actually sweep. Under the previous design it also DISABLEd whatever a
   * phase had FORCEd, because the ledger was the whole gate. Here the ledger
   * decides WHETHER, and the FORCE rule decides WHAT — so the bump sweeps the
   * unvetted table and leaves the phase's alone, in the same run.
   */
  it('SWEEPS again after a version bump — and STILL will not touch the FORCEd table', async () => {
    await t.client.unsafe(`
      CREATE TABLE late_migration_rls (id bigserial PRIMARY KEY, note text);
      ALTER TABLE late_migration_rls ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON late_migration_rls TO ${READER};
    `)
    try {
      // Non-vacuity: the phase's table and an unvetted one are both really on.
      const before = await posture()
      expect(before.get('cou_owner')).toEqual({ enabled: true, forced: true })
      expect(before.get('allocation')).toEqual({ enabled: true, forced: false })
      expect(before.get('late_migration_rls')?.enabled).toBe(true)

      // The state a bump creates: the stamp falls one version behind the code.
      await t.client`
        UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION - 1} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
      `
      const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('APPLIED')
      expect(r.out).toContain(`v${RLS_CUTOVER_SWEEP_VERSION - 1} → v${RLS_CUTOVER_SWEEP_VERSION}`)

      const after = await posture()
      expect(after.get('late_migration_rls')?.enabled, 'the repair for the mixed-revision window must work').toBe(false)
      expect(after.get('allocation')?.enabled, 'an unvetted table is swept by a bump').toBe(false)
      expect(
        after.get('cou_owner'),
        'THE FIX: a bump may not revert a phase. The ledger decides WHETHER, not WHAT.',
      ).toEqual({ enabled: true, forced: true })
    } finally {
      await t.client.unsafe('DROP TABLE IF EXISTS late_migration_rls').catch(() => undefined)
    }
  })

  /*
   * ── EXIT 5: THE LEDGER MAY BE STAMPED, SO THE NEXT BOOT WILL NOT RETRY ────
   *
   * The one failure mode whose recovery is NOT a restart. Everything the sweep
   * writes — the DDL and the `seed_state` stamp — is in one transaction, so a
   * failure BEFORE the commit leaves nothing behind and the next boot genuinely
   * retries. Once that transaction commits, the stamp is current, and every
   * later boot takes the report-only branch and exits 0 forever. A verification
   * failure after the commit therefore needs its own exit code, because exit
   * 1's entrypoint message ("the next boot retries") is FALSE here — and a
   * confidently wrong recovery instruction is worse than none.
   *
   * TRIGGERING IT DETERMINISTICALLY. `verify()` re-reads the catalog after the
   * commit, so the failure needs a table to become ENABLED-but-un-FORCEd in the
   * window between the plan and that re-read. An event trigger on
   * `ddl_command_end` does it exactly: the sweep's own `ALTER TABLE … DISABLE`
   * fires it, it enables RLS on a sentinel the plan never saw, the transaction
   * commits, and the post-commit verification then finds the sentinel binding
   * the app un-vetted. No sleeps, no races.
   */
  it('exits 5 — not 1 — when the transaction COMMITTED and verification then failed', async () => {
    /*
     * This test brings its OWN work rather than relying on a stock table still
     * being enabled: earlier cases in this file sweep those, so depending on
     * one would make the case order-dependent. The event trigger is created
     * LAST, after the setup's own ALTERs, or it would fire on them.
     */
    await t.client.unsafe(`
      CREATE TABLE post_commit_work (id bigserial PRIMARY KEY);
      ALTER TABLE post_commit_work ENABLE ROW LEVEL SECURITY;
      CREATE TABLE post_commit_sentinel (id bigserial PRIMARY KEY);
      CREATE FUNCTION enable_sentinel_rls() RETURNS event_trigger AS $$
      BEGIN
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'post_commit_sentinel') THEN
          EXECUTE 'ALTER TABLE post_commit_sentinel ENABLE ROW LEVEL SECURITY';
        END IF;
      END;
      $$ LANGUAGE plpgsql;
      CREATE EVENT TRIGGER sentinel_rls ON ddl_command_end
        WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION enable_sentinel_rls();
    `)
    try {
      const before = await posture()
      expect(before.get('post_commit_sentinel'), 'the sentinel starts clean, or this proves nothing').toEqual({
        enabled: false,
        forced: false,
      })
      expect(before.get('post_commit_work')?.enabled, 'and there is real work for the sweep to commit').toBe(true)

      await t.client`
        UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION - 1} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
      `
      const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })

      expect(r.code, `exit 5, never 1 — the recovery differs.\n${r.out}`).toBe(5)
      expect(r.out, 'verification is what failed').toContain('verification failed')
      expect(r.out).toContain('post_commit_sentinel')
      expect(r.out, 'and the operator is told the retry will not happen').toContain(
        'DO NOT ASSUME THE NEXT BOOT RETRIES',
      )
      expect(r.out, 'with the recovery that actually works').toContain('RLS_CUTOVER_SWEEP_VERSION')
      expect(r.out, 'this run committed, and must say so rather than hedging').toContain('transaction COMMITTED')

      // The claim the exit code makes about the world: the work IS committed
      // and the ledger IS current, which is precisely why a restart is useless.
      const after = await posture()
      expect(after.get('post_commit_work')?.enabled, 'the DDL committed').toBe(false)
      const [stamp] = await t.client<{ version: number }[]>`
        SELECT version FROM seed_state WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
      `
      expect(stamp?.version, 'the stamp committed with it — this is why the next boot will not retry').toBe(
        RLS_CUTOVER_SWEEP_VERSION,
      )
    } finally {
      await t.client.unsafe('DROP EVENT TRIGGER IF EXISTS sentinel_rls').catch(() => undefined)
      await t.client.unsafe('DROP FUNCTION IF EXISTS enable_sentinel_rls()').catch(() => undefined)
      await t.client.unsafe('DROP TABLE IF EXISTS post_commit_sentinel').catch(() => undefined)
      await t.client.unsafe('DROP TABLE IF EXISTS post_commit_work').catch(() => undefined)
    }
  })
})

/*
 * ── THE §5-vs-§7 CONFLICT ──────────────────────────────────────────────────
 *
 * §5: the bootstrap tables are read BEFORE any identity exists, so the cutover
 * must DISABLE them or every device fails to authenticate.
 * §7: a table that is ENABLEd and FORCEd was turned on by a rollout phase, and a
 * boot script reverting one is the defect this whole split exists to end.
 *
 * A bootstrap table that is ENABLEd and FORCEd satisfies neither reading. The
 * step refuses and names both resolutions rather than picking a winner, because
 * either silent choice is one of the two failures the design is built around.
 */
describe('a FORCEd BOOTSTRAP table is refused, not resolved', () => {
  const VICTIM = 'audit_event'

  afterAll(async () => {
    await t.client
      .unsafe(
        `ALTER TABLE ${VICTIM} NO FORCE ROW LEVEL SECURITY;
         ALTER TABLE ${VICTIM} DISABLE ROW LEVEL SECURITY;`,
      )
      .catch(() => undefined)
    await t.client`
      UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
    `
  })

  it('with the ledger BEHIND it exits 4, changes nothing, and stamps nothing', async () => {
    await t.client.unsafe(`
      ALTER TABLE ${VICTIM} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${VICTIM} FORCE ROW LEVEL SECURITY;
      ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;
    `)
    await t.client`
      UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION - 1} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
    `
    const before = await posture()
    // Non-vacuity: there is a real sweepable table in the plan, so "changed
    // nothing" is a refusal to act rather than an empty plan.
    expect(before.get('allocation')?.enabled).toBe(true)

    const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })

    expect(r.code, r.out).toBe(4)
    expect(r.out).toContain('CONFLICT')
    expect(r.out).toContain(VICTIM)
    expect(r.out, 'both readings, because naming one IS picking a winner').toContain('design §5')
    expect(r.out).toContain('design §7')
    expect(r.out, 'the §5 resolution names the symbol that exists at that path').toContain(
      'RLS_BOOTSTRAP_TABLE_NAMES in scripts/rls-roles.ts',
    )
    expect(r.out, 'the §7 resolution').toContain(`ALTER TABLE ${VICTIM} NO FORCE ROW LEVEL SECURITY`)
    expect(
      r.out,
      'the §7 resolution must be shippable by the people who have this repo — there is no DBA and no interactive database access here',
    ).toContain('MIGRATION')
    expect(r.out).toContain('Nothing was changed and the ledger was NOT stamped')

    expect(await posture(), 'a refusal must not half-sweep').toEqual(before)
    expect(
      await ledgerVersion(),
      'stamping a refusal would mean the next boot skips the sweep that never ran',
    ).toBe(RLS_CUTOVER_SWEEP_VERSION - 1)
  })

  it('with the ledger CURRENT it is loud but not a refusal — nothing was asked of it', async () => {
    await t.client`
      UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
    `
    const before = await posture()
    const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('CONFLICT PRESENT')
    expect(r.out).toContain(VICTIM)
    expect(r.out, 'and it says what a bump would do about it').toContain('exit 4')
    expect(await posture()).toEqual(before)
  })
})

/*
 * ── THE TOCTOU THE DESIGN NAMES ────────────────────────────────────────────
 *
 * "a phase's FORCE landing between the sweep's catalog snapshot and its ALTER
 * was silently reverted, invisibly, because the table was no longer enabled for
 * verification to notice." So the decision is re-made from a read taken UNDER an
 * ACCESS EXCLUSIVE lock (measured: that is the mode ALTER TABLE … DISABLE ROW
 * LEVEL SECURITY takes anyway), not from the pre-transaction snapshot.
 *
 * The window is opened deliberately: the blocker holds the target table while
 * the sweep computes its plan, FORCEs it, and only then commits. The sweep is
 * queued on `LOCK TABLE` throughout, so it sees the FORCE the instant it is let
 * through.
 */
describe('the decision is re-made under the lock', () => {
  afterAll(async () => {
    await t.client
      .unsafe(
        `ALTER TABLE allocation NO FORCE ROW LEVEL SECURITY;
         ALTER TABLE allocation DISABLE ROW LEVEL SECURITY;`,
      )
      .catch(() => undefined)
    await t.client`
      UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
    `
  })

  it('a table FORCEd after the plan and before the ALTER is skipped, not swept', async () => {
    await t.client.unsafe(`ALTER TABLE allocation ENABLE ROW LEVEL SECURITY`)
    await t.client`
      UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION - 1} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
    `

    const blocker = postgres(t.url, { max: 1 })
    let r: RunResult
    try {
      let forceAndCommit = (): void => undefined
      const go = new Promise<void>((res) => (forceAndCommit = res))
      const holding = new Promise<void>((taken) => {
        void blocker
          .begin(async (tx) => {
            await tx.unsafe('LOCK TABLE allocation IN ACCESS EXCLUSIVE MODE')
            taken()
            await go
            // The phase lands INSIDE the window, and commits with the lock.
            await tx.unsafe('ALTER TABLE allocation FORCE ROW LEVEL SECURITY')
          })
          .catch(() => undefined)
      })
      await holding

      const run = runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
      // Wait until the sweep is provably QUEUED on our table — otherwise this
      // proves only that a fast FORCE beat a slow sweep.
      let waiters = 0
      for (let i = 0; i < 40 && waiters === 0; i++) {
        const [row] = await t.client<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE c.relname = 'allocation' AND NOT l.granted
        `
        waiters = row?.n ?? 0
        if (waiters === 0) await new Promise((done) => setTimeout(done, 250))
      }
      expect(waiters, 'the sweep must be WAITING on the table, not merely slow').toBeGreaterThan(0)

      forceAndCommit()
      r = await run
    } finally {
      await blocker.end({ timeout: 5 }).catch(() => undefined)
    }

    expect(r.code, r.out).toBe(0)
    const after = await posture()
    expect(after.get('allocation'), 'the FORCE landed in the window and must be honoured').toEqual({
      enabled: true,
      forced: true,
    })
    expect(r.out, 'and the skip is named, not silent').toContain('FORCEd by a phase between the plan and the lock')
  }, 90_000)
})

describe('bounded, serialised, and honest about what it did', () => {
  it('uses a lock key DISJOINT from provisioning’s, so the two steps do not queue on each other', async () => {
    const holder = postgres(t.url, { max: 1 })
    try {
      // Hold PROVISIONING's key. The sweep must sail past it.
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`
      expect(RLS_CUTOVER_SWEEP_LOCK_KEY, 'two steps, two keys').not.toBe(RLS_PROVISION_LOCK_KEY)
      const started = Date.now()
      const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
      expect(r.code, r.out).toBe(0)
      expect(Date.now() - started, 'it must not have waited out a lock it does not use').toBeLessThan(10_000)
    } finally {
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_PROVISION_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 60_000)

  it('waits on ITS OWN key, and gives up rather than hanging boot', async () => {
    const holder = postgres(t.url, { max: 1 })
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_CUTOVER_SWEEP_LOCK_KEY}::int)`
      const r = await runSweep({ DATABASE_URL: t.url, TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('another replica holds the cutover-sweep lock')
      // 55P03 = the LOCK wait ran its course. 57014 would mean the statement
      // bound cut it short and the duration in the message is fiction.
      expect(r.out).toContain('SQLSTATE 55P03')
    } finally {
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_CUTOVER_SWEEP_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 120_000)

  /*
   * The deadline is a RACE, not a `process.exit` inside a timer, so it goes
   * through the same exit path as any other failure. Proven by firing it, not by
   * arithmetic about the constant.
   */
  it('its deadline really fires mid-run, and reports what had happened', async () => {
    const holder = postgres(t.url, { max: 1 })
    try {
      await holder`SELECT pg_advisory_lock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_CUTOVER_SWEEP_LOCK_KEY}::int)`
      const started = Date.now()
      const r = await runSweep({
        DATABASE_URL: t.url,
        TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true',
        TOKENSCOPE_RLS_SWEEP_BUDGET_MS: '2000',
      })
      const elapsed = Date.now() - started
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('BUDGET EXCEEDED')
      expect(r.out).toContain('did not finish within 2s')
      // NON-VACUITY: the DEADLINE ended this, not the 15s lock wait.
      expect(elapsed, 'a run that took the whole lock wait ended on the lock').toBeLessThan(12_000)
      expect(r.out).toContain('nothing was committed')
    } finally {
      await holder`SELECT pg_advisory_unlock(${RLS_PROVISION_LOCK_CLASS}::int, ${RLS_CUTOVER_SWEEP_LOCK_KEY}::int)`.catch(
        () => undefined,
      )
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 60_000)

  /*
   * ── THE OTHER HALF OF EXIT 5: THE DEADLINE LANDS DURING THE COMMIT ────────
   *
   * The test above proves the deadline firing BEFORE any write (exit 1,
   * "nothing was committed"). This proves the opposite cell, and the two
   * together are what make the exit code mean something: between them lies the
   * only state this process genuinely cannot resolve.
   *
   * It also pins the boundary that was wrong twice in a row. Widening exit 5 to
   * `txStarted` sent an operator to bump a version after a deadline that landed
   * while merely acquiring the connection; leaving it at `committed` told them
   * to retry after one that landed during the COMMIT. The flag has to move at
   * the instant the last write returns, and this is the case that can tell.
   *
   * HOW THE WINDOW IS HELD OPEN. A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY
   * DEFERRED` fires at COMMIT time, not at statement time — so a `pg_sleep` in
   * it stalls the COMMIT itself, which is precisely the interval after the
   * ledger INSERT has returned and before the client learns the outcome. No
   * test-only hook in the production script, and no sleep-and-hope.
   */
  /*
   * THE REGRESSION TEST FOR THE BOUNDARY ITSELF. Neither of the other two
   * deadline cases can see the difference between `txStarted` and
   * `writesIssued`: one fires before the transaction is entered at all, the
   * other while it is committing, and both flags agree at those two points.
   *
   * This is the cell where they disagree — the transaction IS open (txStarted)
   * and has issued NOTHING (writesIssued false) because it is still blocked
   * acquiring its first table lock. Widening exit 5 to `txStarted` made this
   * exit 5 and told the operator to bump a version, when the transaction was
   * guaranteed to roll back and a plain retry was the correct advice.
   */
  it('exits 1 when the deadline lands INSIDE the transaction but before any write', async () => {
    // A conflicting lock on a table the sweep always locks (it is in the
    // bootstrap set, so it is in `targets` whatever its posture).
    const holder = postgres(t.url, { max: 1 })
    let release: (() => void) | undefined
    try {
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const holding = holder.begin(async (tx) => {
        await tx.unsafe('LOCK TABLE teammate IN ACCESS EXCLUSIVE MODE')
        await held
      })
      // Give the holder time to actually take the lock before racing it.
      await new Promise((r) => setTimeout(r, 500))

      await t.client`
        UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION - 1} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
      `
      const r = await runSweep({
        DATABASE_URL: t.url,
        TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true',
        // Under TX_LOCK_TIMEOUT (5s), so the DEADLINE wins the race rather than
        // the lock timeout — this must land while still blocked on the LOCK.
        TOKENSCOPE_RLS_SWEEP_BUDGET_MS: '2000',
      })

      expect(r.code, `nothing was written, so a retry IS the correct advice.\n${r.out}`).toBe(1)
      expect(r.out).toContain('BUDGET EXCEEDED')
      expect(
        r.out,
        'the transaction was open but had issued nothing — saying "may be stamped" here is the false claim in the other direction',
      ).toContain('nothing was committed')
      expect(r.out).not.toContain('DO NOT ASSUME THE NEXT BOOT RETRIES')

      release?.()
      await holding
    } finally {
      release?.()
      await holder.end({ timeout: 5 }).catch(() => undefined)
    }
  }, 60_000)

  it('exits 5 when the deadline lands mid-COMMIT — writes issued, outcome unknowable', async () => {
    await t.client.unsafe(`
      CREATE TABLE inflight_work (id bigserial PRIMARY KEY);
      ALTER TABLE inflight_work ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION stall_the_commit() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(6);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER stall_commit
        AFTER INSERT OR UPDATE ON seed_state
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION stall_the_commit();
    `)
    try {
      await t.client`
        UPDATE seed_state SET version = ${RLS_CUTOVER_SWEEP_VERSION - 1} WHERE name = ${RLS_CUTOVER_SWEEP_SEED_NAME}
      `
      const started = Date.now()
      const r = await runSweep({
        DATABASE_URL: t.url,
        TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true',
        // Long enough to reach the COMMIT, short enough to fire inside the stall.
        TOKENSCOPE_RLS_SWEEP_BUDGET_MS: '3000',
      })
      const elapsed = Date.now() - started

      expect(r.code, `the outcome is unknowable, so it may not claim a retry.\n${r.out}`).toBe(5)
      expect(r.out).toContain('BUDGET EXCEEDED')
      expect(
        r.out,
        'the honest report: the writes were issued and only the COMMIT was outstanding',
      ).toContain('only the COMMIT was outstanding')
      expect(r.out).toContain('DO NOT ASSUME THE NEXT BOOT RETRIES')
      expect(
        r.out,
        'and it must NOT claim the transaction committed, which it cannot know',
      ).not.toContain('The transaction COMMITTED, so seed_state')

      // NON-VACUITY: the DEADLINE ended this, inside the stall — not the stall
      // running to completion and not the 30s default budget.
      expect(elapsed, 'the deadline fired during the commit, not after it').toBeLessThan(12_000)
    } finally {
      await t.client.unsafe('DROP TRIGGER IF EXISTS stall_commit ON seed_state').catch(() => undefined)
      await t.client.unsafe('DROP FUNCTION IF EXISTS stall_the_commit()').catch(() => undefined)
      await t.client.unsafe('DROP TABLE IF EXISTS inflight_work').catch(() => undefined)
    }
  }, 60_000)
})
