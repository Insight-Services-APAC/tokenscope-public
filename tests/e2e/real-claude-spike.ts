/*
 * Local-but-real spike: prove a REAL Claude Code session's token usage
 * flows through the production ingest/attribution path.
 *
 *   attest (insert instance_attestation)
 *     → run real `claude -p` with the plugin emit-config, OTEL pointed at
 *       the reshaped telemetry store, tokenscope.instance_id resource attr
 *     → store normalises Claude's api_request events into UsageRecords
 *     → runReadJoiner (REAL worker) joins on instance_id, prices via
 *       rate_card, writes attribution_record
 *     → assert attribution_record carries the real token counts + cost
 *
 * Only the OTel transport is local (store stands in for Collector→LAW).
 * Identity = a seeded teammate; auth = this box's copied Claude creds for
 * one throwaway turn.
 *
 * Env: DATABASE_URL, NUXT_AZURE_MONITOR_ENDPOINT (the local store).
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as schema from '../../drizzle/schema'
import { LocalCollectorReader } from '../../server/azure/reader'
import { runReadJoiner } from '../../server/workers/azure-monitor-reader'

const TEAMMATE_EMAIL = 'demo-priya.iyer@example.com'
const PROJECT_CODE = 'AFL-AII'

async function main() {
  const dbUrl = process.env.DATABASE_URL
  const store = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!dbUrl || !store) throw new Error('DATABASE_URL and NUXT_AZURE_MONITOR_ENDPOINT required')

  const client = postgres(dbUrl, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema }) as unknown as PostgresJsDatabase<typeof schema>

  try {
    const [row] = await db.execute<{
      teammate_id: string
      region_id: string
      org_unit_id: string
      project_code_hash: string
      cost_owning_unit_id: string
    }>(sql`
      SELECT t.id::text AS teammate_id, t.region_id::text AS region_id,
             t.org_unit_id::text AS org_unit_id,
             p.code_hash AS project_code_hash,
             p.cost_owning_unit_id::text AS cost_owning_unit_id
      FROM teammate t, project p
      WHERE t.email = ${TEAMMATE_EMAIL} AND p.code = ${PROJECT_CODE} LIMIT 1
    `)
    if (!row) throw new Error(`seed missing ${TEAMMATE_EMAIL} / ${PROJECT_CODE} — run db:seed`)

    const sid = randomUUID()
    // Attest stand-in: the row the attest endpoint would write.
    await db.execute(sql`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, region_id, org_unit_id,
         cost_owning_unit_id, attestation_state)
      VALUES (${sid}::uuid, ${'oid-spike'}, ${TEAMMATE_EMAIL}, ${row.teammate_id}::uuid,
              ${row.project_code_hash}, ${PROJECT_CODE}, 'claude-code', ${'spike-' + sid},
              NOW(), ${row.region_id}::uuid, ${row.org_unit_id}::uuid,
              ${row.cost_owning_unit_id}::uuid, 'attested')
    `)
    console.warn(`[spike] attested session ${sid} for ${TEAMMATE_EMAIL} / ${PROJECT_CODE}`)

    // Isolated HOME with this box's creds copied for one throwaway turn.
    const chome = mkdtempSync(join(tmpdir(), 'spike-claude-'))
    mkdirSync(join(chome, '.claude'), { recursive: true })
    const cred = join(homedir(), '.claude', '.credentials.json')
    if (existsSync(cred)) copyFileSync(cred, join(chome, '.claude', '.credentials.json'))
    const cfg = join(homedir(), '.claude.json')
    if (existsSync(cfg)) copyFileSync(cfg, join(chome, '.claude.json'))

    console.warn('[spike] running real claude -p with emit-config → store…')
    const res = spawnSync('claude', ['-p', 'Reply with exactly the word: ok', '--output-format', 'text'], {
      env: {
        ...process.env,
        HOME: chome,
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', // store parses JSON
        OTEL_EXPORTER_OTLP_ENDPOINT: store,
        OTEL_METRIC_EXPORT_INTERVAL: '2000',
        OTEL_LOGS_EXPORT_INTERVAL: '2000',
        OTEL_LOG_USER_PROMPTS: '0',
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer spike-${sid}`,
        OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${sid},project.code_hash=${row.project_code_hash},tool=claude-code`,
      },
      encoding: 'utf8',
      timeout: 120_000,
    })
    console.warn(`[spike] claude stdout: ${(res.stdout || '').trim().slice(0, 80)} (status ${res.status})`)
    if (res.status !== 0) throw new Error(`claude turn failed: ${(res.stderr || '').slice(0, 300)}`)

    // Let the SDK flush metrics/logs on shutdown + store ingest.
    await new Promise((r) => setTimeout(r, 4000))

    const reader = new LocalCollectorReader(store)
    const usage = await reader.getSessionUsage(sid)
    console.warn(`[spike] store has ${usage.length} usage records for the session`)

    const result = await runReadJoiner(db, reader, { sessionIds: [sid] })
    console.warn(`[spike] joiner: ${JSON.stringify(result)}`)

    const rows = await db.execute<{ token_type: string; tokens: string; cost_usd: string; model: string }>(sql`
      SELECT token_type, tokens::text AS tokens, cost_usd::text AS cost_usd, model
      FROM attribution_record WHERE instance_id = ${sid}::uuid ORDER BY token_type
    `)
    const list = [...rows]
    console.warn('[spike] attribution_record rows:')
    for (const r of list) console.warn(`  ${r.token_type.padEnd(12)} tokens=${r.tokens} cost=$${r.cost_usd} model=${r.model}`)
    const totalTokens = list.reduce((a, r) => a + Number(r.tokens), 0)
    const totalCost = list.reduce((a, r) => a + Number(r.cost_usd), 0)

    if (list.length === 0 || totalTokens === 0) {
      throw new Error('[spike] FAIL: no attributed tokens — real Claude data did not flow through')
    }
    console.warn(`\n[spike] PASS ✓ real Claude session attributed: ${totalTokens} tokens, $${totalCost.toFixed(6)} on ${PROJECT_CODE} for ${TEAMMATE_EMAIL}`)
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
