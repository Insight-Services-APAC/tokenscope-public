/*
 * Synthetic-data emitter — one-shot bulk.
 *
 * Usage:
 *   DATABASE_URL=...   \
 *   NUXT_AZURE_MONITOR_ENDPOINT=http://tokenscope-fake-azure-monitor:8080 \
 *   tsx scripts/emit-data.ts
 *
 * What it does:
 *   1. Reads existing teammates + project_assignment rows (seed must have run).
 *   2. For each (teammate, project) pair, creates one instance_attestation row.
 *   3. POSTs a small batch of spans (input/output/cache_read/cache_write)
 *      per session to the fake-azure-monitor /admin/ingest endpoint.
 *   4. Runs runReadJoiner once, which joins the spans against
 *      instance_attestation, looks up the seeded Anthropic rate_card, and
 *      writes attribution_record rows.
 *   5. Prints a summary so the developer can confirm rows landed before
 *      reloading the UI.
 *
 * Companion: scripts/emit-stream.ts — same shape but keeps emitting on
 * an interval to verify the at-speed read path.
 */
import { createHash, randomUUID } from 'node:crypto'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { createDbClient } from '../drizzle/connect'
import * as schema from '../drizzle/schema'
import { LocalCollectorReader } from '../server/azure/reader'
import { runReadJoiner } from '../server/workers/azure-monitor-reader'

interface Assignment {
  teammate_id: string
  teammate_email: string
  region_id: string
  org_unit_id: string
  project_id: string
  project_code: string
  project_code_hash: string
  cost_owning_unit_id: string
}

// Unit names match drizzle/migrations/0004_default_rate_card.sql
// verbatim — the joiner does an exact string match, so 'cache-read'
// here vs 'cache_read' there silently routes spans to the skip pile.
const TOKEN_TYPES: Array<{ unit: string; min: number; max: number }> = [
  { unit: 'input', min: 800, max: 6000 },
  { unit: 'output', min: 200, max: 1500 },
  { unit: 'cache-read', min: 400, max: 3000 },
  { unit: 'cache-write', min: 100, max: 800 },
]
// MODEL must match a rate_line.model in the resolved rate_card OR fall
// back to the model:NULL wildcard line — see
// drizzle/migrations/0004_default_rate_card.sql for the seeded set. The
// migration seeds wildcard lines only, so any model string works today;
// if a model-specific line is added later, update this constant.
const MODEL = 'claude-sonnet-4-6'
const SPANS_PER_SESSION = 12

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

async function loadAssignments(
  db: PostgresJsDatabase<typeof schema>,
): Promise<Assignment[]> {
  const rows = await db.execute<Assignment>(sql`
    SELECT t.id::text         AS teammate_id,
           t.email             AS teammate_email,
           t.region_id::text   AS region_id,
           t.org_unit_id::text AS org_unit_id,
           p.id::text          AS project_id,
           p.code              AS project_code,
           p.code_hash         AS project_code_hash,
           p.cost_owning_unit_id::text AS cost_owning_unit_id
      FROM project_assignment pa
      JOIN teammate t ON t.id = pa.teammate_id
      JOIN project  p ON p.id = pa.project_id
     ORDER BY t.email, p.code
  `)
  return [...rows]
}

async function postSpans(
  endpoint: string,
  sessionId: string,
  spans: Array<{ tokens: number; tokenType: string; model: string; tsEvent: string; sourceRunId?: string; projectCodeHash?: string; claudeSessionId?: string }>,
): Promise<void> {
  const res = await fetch(`${endpoint}/admin/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, spans }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`fake-azure-monitor /admin/ingest HTTP ${res.status}: ${body}`)
  }
}

export interface EmitTickResult {
  sessionsCreated: number
  spansEmitted: number
  joinerResult: Awaited<ReturnType<typeof runReadJoiner>>
}

export async function emitTick(
  db: PostgresJsDatabase<typeof schema>,
  reader: LocalCollectorReader,
  endpoint: string,
  opts: { reuseSessions?: Map<string, string> } = {},
): Promise<EmitTickResult> {
  const assignments = await loadAssignments(db)
  if (assignments.length === 0) {
    throw new Error(
      'emit-data: no project_assignment rows found — run `SEED_RESET=true npm run db:seed` first',
    )
  }

  const sessionIds: string[] = []
  let spansEmitted = 0

  for (const a of assignments) {
    const key = `${a.teammate_id}:${a.project_id}`
    let sessionId = opts.reuseSessions?.get(key)
    const isNew = !sessionId
    if (!sessionId) {
      sessionId = randomUUID()
    }

    // One Claude conversation per synthetic instance/session (real instances
    // carry several; this exercises the claude_session_id column + per-conversation
    // grouping in the views without needing live Claude data).
    const claudeSessionId = randomUUID()
    const spans = Array.from({ length: SPANS_PER_SESSION }, () => {
      const slot = TOKEN_TYPES[randInt(0, TOKEN_TYPES.length - 1)]!
      return {
        tokens: randInt(slot.min, slot.max),
        tokenType: slot.unit,
        model: MODEL,
        // Spread events across the last 24 hours so the joiner's default
        // window picks them up; randomise so consecutive ticks don't all
        // share one timestamp (which would dedupe on the idempotency key).
        tsEvent: new Date(
          Date.now() - randInt(0, 23 * 60 * 60 * 1000),
        ).toISOString(),
        sourceRunId: `emit-${randomUUID().slice(0, 8)}`,
        // B′ (ADR-0004): the joiner attributes by the EMITTED project hash, so the
        // synthetic emitter stamps each span with its (teammate, project) hash —
        // mirroring what the plugin injects from a repo's .tokenscope.
        projectCodeHash: a.project_code_hash,
        claudeSessionId,
      }
    })

    // POST first, INSERT second. If the stub is unreachable the session
    // row never gets created, so failed ticks don't leave orphan
    // instance_attestation rows that the joiner later scans over.
    await postSpans(endpoint, sessionId, spans)
    spansEmitted += spans.length

    if (isNew) {
      const tokenHash = sha256Hex(`emitter:${sessionId}`)
      const principalOid = `oid-emitter-${a.teammate_email.split('@')[0]}`
      await db.execute(sql`
        INSERT INTO instance_attestation
          (instance_id, principal_oid, principal_email, teammate_id,
           project_code_hash, raw_project_code, tool, session_token_hash,
           ts_start, region_id, org_unit_id, cost_owning_unit_id,
           attestation_state)
        VALUES (${sessionId}::uuid, ${principalOid}, ${a.teammate_email},
                ${a.teammate_id}::uuid, ${a.project_code_hash},
                ${a.project_code}, 'claude-code', ${tokenHash},
                NOW(), ${a.region_id}::uuid, ${a.org_unit_id}::uuid,
                ${a.cost_owning_unit_id}::uuid, 'attested')
        ON CONFLICT (instance_id) DO NOTHING
      `)
      opts.reuseSessions?.set(key, sessionId)
    }

    sessionIds.push(sessionId)
  }

  // Scope the joiner to the sessions we just touched — bypasses any
  // pre-existing rows that the default 24-hour window would otherwise
  // sweep over.
  const joinerResult = await runReadJoiner(db, reader, { sessionIds })

  return {
    sessionsCreated: sessionIds.length,
    spansEmitted,
    joinerResult,
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('emit-data: DATABASE_URL not set')
    process.exit(1)
  }
  const endpoint = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!endpoint) {
    console.error('emit-data: NUXT_AZURE_MONITOR_ENDPOINT not set')
    process.exit(1)
  }

  const client = createDbClient(dbUrl, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema })
  const reader = new LocalCollectorReader(endpoint)

  try {
    const result = await emitTick(db, reader, endpoint)
    console.warn(
      `emit-data: ${result.sessionsCreated} sessions, ${result.spansEmitted} spans pushed; ` +
        `joiner wrote ${result.joinerResult.attributionRowsWritten} attribution_record rows ` +
        `(skipped ${result.joinerResult.spansSkippedNoRateCard} for missing rate-card)`,
    )
  } finally {
    await client.end({ timeout: 5 })
  }
}

// Run main() only when this file is the tsx entrypoint — emit-stream.ts
// imports `emitTick` and must not trigger this main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
