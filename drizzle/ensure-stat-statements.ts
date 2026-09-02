/*
 * Best-effort creation of the pg_stat_statements EXTENSION.
 *
 * A BOOT STEP, NOT A MIGRATION. Two constraints force that:
 *
 *   1. entrypoint.sh does `exit 1` when migrate.ts fails, and migrate.ts runs
 *      each file in ONE transaction. A PL/pgSQL EXCEPTION does not contain the
 *      risk: WHEN OTHERS does not catch QUERY_CANCELED or ASSERT_FAILURE, so a
 *      statement_timeout or an administrative cancel would abort the
 *      transaction and take the container down to enable a diagnostic.
 *   2. A migration runs ONCE. A swallowed failure is recorded as applied and
 *      never retried, turning a transient privilege or timing failure into a
 *      permanent one.
 *
 * As a boot step it cannot abort boot, and it retries every boot.
 *
 * This creates the extension only. Preloading the LIBRARY is separate and lives
 * in infra/modules/postgresql.bicep; the db-performance probe reports the two
 * independently because they are different failures with different fixes.
 *
 * EXIT CODES — 0 always, deliberately. There is no failure of this step that
 * should change whether the application serves traffic: without the extension
 * the probe reports "preloaded but not installed" and everything else works.
 */
import { createDbClient } from './connect'

const DEADLINE_MS = 15_000

async function main(): Promise<void> {
  /*
   * THE OWNER URL, never runtimeDatabaseUrl(). That helper prefers
   * TOKENSCOPE_APP_DATABASE_URL once the app role is provisioned, and that role
   * holds table DML and schema USAGE only — not database CREATE. Running here
   * as tokenscope_app fails 42501 on every boot, is swallowed as non-fatal by
   * design, and the extension is never created while the owner credential sat
   * right there. migrate.ts and provision-app-role.ts read DATABASE_URL for the
   * same reason.
   */
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    console.warn('[stat-statements] no DATABASE_URL; skipping')
    return
  }

  const sql = createDbClient(url, { max: 1 })
  try {
    // Bounded so a locked catalog cannot hold boot open indefinitely. These are
    // SESSION-scoped (set_config's third argument is false), not
    // transaction-local — which is fine and deliberate here: this script owns
    // its own single-use connection, so nothing else can inherit them.
    //
    // The bound covers STATEMENTS only. Connection setup, DNS and TLS are
    // outside it, so this step is not a hard 15s ceiling on boot. It does not
    // need to be: entrypoint runs it in the non-fatal form, so a slow step
    // delays startup rather than preventing it.
    await sql`SELECT set_config('lock_timeout', '5s', false)`
    await sql`SELECT set_config('statement_timeout', ${String(DEADLINE_MS)}, false)`
    await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`

    const [row] = [
      ...(await sql<{ installed: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`),
    ]
    console.warn(
      row?.installed
        ? '[stat-statements] extension present'
        : '[stat-statements] extension still absent after CREATE (unexpected but non-fatal)',
    )
  } catch (err) {
    /*
     * The SQLSTATE is logged, not just the message. "insufficient_privilege"
     * (42501) and "undefined_file" (58P01) need completely different fixes —
     * grant the role, versus preload the library — and a bare message string
     * makes an operator guess which one they are looking at. The probe can only
     * say "not installed"; this line is where the WHY lives.
     */
    const code = (err as { code?: string })?.code ?? 'unknown'
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[stat-statements] not created (SQLSTATE ${code}): ${message} — ` +
        'the db-performance probe will report preloaded/installed separately; the next boot retries',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Nothing above should reach here; if it does, still exit 0. This step is
    // never a reason to refuse traffic.
    console.warn('[stat-statements] unexpected failure (non-fatal):', err)
    process.exit(0)
  })
