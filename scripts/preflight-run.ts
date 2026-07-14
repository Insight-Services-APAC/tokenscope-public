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

runPreflight()
  .then((code) => process.exit(code))
  .catch((err) => {
    // An UNEXPECTED failure in the probe itself must NOT brick boot — this is a
    // diagnostic aid, and the migration step remains the real Postgres gate.
    // Only an intentional critical-dependency-down (runPreflight → 1) aborts.
    console.error('[preflight] unexpected error (non-fatal; continuing to migrations)', err)
    process.exit(0)
  })
