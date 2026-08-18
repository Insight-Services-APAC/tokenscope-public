/*
 * Boot pre-flight CLI entry — invoked by entrypoint.sh BEFORE migrations.
 *
 * Deliberately a SEPARATE file from scripts/preflight.ts: that module is also
 * imported by the admin diagnostics route, and nitro evaluates route modules at
 * server startup, so the importable module must carry no top-level execution.
 * All the runnable side effects (probe, log, exit) live here, and nothing
 * imports this file.
 */
import { runPreflight } from './preflight'
import { reportRlsPostureAtBoot } from './preflight-rls'

runPreflight()
  .then(async (code) => {
    // One informational line: is the app on the owner connection, how much RLS
    // is actually enforced, and does the non-owner app role exist yet
    // (docs/design/rls-enforcement.md). Only when the dependency probe passed —
    // if Postgres is unreachable the abort is the story, not the posture. Never
    // throws, never blocks boot.
    if (code === 0) await reportRlsPostureAtBoot()
    return code
  })
  .then((code) => process.exit(code))
  .catch((err) => {
    // An UNEXPECTED failure in the probe itself must NOT brick boot — this is a
    // diagnostic aid, and the migration step remains the real Postgres gate.
    // Only an intentional critical-dependency-down (runPreflight → 1) aborts.
    console.error('[preflight] unexpected error (non-fatal; continuing to migrations)', err)
    process.exit(0)
  })
