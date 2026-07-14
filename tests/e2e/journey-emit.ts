/*
 * journey-emit — the "attribute a session" seam for the end-to-end
 * journey E2E, driven through the REAL ingestion pipeline (no shortcut
 * straight into attribution_record):
 *
 *   1. mint a instance_attestation row for (teammate, project) — the same
 *      shape POST /api/v1/instances/attest writes
 *   2. POST deterministic token spans to fake-azure-monitor /admin/ingest
 *      (the stand-in for Claude Code's OTel export → Azure Monitor)
 *   3. run the REAL azure-monitor-read joiner, which binds the spans to
 *      the attested identity, prices them against the seeded rate card,
 *      and writes attribution_record rows
 *
 * Everything but the OTel source is production code. Called from the
 * Playwright journey spec (Node context) between browser steps.
 *
 * Deterministic spans: 4,000,000 input + 2,000,000 output tokens →
 * $12.00 + $30.00 = $42.00 against the 0004 default rate card. Visible,
 * stable, and well under the lead developer's $600 cap.
 */
import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as schema from '../../drizzle/schema'
import { LocalCollectorReader } from '../../server/azure/reader'
import { runReadJoiner } from '../../server/workers/azure-monitor-reader'

const DEFAULT_SPANS = [
  { tokens: 4_000_000, tokenType: 'input' },
  { tokens: 2_000_000, tokenType: 'output' },
]
const MODEL = 'claude-sonnet-4-6'

export interface EmitResult {
  sessionId: string
  spansEmitted: number
  attributionRowsWritten: number
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Resolve seeded teammate ids by email (the browser doesn't know ids). */
export async function resolveTeammateIds(emails: string[]): Promise<Record<string, string>> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('journey-emit: DATABASE_URL not set')
  const client = postgres(dbUrl, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema }) as unknown as PostgresJsDatabase<typeof schema>
  try {
    const out: Record<string, string> = {}
    for (const email of emails) {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM teammate WHERE email = ${email} LIMIT 1
      `)
      const row = [...rows][0]
      if (!row) throw new Error(`journey-emit: teammate not found for ${email}`)
      out[email] = row.id
    }
    return out
  } finally {
    await client.end({ timeout: 5 })
  }
}

interface ResolvedAssignment {
  teammate_id: string
  teammate_email: string
  region_id: string
  org_unit_id: string
  project_id: string
  project_code: string
  project_code_hash: string
  cost_owning_unit_id: string
}

/**
 * Emit a real attributed session for one (teammate, project). The
 * teammate need not be assigned to the project — cross-team contribution
 * is allowed by the model — but BOTH must exist.
 */
export async function emitSessionForAssignment(opts: {
  teammateEmail: string
  projectCode: string
  spans?: Array<{ tokens: number; tokenType: string }>
}): Promise<EmitResult> {
  const dbUrl = process.env.DATABASE_URL
  const endpoint = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!dbUrl) throw new Error('journey-emit: DATABASE_URL not set')
  if (!endpoint) throw new Error('journey-emit: NUXT_AZURE_MONITOR_ENDPOINT not set')

  const client = postgres(dbUrl, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema }) as unknown as PostgresJsDatabase<typeof schema>
  const reader = new LocalCollectorReader(endpoint)

  try {
    const rows = await db.execute<ResolvedAssignment>(sql`
      SELECT t.id::text AS teammate_id,
             t.email AS teammate_email,
             t.region_id::text AS region_id,
             t.org_unit_id::text AS org_unit_id,
             p.id::text AS project_id,
             p.code AS project_code,
             p.code_hash AS project_code_hash,
             p.cost_owning_unit_id::text AS cost_owning_unit_id
      FROM teammate t, project p
      WHERE t.email = ${opts.teammateEmail} AND p.code = ${opts.projectCode}
      LIMIT 1
    `)
    const a = [...rows][0]
    if (!a) {
      throw new Error(
        `journey-emit: could not resolve teammate '${opts.teammateEmail}' + project '${opts.projectCode}'`,
      )
    }

    const sessionId = randomUUID()
    const baseTs = Date.now()
    const spans = (opts.spans ?? DEFAULT_SPANS).map((s, i) => ({
      tokens: s.tokens,
      tokenType: s.tokenType,
      model: MODEL,
      tsEvent: new Date(baseTs - i * 1000).toISOString(),
      sourceRunId: `journey-${sessionId.slice(0, 8)}-${i}`,
      // B′ (ADR-0004): the joiner attributes by the EMITTED project hash and
      // SKIPS records without one. Stamp it (mirrors scripts/emit-data.ts) — the
      // attestation's hash alone isn't enough. (This helper predates B′.)
      projectCodeHash: a.project_code_hash,
      claudeSessionId: sessionId,
    }))

    // 1) push spans to the fake Azure Monitor (the OTel-source stand-in)
    const res = await fetch(`${endpoint}/admin/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, spans }),
    })
    if (!res.ok) {
      throw new Error(`journey-emit: /admin/ingest HTTP ${res.status}: ${await res.text()}`)
    }

    // 2) mint the attestation row (same shape as the attest endpoint)
    await db.execute(sql`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id,
         project_code_hash, raw_project_code, tool, session_token_hash,
         ts_start, region_id, org_unit_id, cost_owning_unit_id, attestation_state)
      VALUES (${sessionId}::uuid, ${'oid-journey-' + a.teammate_email.split('@')[0]},
              ${a.teammate_email}, ${a.teammate_id}::uuid, ${a.project_code_hash},
              ${a.project_code}, 'claude-code', ${sha256Hex('journey:' + sessionId)},
              NOW(), ${a.region_id}::uuid, ${a.org_unit_id}::uuid,
              ${a.cost_owning_unit_id}::uuid, 'attested')
      ON CONFLICT (instance_id) DO NOTHING
    `)

    // 3) run the REAL joiner scoped to this session
    const joiner = await runReadJoiner(db, reader, { sessionIds: [sessionId] })

    return {
      sessionId,
      spansEmitted: spans.length,
      attributionRowsWritten: joiner.attributionRowsWritten,
    }
  } finally {
    await client.end({ timeout: 5 })
  }
}
