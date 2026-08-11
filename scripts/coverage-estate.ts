/*
 * coverage-estate — the REPRESENTATIVE local estate, built through the REAL
 * ingestion path, with the expected figures written out beside it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Three releases in a row shipped defects that were structurally invisible
 * locally. The cause was not diligence: `seed-reporting-fixture` INSERTs rows
 * directly, so it can only be faithful where a human remembered a rule, and it
 * remembered few. Measured on 2026-08-06 it wrote 822 untagged rows carrying a
 * cost-owning unit (production leaves that NULL — `complete-spend.ts:201-205`),
 * and it writes `token_type='output'` on EVERY row, so the entire per-lane axis
 * — the subject of the `$0.00 lane` defect — could not occur in local data.
 *
 * This script writes NOTHING to `attribution_record`. It emits provider-shaped
 * inputs and lets PRODUCTION CODE write the rows:
 *
 *     spans ──▶ fake-azure-monitor (/admin/ingest) ──▶ runReadJoiner ──▶ rows
 *
 * So faithfulness stops being a rule someone copied and becomes a property of
 * construction: whatever the joiner enforces, the estate obeys, including the
 * invariants nobody thought to write down.
 *
 * ── WHY IT WRITES EXPECTATIONS ──────────────────────────────────────────────
 *
 * Because the inputs are generated here, the correct output is KNOWN, and it is
 * written to `coverage-expect.json` beside the estate.
 *
 * THE WALK DOES NOT YET COMPARE THOSE FIGURES TO THE SCREEN, and this comment
 * used to say it did. It reads the file and passes it through into
 * `findings.json`; nothing asserts one against the other, because the
 * expectations are keyed to the `@coverage.local` personas while the walk signs
 * in as the UI personas. The same overstatement was corrected in the walk and in
 * coverage-loop.md and survived here — an overstated gate is worse than a
 * missing one, so it is stated plainly in all three places or none.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node tools/fake-azure-monitor/server.js &          # PORT=8099
 *   DATABASE_URL=postgresql://…/tokenscope_visual \
 *   NUXT_AZURE_MONITOR_ENDPOINT=http://localhost:8099 \
 *   npx tsx scripts/coverage-estate.ts
 *
 * NEVER against a deployed database. Every row it causes is synthetic and every
 * persona email is under `@coverage.local`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { createDbClient } from '../drizzle/connect'
import * as schema from '../drizzle/schema'
import { LocalCollectorReader } from '../server/azure/reader'
import { runReadJoiner } from '../server/workers/azure-monitor-reader'
import { runAggregateRollup } from '../server/workers/aggregate-rollup'
import { blankFact, upsertProviderUsageFact } from '../server/workers/provider-fact'
import { currentServerDeployEnv } from '../shared/env/deploy-env'

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex')
const MARK = 'coverage-estate'
/*
 * Emission window for the demo personas. The charts they render are 30-day,
 * but the window reaches 42 days so the PREVIOUS month's same-day-count
 * window also holds real spend — "vs last month" on the usage cards compares
 * month-to-date against last month's first N days, and a window that starts
 * mid-month makes that read as a four-digit percentage on a screenshot.
 */
const DEMO_DAYS = 42

/**
 * THE COVERAGE MATRIX. One persona per shape the product must survive — not one
 * realistic org. A realistic org is what we had, and it hid every one of these.
 *
 * `priced` decides `cost_basis`: a span carrying `lawCostUsd` is the provider's
 * own number (rung 1, `measured`, NULL rate_card_id); one without falls back to
 * the rate card (`estimated`). Both occur in production and the wire now
 * distinguishes them, so both must exist here.
 */
interface Persona {
  key: string
  name: string
  /** false = never emitted; the API-only teammate (the rollout gap). */
  emits: boolean
  /** false = every span carries NO project claim → NULL cost-owning unit. */
  tagged: boolean
  priced: boolean
  tool: 'claude-code' | 'copilot-cli'
  /** all four lanes, or output-only (what the old fixture could express). */
  lanes: 'all' | 'output-only'
  models: string[]
  /** emit into the still-filling UTC day — the partial-day case. */
  todayPartial: boolean
  usdPerSpan: number
  spans: number
  /*
   * ── THE SECOND LANE ────────────────────────────────────────────────────────
   * `apiRatio` writes an API fact on the SAME days this persona emitted OTel,
   * sized as a multiple of its OTel total. Until this existed, every coverage
   * persona was single-lane — six OTel-only and one API-only — so no persona
   * ever carried both, and the whole reconciliation surface (the API−OTel gap,
   * the worklist item it becomes, the A/B decomposition) was unreachable from
   * the coverage estate.
   *
   * WHAT THIS DOES AND DOES NOT PRODUCE, stated because the commit that added
   * it overstated the second half. It writes the API side of the pair, so the
   * two lanes genuinely coexist on the same (teammate, day) and every surface
   * reading `provider_usage_fact` sees them. It does NOT run
   * `reconcileUnaccountedUsage`, so the API-minus-OTel gap is never MATERIALISED
   * as an `unaccounted_usage` row: claude-code and copilot-cli are not
   * ingest-only arm-3 tools, so nothing carries the difference into §A or onto
   * the worklist. `mixed-lanes` and the lifecycle pair therefore exercise the
   * two-lane READ, not the reconciliation WRITE. Running the production
   * reconciler for the seeded window is the next piece of work on this estate.
   *
   *   > 1  the ORDINARY shape: the provider counted more than we observed.
   *   < 1  OTEL OVER-EMITS. §A legitimately exceeds §B — a personal
   *        subscription emitting through an enrolled instance is the documented
   *        cause (shared/reports/types.ts:131). `ab-decomposition.ts` carries a
   *        whole floor term for it and warns it can "produce a wrong number
   *        that still LOOKS right"; with no such row in the estate that term
   *        evaluated to zero on every local run.
   */
  apiRatio: number | null
  /** Which provider reports the API lane — decides cost_type and banding. */
  apiProvider: 'anthropic' | 'github'
  /*
   * ── LIFECYCLE ──────────────────────────────────────────────────────────────
   * Every persona above is frozen in one state for the whole window. Real
   * teammates transition, and the transition is where attribution breaks:
   *   'joiner'  silent, then enrolled part-way — the spend before the enrolment
   *             is API-only and must not be lost.
   *   'lapsed'  emitting, then the enrolment stops — the API keeps reporting and
   *             §A must not silently flatline.
   */
  lifecycle: 'none' | 'joiner' | 'lapsed'
  /*
   * A SECOND DISCLOSED IDENTITY for the same human. `teammate_identity_map` has
   * always supported it and the estate has never written a single row, so
   * "one person, an enterprise login and a personal-subscription login" — and
   * "one email across an NFR org and a chargeable one" — were both unreachable.
   */
  altIdentities: Array<{ system: string; identifier: string; kind: string }>
}

const PERSONAS: Persona[] = [
  // ── the original seven: one steady state each ──────────────────────────────
  { key: 'otel-tagged',    name: 'Cov OTel Tagged',    emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-opus-4-5', 'claude-sonnet-5'], todayPartial: false, usdPerSpan: 0.50, spans: 40, apiRatio: null, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },
  { key: 'otel-untagged',  name: 'Cov OTel Untagged',  emits: true,  tagged: false, priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-opus-4-5'],                   todayPartial: false, usdPerSpan: 0.25, spans: 40, apiRatio: null, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },
  { key: 'otel-estimated', name: 'Cov OTel Estimated', emits: true,  tagged: true,  priced: false, tool: 'claude-code', lanes: 'all',         models: ['claude-sonnet-5'],                   todayPartial: false, usdPerSpan: 0,    spans: 24, apiRatio: null, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },
  { key: 'otel-outputonly',name: 'Cov Output Only',    emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'output-only', models: ['claude-haiku-4-5'],                  todayPartial: false, usdPerSpan: 0.10, spans: 20, apiRatio: null, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },
  { key: 'copilot-otel',   name: 'Cov Copilot OTel',   emits: true,  tagged: true,  priced: true,  tool: 'copilot-cli', lanes: 'output-only', models: ['gpt-5.6-sol'],                       todayPartial: false, usdPerSpan: 0.20, spans: 20, apiRatio: null, apiProvider: 'github',    lifecycle: 'none', altIdentities: [] },
  { key: 'today-partial',  name: 'Cov Today Partial',  emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-opus-4-5'],                   todayPartial: true,  usdPerSpan: 0.30, spans: 16, apiRatio: null, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },
  { key: 'never-emitted',  name: 'Cov Never Emitted',  emits: false, tagged: false, priced: false, tool: 'claude-code', lanes: 'all',         models: [],                                    todayPartial: false, usdPerSpan: 0,    spans: 0,  apiRatio: null, apiProvider: 'github',    lifecycle: 'none', altIdentities: [] },

  /*
   * ── BOTH LANES ON THE SAME DAYS ────────────────────────────────────────────
   * The reconciliation surface. `mixed-lanes` is the ordinary shape (the API
   * counted 1.25x what we observed, so a gap becomes a worklist item);
   * `otel-over` is the inverse and the one no local run has ever produced.
   */
  { key: 'mixed-lanes',    name: 'Cov Mixed Lanes',    emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-opus-4-5'],                   todayPartial: false, usdPerSpan: 0.40, spans: 20, apiRatio: 1.25, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },
  { key: 'otel-over',      name: 'Cov OTel Over',      emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-sonnet-5'],                   todayPartial: false, usdPerSpan: 0.40, spans: 20, apiRatio: 0.70, apiProvider: 'anthropic', lifecycle: 'none', altIdentities: [] },

  /*
   * ── ONE HUMAN, TWO DISCLOSED IDENTITIES ────────────────────────────────────
   * `dual-identity`: an enterprise login plus a personal-subscription login on a
   * different email. Both are this person's spend; only one is the company's
   * bill. `copilot-two-orgs`: ONE email, two GitHub orgs — one NFR-exempt, one
   * chargeable — so the exemption has to split WITHIN a single person rather
   * than between people, which is the shape a per-teammate rollup gets wrong.
   */
  { key: 'dual-identity',  name: 'Cov Dual Identity',  emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-opus-4-5'],                   todayPartial: false, usdPerSpan: 0.35, spans: 16, apiRatio: 1.10, apiProvider: 'anthropic', lifecycle: 'none',
    altIdentities: [
      { system: 'anthropic', identifier: 'cov.dual.personal@gmail.com', kind: 'email' },
      { system: 'entra',     identifier: 'dual-identity@coverage.local', kind: 'email' },
    ] },
  { key: 'copilot-two-orgs', name: 'Cov Copilot Two Orgs', emits: true, tagged: true, priced: true, tool: 'copilot-cli', lanes: 'output-only', models: ['gpt-5.6-sol'],                     todayPartial: false, usdPerSpan: 0.15, spans: 18, apiRatio: 1.00, apiProvider: 'github',    lifecycle: 'none',
    altIdentities: [
      { system: 'github', identifier: 'cov-two-orgs', kind: 'login' },
    ] },

  /*
   * ── STATE THAT CHANGES INSIDE THE WINDOW ───────────────────────────────────
   * The transitions, not the steady states. `joiner` is the attribution dead
   * zone: spend exists before the enrolment and must still reach a person.
   * `lapsed` is its mirror — the enrolment stops and the API keeps reporting, so
   * a flatlining §A is the bug to catch, not the expected reading.
   */
  { key: 'lifecycle-joiner', name: 'Cov Joiner',      emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-opus-4-5'],                   todayPartial: false, usdPerSpan: 0.30, spans: 12, apiRatio: 1.60, apiProvider: 'anthropic', lifecycle: 'joiner', altIdentities: [] },
  { key: 'lifecycle-lapsed', name: 'Cov Lapsed',      emits: true,  tagged: true,  priced: true,  tool: 'claude-code', lanes: 'all',         models: ['claude-sonnet-5'],                   todayPartial: false, usdPerSpan: 0.30, spans: 12, apiRatio: 1.60, apiProvider: 'anthropic', lifecycle: 'lapsed', altIdentities: [] },
]

const LANES = ['input', 'output', 'cache-read', 'cache-write'] as const

interface Expect {
  persona: string
  email: string
  emits: boolean
  tagged: boolean
  spansEmitted: number
  /** Σ lawCostUsd we handed the joiner. NULL when unpriced (rate card decides). */
  expectedCostUsd: number | null
  expectedLanes: string[]
  expectedModels: string[]
  tool: string
}

async function main() {
  const dbUrl = process.env.DATABASE_URL
  const endpoint = process.env.NUXT_AZURE_MONITOR_ENDPOINT
  if (!dbUrl || !endpoint) {
    console.error('coverage-estate: DATABASE_URL and NUXT_AZURE_MONITOR_ENDPOINT required')
    process.exit(1)
  }
  /*
   * FAIL CLOSED, not by pattern-match. The previous guard regex-matched
   * `prod|production|dev.|staging`, which a managed host sails straight
   * through: `tokenscope-sandbox.postgres.database.azure.com` matches nothing
   * and the script then deletes demo attribution rows on it. An allowlist of
   * things that look dangerous is the wrong shape — it is wrong by default and
   * right only where someone predicted the name.
   *
   * Two gates instead, both the reporting fixture's (assertLocalOnly): the
   * resolved deploy ENV must be `local`, and the DATABASE_URL host must be
   * loopback or a bare compose service name. A fully-qualified host is what a
   * managed Postgres looks like, whatever it is called. No override flag.
   */
  const env = currentServerDeployEnv()
  if (env !== 'local') {
    console.error(
      `\ncoverage-estate: REFUSING TO RUN.\n` +
        `  deploy env resolved to '${env}'; this estate is local-only. It deletes\n` +
        `  attribution rows for the demo personas and every @coverage.local row.\n`,
    )
    process.exit(1)
  }
  let dbHost: string
  try {
    dbHost = new URL(dbUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    console.error('\ncoverage-estate: REFUSING TO RUN — DATABASE_URL is not a parseable URL.\n')
    process.exit(1)
    return
  }
  /*
   * LOOPBACK, then REFUSE ANYTHING ADDRESSABLE. Two holes in the first cut,
   * both found by round 2 of the external review:
   *   - an IPv6 host has no dot, so `[2001:db8::1]` sailed through a
   *     `.includes('.')` check and would have reset a remote database;
   *   - `127.0.0.2` is loopback and was rejected, because only `127.0.0.1` was
   *     recognised.
   * The whole 127/8 block is loopback, and a host containing a dot OR a colon
   * is addressable somewhere. What remains is a bare name — a compose service —
   * which is what local dev actually looks like.
   */
  const loopback = dbHost === 'localhost' || /^127\./.test(dbHost) || dbHost === '::1'
  if (!loopback && (dbHost.includes('.') || dbHost.includes(':'))) {
    console.error(
      `\ncoverage-estate: REFUSING TO RUN.\n` +
        `  DATABASE_URL host '${dbHost}' is fully-qualified, which is what a managed\n` +
        `  Postgres looks like. Local dev is loopback or a compose service name.\n`,
    )
    process.exit(1)
  }
  const client = createDbClient(dbUrl, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema })
  const reader = new LocalCollectorReader(endpoint)
  const expectations: Expect[] = []

  try {
    // Anchor to an existing region/org-unit/project so the personas sit in a
    // real hierarchy rather than inventing one that the reports cannot resolve.
    const [anchor] = await db.execute<{
      region_id: string; org_unit_id: string; cou: string | null
      project_id: string; project_code: string; project_code_hash: string
    }>(sql`
      SELECT t.region_id::text, t.org_unit_id::text,
             p.cost_owning_unit_id::text AS cou,
             p.id::text AS project_id, p.code AS project_code, p.code_hash AS project_code_hash
      FROM teammate t
      JOIN project p ON p.cost_owning_unit_id IS NOT NULL
      WHERE t.is_active AND t.region_id IS NOT NULL AND t.org_unit_id IS NOT NULL
      LIMIT 1`)
    if (!anchor) throw new Error('coverage-estate: no anchor teammate/project — run the base seed first')

    /*
     * MEMBERSHIP, or the tag is refused. The joiner's rule is "tag proposes,
     * membership disposes" (azure-monitor-reader.ts:125): an emitted
     * project_code_hash is a CLAIM, and it is only honoured when the teammate is
     * assigned to that project. Without this row every tagged persona lands
     * untagged — which is what happened on the first run, and is the joiner
     * behaving correctly against an incomplete persona rather than a bug.
     */
    const ensureMembership = async (teammateId: string) => {
      await db.execute(sql`
        INSERT INTO project_assignment (project_id, teammate_id, effective, source, is_pinned)
        SELECT ${anchor.project_id}::uuid, ${teammateId}::uuid, tstzrange(NOW() - interval '90 days', NULL), ${MARK}, true
        WHERE NOT EXISTS (
          SELECT 1 FROM project_assignment
          WHERE project_id = ${anchor.project_id}::uuid AND teammate_id = ${teammateId}::uuid)`)
    }

    /*
     * RESET FIRST — the expectations must be EXACT, not "at least". Re-running
     * without this appends another emission window and every figure doubles,
     * which turns an assertion into a range and a range into no assertion at
     * all. Scoped to `@coverage.local` so it can never touch seeded or real
     * rows.
     */
    await db.execute(sql`
      DELETE FROM attribution_record WHERE teammate_id IN
        (SELECT id FROM teammate WHERE email LIKE '%@coverage.local')`)
    await db.execute(sql`
      DELETE FROM instance_attestation WHERE principal_email LIKE '%@coverage.local'`)
    /*
     * THE RESET MUST COVER WHAT THIS SCRIPT WRITES. It cleared attribution and
     * attestations but not `provider_usage_fact`, which this script also writes
     * — so a rerun the next day left the previous run's dated rows behind and
     * accumulated one stale API day per run, quietly inflating every figure
     * that reads the API lane. Scoped to this script's own marker.
     */
    await db.execute(sql`DELETE FROM provider_usage_fact WHERE source = ${MARK}`)
    // The demo personas' emission is ours too — reset it on the same terms, or a
    // second run doubles every figure a reviewer is looking at.
    await db.execute(sql`
      DELETE FROM attribution_record WHERE teammate_id IN
        (SELECT id FROM teammate WHERE email LIKE 'demo-%')
        AND instance_id IN (SELECT instance_id FROM instance_attestation
                             WHERE principal_oid LIKE 'oid-demo-%')`)
    await db.execute(sql`
      DELETE FROM instance_attestation WHERE principal_oid LIKE 'oid-demo-%'`)

    const sessionIds: string[] = []

    for (const p of PERSONAS) {
      const email = `${p.key}@coverage.local`
      /*
       * Idempotent by SELECT-then-INSERT, not ON CONFLICT: the unique index is
       * partial and expression-based (`lower(email) WHERE NOT provisional`), so
       * a plain conflict target does not match it (42P10). Re-running is a
       * no-op on the teammate and simply adds another emission window.
       */
      let teammateId: string
      const [found] = await db.execute<{ id: string }>(
        sql`SELECT id::text FROM teammate WHERE lower(email) = ${email} AND NOT provisional LIMIT 1`)
      if (found) {
        teammateId = found.id
      } else {
        const [made] = await db.execute<{ id: string }>(sql`
          INSERT INTO teammate (entra_oid, email, display_name, is_active, region_id, org_unit_id, source)
          VALUES (${`cov-oid-${p.key}`}, ${email}, ${p.name}, true,
                  ${anchor.region_id}::uuid, ${anchor.org_unit_id}::uuid, ${MARK})
          RETURNING id::text`)
        teammateId = made!.id
      }

      const exp: Expect = {
        persona: p.key, email, emits: p.emits, tagged: p.tagged,
        spansEmitted: 0, expectedCostUsd: p.priced ? 0 : null,
        expectedLanes: [], expectedModels: [...p.models], tool: p.tool,
      }

      if (p.tagged) await ensureMembership(teammateId)

      /** day (YYYY-MM-DD) -> OTel USD this persona emitted on it. */
      const perDayOtel = new Map<string, number>()

      if (p.emits) {
        const instanceId = randomUUID()
        const claudeSessionId = randomUUID()
        const lanes = p.lanes === 'all' ? [...LANES] : (['output'] as const)
        const spans: Record<string, unknown>[] = []
        for (let i = 0; i < p.spans; i++) {
          const lane = lanes[i % lanes.length]!
          const model = p.models[i % p.models.length]!
          // todayPartial → this UTC day; otherwise spread over the last 5 whole days.
          /*
           * WHICH DAYS THIS PERSONA WAS EMITTING ON. A steady persona covers the
           * last five whole days. A lifecycle persona covers only part of the
           * window, so the API lane below spans days it did NOT emit — which is
           * the whole point: 'joiner' has API-only days BEFORE its enrolment,
           * 'lapsed' has API-only days AFTER its enrolment stopped. A window
           * where both lanes always coincide cannot express either.
           */
          const dayBack =
            p.lifecycle === 'joiner' ? 1 + (i % 2)          // days 1-2: enrolled late
            : p.lifecycle === 'lapsed' ? 4 + (i % 2)        // days 4-5: stopped early
            : 1 + (i % 5)
          const ts = p.todayPartial
            ? new Date(Date.now() - 60 * 60 * 1000)
            : new Date(Date.now() - dayBack * 24 * 60 * 60 * 1000)
          const span: Record<string, unknown> = {
            tokens: 1000 + i * 37,
            tokenType: lane,
            model,
            tsEvent: ts.toISOString(),
            sourceRunId: `cov-${p.key}-${i}`,
            claudeSessionId,
          }
          // TAGGING IS THE EMITTED CLAIM (ADR-0004): no hash ⇒ no project ⇒ the
          // joiner leaves cost_owning_unit_id NULL. That is the shape that makes
          // a cost-centre page legitimately empty, and it was unreachable before.
          if (p.tagged) span.projectCodeHash = anchor.project_code_hash
          if (p.priced) { span.lawCostUsd = p.usdPerSpan; exp.expectedCostUsd = (exp.expectedCostUsd ?? 0) + p.usdPerSpan }
          if (p.tool === 'copilot-cli') span.nanoAiu = Math.round((p.usdPerSpan / 1e-11))
          spans.push(span)
          // Per-day OTel, so the API lane below can be a multiple of what was
          // actually OBSERVED that day rather than a flat share of the total.
          // A flat share silently inverts the ratio on days where emission
          // clustered, which made three personas over-emit by accident and
          // confounded the one shape each is supposed to isolate.
          const dayKey = ts.toISOString().slice(0, 10)
          perDayOtel.set(dayKey, (perDayOtel.get(dayKey) ?? 0) + (p.priced ? p.usdPerSpan : 0))
          if (!exp.expectedLanes.includes(lane)) exp.expectedLanes.push(lane)
        }
        exp.spansEmitted = spans.length

        const res = await fetch(`${endpoint}/admin/ingest`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: instanceId, usage: spans }),
        })
        if (!res.ok) throw new Error(`ingest failed for ${p.key}: ${res.status}`)

        await db.execute(sql`
          INSERT INTO instance_attestation
            (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
             raw_project_code, tool, session_token_hash, ts_start, region_id, org_unit_id,
             cost_owning_unit_id, attestation_state)
          VALUES (${instanceId}::uuid, ${`oid-${p.key}`}, ${email}, ${teammateId}::uuid,
                  ${p.tagged ? anchor.project_code_hash : null},
                  ${p.tagged ? anchor.project_code : null}, ${p.tool},
                  ${sha256Hex(`coverage:${instanceId}`)}, NOW(),
                  ${anchor.region_id}::uuid, ${anchor.org_unit_id}::uuid,
                  ${p.tagged ? anchor.cou : null},
                  /*
                   * 'unassigned', not 'attested', when there is no project.
                   * CHECK instance_attestation_attested_has_project forbids an
                   * attested instance without one, and production agrees: all
                   * 262 attested rows carry a project, all 29 unassigned rows do
                   * not. Modelling untagged usage as an attested instance with a
                   * NULL project is a state the database will not hold — which is
                   * exactly the kind of shape a direct-INSERT fixture happily
                   * invents and the real path refuses.
                   */
                  ${p.tagged ? 'attested' : 'unassigned'})
          ON CONFLICT (instance_id) DO NOTHING`)
        sessionIds.push(instanceId)
      }
      /*
       * ── THE SECOND LANE, AND THE SECOND IDENTITY ──────────────────────────
       * Both written through the production writer, on the SAME days the
       * persona emitted (plus the days it did not, for the lifecycle pair), so
       * the reconciliation surface has something to reconcile.
       */
      if (p.apiRatio !== null) {
        /*
         * Five whole days REGARDLESS of what the persona emitted on: a joiner's
         * earliest days and a lapsed persona's latest days carry API and no
         * OTel, which is the state each exists to produce.
         *
         * On a day that DID emit, the API is `observed x ratio` — so the ratio
         * means what it says per day, and `otel-over` is the only persona whose
         * OTel exceeds its API. On an API-only day there is nothing to scale,
         * so it takes the persona's typical daily spend: the provider kept
         * reporting while we saw nothing, which is the whole shape.
         */
        const typicalDay = (p.usdPerSpan * p.spans) / 5
        for (let d = 1; d <= 5; d++) {
          const day = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
          const observed = perDayOtel.get(day) ?? 0
          const perDay = observed > 0 ? observed * p.apiRatio : typicalDay
          const fact = blankFact({
            source: MARK,
            provider: p.apiProvider,
            providerOrgId: null,
            providerEnterpriseId: null,
            teammateId,
            actorRef: email,
            date: day,
            tool: p.tool,
            /*
             * GITHUB MONEY CARRIES NO MODEL — mig 0120's grain constraint:
             *   (provider <> 'github') OR (model IS NULL) OR (cost_usd IS NULL)
             * GitHub reports money and model on SEPARATE rows and the table
             * refuses to merge them, exactly as it refuses to merge a usage row
             * with a cost row. Anthropic reports both together, so it keeps its
             * model. Discovered by the constraint rejecting the write, which is
             * the estate obeying production rather than asserting them.
             */
            model: p.apiProvider === 'github' ? null : (p.models[0] ?? null),
            costType: p.apiProvider === 'anthropic' ? 'tokens' : 'ai-credits',
            /*
             * BANDED on Anthropic, NULL on GitHub. The poller asks both Anthropic
             * reports for context_window (analytics-poller.ts:492-493); Copilot
             * has no such concept, so NULL there is the provider's answer rather
             * than a gap.
             */
            contextWindow: p.apiProvider === 'anthropic' ? (d % 3 === 0 ? '200k+' : '0-200k') : null,
            currency: 'USD',
          })
          fact.costUsd = Number(perDay.toFixed(6))
          await upsertProviderUsageFact(db, fact)
        }
      }

      for (const id of p.altIdentities) {
        /*
         * `is_canonical` stays FALSE: the canonical identity is the Entra
         * binding on the teammate row itself. These are the ADDITIONAL disclosed
         * logins — a personal-subscription email, a GitHub login — that belong to
         * the same human and must roll up to one person without double-counting.
         */
        await db.execute(sql`
          INSERT INTO teammate_identity_map
            (teammate_id, system, identifier, identifier_kind, is_canonical, source, is_pinned)
          VALUES (${teammateId}::uuid, ${id.system}, ${id.identifier}, ${id.kind}, false, ${MARK}, true)
          ON CONFLICT DO NOTHING`)
      }

      expectations.push(exp)
    }

    /*
     * ── THE API LANE ────────────────────────────────────────────────────────
     * The never-emitted persona is the ROLLOUT GAP: real spend, visible only
     * through the provider's API, invisible to us as an emitter. Without an API
     * row it is merely an inactive teammate, which is a different shape and
     * tests nothing.
     *
     * Written through `upsertProviderUsageFact` — the single production writer
     * for this table — so the grain key and the unique index decide the shape
     * rather than an INSERT of mine. `contextWindow: null` is FAITHFUL HERE for
     * a reason specific to this row: it is a GITHUB fact, and Copilot has no
     * context-window concept to report. NOT because the dimension is unasked —
     * the poller does ask, on both Anthropic reports (analytics-poller.ts:
     * 492-493). Anthropic rows are banded; see seed-reporting-fixture.ts.
     */
    const [neverEmitted] = await db.execute<{ id: string }>(
      sql`SELECT id::text FROM teammate WHERE lower(email) = 'never-emitted@coverage.local' AND NOT provisional LIMIT 1`)
    if (neverEmitted) {
      const day = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const fact = blankFact({
        source: MARK, provider: 'github', providerOrgId: null, providerEnterpriseId: null,
        teammateId: neverEmitted.id, actorRef: 'never-emitted@coverage.local',
        date: day, tool: 'copilot-cli', model: null,
        /*
         * A COST row, so it carries `costType` and NO token measures. CHECK
         * provider_usage_fact_measure_chk holds the two shapes apart: either
         * (no cost_type, no cost_usd) — a usage row — or (cost_type set, every
         * token column NULL) — a cost row. They are the provider's two separate
         * reports and the table refuses to merge them. 'ai-credits' is GitHub's
         * own cost_type, verbatim from the adapter, not a value invented here.
         */
        costType: 'ai-credits',
        contextWindow: null, currency: 'USD',
      })
      fact.costUsd = 12.34
      fact.requests = 262
      await upsertProviderUsageFact(db, fact)
      expectations.push({
        persona: 'never-emitted-api', email: 'never-emitted@coverage.local',
        emits: false, tagged: false, spansEmitted: 0, expectedCostUsd: 12.34,
        expectedLanes: [], expectedModels: [], tool: 'copilot-cli',
      })
    }

    /*
     * ── OTel FOR THE PERSONAS A REVIEWER CAN ACTUALLY BE ────────────────────
     * Measured 2026-08-07: all nine demo teammates had ZERO attribution_record
     * rows, so every persona reachable through dev-login was API-ONLY. The
     * consequence was not subtle — the whole telemetry half of the product
     * (session economics, the surface split, context bands, the 30-day trend)
     * rendered empty or degraded on every screen anyone could sign in to, and
     * a reviewer had no way to see it working.
     *
     * `dev-login` accepts a fixed enum of ROLE keys, not an email, so the
     * coverage personas can never be assumed. The fix therefore runs the other
     * way: give the personas that CAN be assumed a real emission history,
     * through the same production path as everything else here.
     */
    /*
     * The demo personas tag their spend to the seeded BUDGETED project
     * (CSL-AII carries a live current-month allocation), not the generic
     * anchor: a developer hero card reading "2% of allocated" above an
     * $800/month recent-spend strip is the incoherence screenshots exist to
     * avoid. Falls back to the anchor when the demo grid isn't seeded.
     */
    const [demoBudgetProject] = await db.execute<{
      project_id: string; project_code: string; project_code_hash: string
    }>(sql`
      SELECT id::text AS project_id, code AS project_code, code_hash AS project_code_hash
      FROM project WHERE code = 'CSL-AII' LIMIT 1`)
    const demoProject = demoBudgetProject ?? anchor
    const ensureDemoMembership = async (teammateId: string) => {
      await db.execute(sql`
        INSERT INTO project_assignment (project_id, teammate_id, effective, source, is_pinned)
        SELECT ${demoProject.project_id}::uuid, ${teammateId}::uuid, tstzrange(NOW() - interval '90 days', NULL), ${MARK}, true
        WHERE NOT EXISTS (
          SELECT 1 FROM project_assignment
          WHERE project_id = ${demoProject.project_id}::uuid AND teammate_id = ${teammateId}::uuid)`)
    }

    const demoTeammates = await db.execute<{ id: string; email: string }>(sql`
      SELECT id::text, email FROM teammate
       WHERE email LIKE 'demo-%' AND is_active AND NOT provisional
       ORDER BY email`)
    const demoSessionIds: string[] = []
    for (const [n, dt] of [...demoTeammates].entries()) {
      const instanceId = randomUUID()
      const spans: Record<string, unknown>[] = []
      /*
       * SEVERAL SESSIONS, not one. The first cut gave each persona a single
       * claudeSessionId for all 24 spans across five days, so every
       * session-shaped surface read "1 session so far — a distribution needs a
       * few days". The card was honest; the estate was the thing that could not
       * hold a distribution. A person runs `claude` many times a day, and the
       * median/p90/top-share read is meaningless against a single session.
       *
       * Two or three sessions per day, deterministic per persona.
       */
      const sessionByDay = new Map<number, string[]>()
      for (let d = 1; d <= DEMO_DAYS; d++) {
        sessionByDay.set(d, Array.from({ length: 2 + ((d + n) % 2) }, () => randomUUID()))
      }
      /*
       * THIRTY DAYS, NOT FIVE. The first cut emitted over the last five days, so
       * every 30-day chart drew five bars crammed against the right edge of an
       * otherwise empty axis — the data was correct and the CHART was untestable:
       * nothing about shape, trend, weekday rhythm or the 7-day mean could be
       * judged from it, and a reviewer could not tell an empty window from a
       * broken one.
       *
       * A weekday shape, so the line has rhythm rather than noise: weekends run
       * light. Deterministic per persona — no Math.random anywhere in this file.
       */
      let seq = 0
      for (let d = DEMO_DAYS; d >= 1; d--) {
        const ts0 = new Date(Date.now() - d * 24 * 60 * 60 * 1000)
        const weekend = [0, 6].includes(ts0.getUTCDay())
        const perDay = weekend ? 1 : 2 + ((d + n) % 3)
        const daySessions = sessionByDay.get(d)!
        for (let k = 0; k < perDay; k++, seq++) {
          const ts = new Date(ts0.getTime() + (9 + k * 3) * 60 * 60 * 1000)
          spans.push({
            // Magnitudes are calibrated to the owner's yardstick (2026-08-11):
            // a normal Claude Code developer runs $500–1000/month — anything
            // smaller makes the budget-splitting premise look pointless on a
            // screenshot. ~$4–12 per span × 1–4 spans/day ≈ $650/month pace,
            // with token counts kept coherent (~$5/M blended).
            tokens: (900 + seq * 53 + n * 11) * 400,
            tokenType: LANES[seq % LANES.length],
            model: seq % 3 === 0 ? 'claude-sonnet-5' : 'claude-opus-4-5',
            tsEvent: ts.toISOString(),
            sourceRunId: `cov-demo-${n}-${seq}`,
            claudeSessionId: daySessions[k % daySessions.length]!,
            projectCodeHash: demoProject.project_code_hash,
            // Amount varies by day and persona, so a trend line has shape.
            lawCostUsd: Number((4.2 + n * 0.5 + ((d * 7 + n * 3) % 5) * 2.1).toFixed(4)),
          })
        }
      }
      const r = await fetch(`${endpoint}/admin/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: instanceId, usage: spans }),
      })
      if (!r.ok) throw new Error(`demo ingest failed for ${dt.email}: ${r.status}`)
      // Membership, or the joiner refuses the tag (tag proposes, membership disposes).
      await ensureMembership(dt.id)
      await ensureDemoMembership(dt.id)
      await db.execute(sql`
        INSERT INTO instance_attestation
          (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
           raw_project_code, tool, session_token_hash, ts_start, region_id, org_unit_id,
           cost_owning_unit_id, attestation_state)
        VALUES (${instanceId}::uuid, ${`oid-demo-${n}`}, ${dt.email}, ${dt.id}::uuid,
                ${anchor.project_code_hash}, ${anchor.project_code}, 'claude-code',
                ${sha256Hex(`coverage:${instanceId}`)}, NOW(),
                ${anchor.region_id}::uuid, ${anchor.org_unit_id}::uuid,
                ${anchor.cou}, 'attested')
        ON CONFLICT (instance_id) DO NOTHING`)
      demoSessionIds.push(instanceId)
    }
    sessionIds.push(...demoSessionIds)

    // PRODUCTION CODE WRITES THE ROWS. Nothing above touched attribution_record.
    const joined = await runReadJoiner(db, reader, { sessionIds })

    /*
     * ── THE EXPECTATIONS ARE NOW CHECKED ────────────────────────────────────
     * They used to be written to a file and never compared to anything, by
     * anyone: the walk reads the file and passes it through untouched. So the
     * estate could hand the joiner $20.00 of spans, the joiner could write
     * $12.00, and every gate in the loop stayed green.
     *
     * This asserts the ONE thing this script is entitled to assert — that the
     * production writer wrote what it was handed. Σ attribution_record.cost_usd
     * per persona MUST equal Σ lawCostUsd emitted for it.
     *
     * It is not tautological. It goes red if the joiner drops spans, prices them
     * off the rate card when the wire carried a cost, or the membership gate
     * refuses a tag and the rows land somewhere else. Each of those is a real
     * failure that produced a silently smaller estate before now.
     *
     * Unpriced personas are EXCLUDED, not asserted at zero: their cost is the
     * rate card's to decide (`cost_basis='estimated'`), so a figure from here
     * would be asserting the rate card against itself.
     */
    /*
     * ── THE AGGREGATES THE UI ACTUALLY READS ────────────────────────────────
     * The joiner writes `attribution_record`; the daily-spend chart, Top models
     * and every other trend surface read `spend_rollup_daily` /
     * `spend_session_daily`, which a WORKER computes. Without this the estate
     * was faithful in the raw table and empty in every aggregate: 24 modelled
     * OTel rows for a persona whose /usage page said "No telemetry-observed
     * spend in this window" and "Models named for $0.00 · 0%".
     *
     * Exactly the failure this loop exists to prevent — a surface that is
     * structurally unreachable locally — reintroduced by an estate that stopped
     * one step short of what the product reads.
     */
    await runAggregateRollup(db, { lookbackDays: 40, backfillDays: 40 })

    const drift: string[] = []
    for (const exp of expectations) {
      if (exp.expectedCostUsd === null || !exp.emits || exp.spansEmitted === 0) continue
      const [row] = await db.execute<{ usd: string | null }>(sql`
        SELECT COALESCE(SUM(ar.cost_usd), 0)::text AS usd
          FROM attribution_record ar
          JOIN teammate t ON t.id = ar.teammate_id
         WHERE lower(t.email) = ${exp.email}`)
      const actual = Number(row?.usd ?? 0)
      // 1c tolerance: the joiner rounds per row at 6dp, we sum at 2.
      if (Math.abs(actual - exp.expectedCostUsd) > 0.01) {
        drift.push(`${exp.persona}: emitted $${exp.expectedCostUsd.toFixed(2)}, joiner wrote $${actual.toFixed(2)}`)
      }
    }
    if (drift.length) {
      console.error('coverage-estate: THE ESTATE IS NOT WHAT IT CLAIMS —')
      for (const d of drift) console.error(`  ${d}`)
      throw new Error(`coverage-estate: ${drift.length} persona(s) drifted from their emitted total`)
    }

    writeFileSync('tmp/coverage-expect.json', JSON.stringify({ generatedFor: 'local only', expectations }, null, 1))

    console.warn(
      `coverage-estate: ${PERSONAS.length} personas, ${sessionIds.length} emitting; ` +
      `joiner wrote ${joined.attributionRowsWritten} rows (skipped ${joined.spansSkippedNoRateCard}); ` +
      `every priced persona's total matches what it emitted. ` +
      `expectations -> tmp/coverage-expect.json`)
  } finally {
    await client.end({ timeout: 5 })
  }
}

void main()
