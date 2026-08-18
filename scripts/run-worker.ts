/*
 * run-worker.ts — dev/ops CLI to invoke any registered worker directly,
 * without going through the HMAC HTTP endpoint.
 *
 * Usage:
 *   npm run worker -- <name> [--opts '<json>']
 *   tsx scripts/run-worker.ts <name> [--opts '<json>']
 *   tsx scripts/run-worker.ts --list
 *
 * Examples:
 *   tsx scripts/run-worker.ts reconciliation
 *   tsx scripts/run-worker.ts analytics-poll --opts '{"startingAt":"2026-01-01","endingAt":"2026-06-30"}'
 *   tsx scripts/run-worker.ts --list
 *
 * `--opts` takes the same JSON shape as the signed run-worker HTTP body and is
 * validated by the same workerOptsSchema (malformed → hard error here, unlike
 * the fail-soft HTTP path — an operator typo on a one-off invocation should
 * fail loudly, not silently take the default behaviour).
 *
 * Why a separate CLI instead of curling the HTTP endpoint locally:
 *   - No HMAC signing dance for one-off invocations
 *   - Direct DB connection (does not require Nuxt running)
 *   - Friendly output (per-worker result printed as JSON)
 */
import 'dotenv/config'
import { createWorkerDb } from '../server/db/worker-db'
import { getWorker, listWorkerNames, WORKERS, type WorkerRunContext } from '../server/workers/registry'
import { workerOptsSchema } from '../server/workers/run-worker-opts'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
    process.stdout.write('Registered workers:\n')
    for (const w of WORKERS) {
      process.stdout.write(
        `  ${w.name.padEnd(24)} ${w.recommendedCron.padEnd(14)} ${w.description}\n`,
      )
    }
    return
  }
  const name = args[0]!
  const entry = getWorker(name)
  if (!entry) {
    console.error(`Unknown worker: ${name}`)
    console.error(`Known: ${listWorkerNames().join(', ')}`)
    process.exit(2)
  }
  // Optional per-dispatch options, same shape + schema as the signed HTTP body.
  let ctx: WorkerRunContext | undefined
  const optsFlag = args.indexOf('--opts')
  if (optsFlag !== -1) {
    const rawOpts = args[optsFlag + 1]
    if (!rawOpts) {
      console.error('--opts requires a JSON argument')
      process.exit(2)
    }
    let json: unknown
    try {
      json = JSON.parse(rawOpts)
    } catch (err) {
      console.error(`--opts is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(2)
    }
    const parsed = workerOptsSchema.safeParse(json)
    if (!parsed.success) {
      console.error(`--opts failed validation: ${parsed.error.message}`)
      process.exit(2)
    }
    ctx = { runId: null, opts: parsed.data }
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(2)
  }
  // THE WORKER LANE'S CONNECTION CONFIG — the same one the in-process dispatch
  // uses (server/db/worker-db.ts). Two things ride on it, and this CLI had
  // NEITHER:
  //   - the estate-wide `app.user_role=global-finops` RLS identity, without
  //     which a worker run from here reads part of the estate under FORCE and
  //     reports success (docs/design/rls-enforcement.md §2);
  //   - `TimeZone: 'UTC'`. This line used to be `createDbClient(url)` with NO
  //     options at all, so the CLI ran every worker on a connection in the
  //     SERVER's timezone while the app pool (server/db/index.ts:30) pins UTC.
  //     ~23 bare `timestamptz::date` day-bucket casts are correct only because
  //     of that pin (docs/design/clock-rot-audit.md §A), so `npm run worker --
  //     aggregate-rollup` on a non-UTC host wrote rollup cells keyed to the
  //     wrong day — silently, and differently from the same worker run by cron.
  // Pool size is left at the lane default (max 10), NOT narrowed to 1: several
  // workers open a transaction and issue other statements alongside it, which a
  // single-connection pool would deadlock rather than merely slow down.
  const { client, db } = await createWorkerDb(url)
  const startedAt = Date.now()
  try {
    const result = await entry.run(db, ctx)
    const durationMs = Date.now() - startedAt
    process.stdout.write(
      JSON.stringify({ worker: name, duration_ms: durationMs, result }, null, 2) + '\n',
    )
  } finally {
    await client.end()
  }
}

void main().catch((err) => {
  console.error('worker failed:', err)
  process.exit(1)
})
