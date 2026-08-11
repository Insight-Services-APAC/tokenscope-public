/*
 * Synthetic-data stream emitter — continuous loop.
 *
 * Usage:
 *   DATABASE_URL=...   \
 *   NUXT_AZURE_MONITOR_ENDPOINT=http://tokenscope-fake-azure-monitor:8080 \
 *   tsx scripts/emit-stream.ts [intervalSeconds]
 *
 * Reuses scripts/emit-data.ts emitTick() — pinning a session_id per
 * (teammate, project) pair across ticks so the at-speed path looks like
 * a real long-running CLI rather than a parade of one-shot sessions.
 * The aggregator and the developer "your projects" grid both join on
 * session_id, so reusing them is what proves the live read path is
 * keeping up.
 *
 * Ctrl-C to stop; closes the postgres pool cleanly on SIGINT/SIGTERM.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDbClient } from '../drizzle/connect'
import * as schema from '../drizzle/schema'
import { LocalCollectorReader } from '../server/azure/reader'
import { emitTick } from './emit-data'

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('emit-stream: DATABASE_URL not set')
    process.exit(1)
  }
  const endpoint = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!endpoint) {
    console.error('emit-stream: NUXT_AZURE_MONITOR_ENDPOINT not set')
    process.exit(1)
  }

  const intervalArg = process.argv[2]
  const intervalSeconds = intervalArg ? Math.max(1, parseInt(intervalArg, 10)) : 10
  if (!Number.isFinite(intervalSeconds)) {
    console.error(`emit-stream: invalid interval "${intervalArg}"`)
    process.exit(1)
  }

  const client = createDbClient(dbUrl, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema })
  const reader = new LocalCollectorReader(endpoint)

  // Per-(teammate, project) session pin. emitTick mutates this map so
  // the second tick onwards POSTs spans into the SAME session_id.
  const sessions = new Map<string, string>()

  let stopping = false
  let wakeSleep: (() => void) | null = null
  const shutdown = (sig: string) => {
    if (stopping) return
    stopping = true
    console.warn(`emit-stream: ${sig} — draining`)
    // Interrupt an in-flight sleep so SIGINT doesn't wait for the
    // current tick interval to elapse.
    wakeSleep?.()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.warn(`emit-stream: tick every ${intervalSeconds}s — ${endpoint}`)

  try {
    let tick = 0
    while (!stopping) {
      tick += 1
      const t0 = Date.now()
      try {
        const r = await emitTick(db, reader, endpoint, { reuseSessions: sessions })
        const ms = Date.now() - t0
        console.warn(
          `emit-stream tick=${tick} ${ms}ms — ${r.sessionsCreated} sessions, ` +
            `${r.spansEmitted} spans, +${r.joinerResult.attributionRowsWritten} attribution rows ` +
            `(skip=${r.joinerResult.spansSkippedNoRateCard})`,
        )
      } catch (err) {
        // Don't crash the loop on a transient stub/DB hiccup — log and
        // keep ticking. Persistent failures will show as flat counts.
        console.error(`emit-stream tick=${tick} failed:`, err)
      }
      if (stopping) break
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeSleep = null
          resolve()
        }, intervalSeconds * 1000)
        wakeSleep = () => {
          clearTimeout(timer)
          wakeSleep = null
          resolve()
        }
      })
    }
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
