/*
 * Local demo seeder for the developer homepage — populates EVERY panel for the
 * demo dev persona (Priya) from the SINGLE ledger source (attribution_record),
 * matching the mig 0021 model where the joiner itemises all spend:
 *   - project spend with VARIED budgets (green / amber / over)   → AR project_id set
 *   - tagged (spill) spend, grouped by activity                  → AR project_id NULL + activity
 *   - needs-tagging (genuinely untagged) sessions                → AR project_id NULL + no activity
 *   - recent sessions                                            → all of the above
 *
 * Re-runnable: clears Priya's rows first (clean slate).
 *
 *   DATABASE_URL=... tsx scripts/seed-demo-homepage.ts
 */
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { currentServerDeployEnv, isDemoCapableEnv } from '../shared/env/deploy-env'

const MARK = 'demo-homepage-seed'
const db = postgres(process.env.DATABASE_URL!, { max: 1 })

const now = new Date()
const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
const mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
const today = now.toISOString().slice(0, 10)
const iso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString()

// Budgets + deterministic spend per project (drives the RAG variety).
const PROJECT_PLAN: Record<string, { budget: number; spend: number }> = {
  'AFL-DRP': { budget: 1000, spend: 740 }, // 74% — amber/watch
  'AFL-AII': { budget: 500, spend: 145 }, //  29% — green/healthy
  'INT-PLT': { budget: 300, spend: 330 }, // 110% — red/over
}

// Unallocated (project_id NULL) sessions. Two carry an activity → spill (tagged);
// two don't → needs tagging.
const UNTAGGED = [
  { cost: 32.39, tokens: 2_150_000, activity: 'research', hrs: 3 },
  { cost: 48.96, tokens: 6_540_000, activity: 'documentation', hrs: 6 },
  { cost: 9.12, tokens: 649_000, activity: null as string | null, hrs: 11 },
  { cost: 1.73, tokens: 150_000, activity: null as string | null, hrs: 13 },
]

async function main() {
  // Demo seeder — refuse on a non-demo-capable env so demo rows can never land in
  // a real-user environment. Local/CI classify to 'local' (allowed). SEED_FORCE=1 overrides.
  const deployEnv = currentServerDeployEnv()
  if (!isDemoCapableEnv(deployEnv) && process.env.SEED_FORCE !== '1') {
    console.error(`Refusing to seed demo homepage on env='${deployEnv}' (not demo-capable). Set SEED_FORCE=1 to override.`)
    process.exit(1)
  }

  const [tm] = await db`
    SELECT id::text, email, region_id::text AS region_id, org_unit_id::text AS org_unit_id
    FROM teammate WHERE email ILIKE '%priya%' LIMIT 1`
  if (!tm) throw new Error('demo persona Priya not found — run the seed first')
  const [rc] = await db`SELECT id::text, version FROM rate_card LIMIT 1`
  const projects = await db`
    SELECT p.id::text, p.code, p.code_hash, p.cost_owning_unit_id::text AS cou
    FROM project_assignment pa JOIN project p ON p.id = pa.project_id
    WHERE pa.teammate_id = ${tm.id}::uuid`

  // ── clean slate for Priya (idempotent) ──
  const projIds = projects.map((p) => p.id as string)
  await db`DELETE FROM attribution_record WHERE teammate_id = ${tm.id}::uuid`
  await db`DELETE FROM instance_attestation_health WHERE instance_id IN (SELECT instance_id FROM instance_attestation WHERE principal_oid = ${MARK})`
  await db`DELETE FROM instance_attestation WHERE principal_oid = ${MARK}`
  await db`DELETE FROM allocation WHERE scope_type = 'project' AND scope_id::text = ANY(${projIds})`
  await db`DELETE FROM session_assignment WHERE teammate_id = ${tm.id}::uuid`
  await db`DELETE FROM actual_spend WHERE teammate_id = ${tm.id}::uuid`

  // ── project budgets + attributed spend (AR project_id set) ──
  for (const p of projects) {
    const plan = PROJECT_PLAN[p.code as string]
    if (!plan) continue
    const [aud] = await db`
      INSERT INTO audit_event (event_type, actor_teammate_id, subject_kind, subject_id, payload)
      VALUES ('allocation-created', ${tm.id}::uuid, 'project', ${p.id}::uuid, '{"demo":true}'::jsonb)
      RETURNING id::text`
    await db`
      INSERT INTO allocation (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, audit_event_id, source)
      VALUES ('project', ${p.id}::uuid, NULL, ${plan.budget}, tstzrange(${mStart}::timestamptz, ${mEnd}::timestamptz, '[)'), 'baseline', ${aud.id}::uuid, ${MARK})`

    const instanceId = randomUUID()
    await db`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code, tool,
         session_token_hash, ts_start, region_id, org_unit_id, cost_owning_unit_id, attestation_state)
      VALUES (${instanceId}::uuid, ${MARK}, ${tm.email}, ${tm.id}::uuid, ${p.code_hash}, ${p.code}, 'claude-code',
              ${'h-' + instanceId}, ${iso(20)}::timestamptz, ${tm.region_id}::uuid, ${tm.org_unit_id}::uuid, ${p.cou}::uuid, 'attested')`
    await db`
      INSERT INTO attribution_record
        (instance_id, claude_session_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
         tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version, fidelity_tier, cost_basis, ts_event)
      VALUES (${instanceId}::uuid, ${randomUUID()}, ${tm.id}::uuid, ${p.id}::uuid, ${tm.region_id}::uuid,
              ${tm.org_unit_id}::uuid, ${p.cou}::uuid, 'claude-code', 'claude-sonnet-4-6', 'output',
              ${Math.round(plan.spend * 1000)}, ${plan.spend}, ${rc.id}::uuid, ${rc.version}, 'tier-1', 'measured', ${iso(4)}::timestamptz)`
  }

  // ── unallocated spend — itemised AR rows with project_id NULL (mig 0021) ──
  for (const u of UNTAGGED) {
    const instanceId = randomUUID()
    const convId = randomUUID()
    await db`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash, ts_start,
         region_id, org_unit_id, attestation_state)
      VALUES (${instanceId}::uuid, ${MARK}, ${tm.email}, ${tm.id}::uuid, 'claude-code', ${'h-' + instanceId},
              ${iso(u.hrs)}::timestamptz, ${tm.region_id}::uuid, ${tm.org_unit_id}::uuid, 'unassigned')`
    await db`
      INSERT INTO attribution_record
        (instance_id, claude_session_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
         tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version, fidelity_tier, cost_basis, ts_event, activity)
      VALUES (${instanceId}::uuid, ${convId}, ${tm.id}::uuid, NULL, ${tm.region_id}::uuid, ${tm.org_unit_id}::uuid, NULL,
              'claude-code', 'claude-sonnet-4-6', 'output', ${u.tokens}, ${u.cost}, ${rc.id}::uuid, ${rc.version},
              'tier-2', 'telemetry-only', ${iso(u.hrs)}::timestamptz, ${u.activity})`
    if (u.activity) {
      await db`
        INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, activity, source)
        VALUES (${convId}, ${tm.id}::uuid, NULL, ${u.activity}, ${MARK})`
    }
  }

  // ── actuals (reconciliation source) ──
  const attributed = Object.values(PROJECT_PLAN).reduce((a, p) => a + p.spend, 0)
  const untaggedTotal = UNTAGGED.reduce((a, u) => a + u.cost, 0)
  await db`
    INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
    VALUES (${tm.id}::uuid, ${today}::date, 'claude-code', 5000000, 1500000, ${(attributed + untaggedTotal).toFixed(6)}, ${MARK})`

  console.warn(`Seeded demo homepage for ${tm.email}: ${projects.length} budgeted projects, ${UNTAGGED.length} unallocated (${UNTAGGED.filter((u) => u.activity).length} tagged/spill), via attribution_record.`)
  await db.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
