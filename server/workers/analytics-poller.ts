/*
 * Anthropic analytics poller — pulls a usage-report window and upserts
 * actual_spend rows.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 9: "hourly BullMQ job, calls
 * the mock endpoint, upserts to actual_spend". Idempotent — the unique
 * constraint (teammate_id, date, tool, source) collapses re-pulls.
 *
 * Maps record.actor.email_address → teammate via teammate.email lookup;
 * skips records for unknown emails (logs the count, doesn't fail).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'
import {
  AnthropicAnalyticsClient,
  daysInclusive,
  recordEmail,
  recordDate,
  sumRecordInputTokens,
  sumRecordOutputTokens,
  sumRecordCostUsd,
  type UsageRecord,
} from '../anthropic/client'
import {
  AnthropicEnterpriseClient,
  centsStringToUsd,
  type EnterpriseUsageRow,
  type EnterpriseCostRow,
} from '../anthropic/enterprise-client'
import { readSecret } from '../reconciliation/credentials'
import { enqueueOwedBill } from '../reconciliation/placement-store'
import {
  teammateDimensionSnapshotSql,
  DIMENSION_SOURCE_INGEST_SNAPSHOT,
} from '../reconciliation/dimension-snapshot'
import {
  resolveAnthropicGovernanceKey,
  createGovernanceKeyCache,
  type GovernanceKeyRef,
} from '../reconciliation/governance-keys'
import {
  loadGovernanceResolutionContext,
  resolveAnthropicVerdict,
  type Verdict,
} from '../governance/verdict'
import { recordAuditEvent } from '../db/audit'
import {
  mapProductToTool,
  isKnownProduct,
  CLAUDE_CODE_TOOL,
  CLAUDE_FAMILY_TOOLS,
} from '../../shared/usage/surface'

/* An unknown-email (no teammate yet) owed bill, aggregated per (email, day, tool)
 * so multiple records sum rather than overwrite — the bill-driven-placement
 * trigger. The tool rides the aggregate (#142) so the placement-sync replay
 * preserves the surface lane (pending_placement's unique key already includes
 * tool). The poller ENQUEUES these (no Graph, just a durable INSERT); the
 * placement-sync worker provisions+places the user and replays them into
 * actual_spend (M2). */
interface OwedAgg {
  email: string
  date: string
  tool: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}
function accumulateOwed(m: Map<string, OwedAgg>, email: string, date: string, tool: string, inT: number, outT: number, cost: number): void {
  const e = email.toLowerCase()
  const key = `${e}:${date}:${tool}`
  const a = m.get(key) ?? { email: e, date, tool, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  a.inputTokens += inT
  a.outputTokens += outT
  if (Number.isFinite(cost)) a.costUsd += cost
  m.set(key, a)
}
async function flushOwed(
  db: PostgresJsDatabase<typeof schema>,
  m: Map<string, OwedAgg>,
  args: { source: string; governanceKey: GovernanceKeyRef },
): Promise<void> {
  for (const a of m.values()) {
    await enqueueOwedBill(db, {
      provider: 'anthropic',
      actualSource: args.source,
      email: a.email,
      tool: a.tool,
      date: a.date,
      costUsd: a.costUsd,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      providerOrgId: args.governanceKey.providerOrgId,
      providerEnterpriseId: args.governanceKey.providerEnterpriseId,
    })
  }
}

export interface PollResult {
  daysPulled: number
  recordsTotal: number
  recordsUpserted: number
  recordsSkippedUnknownUser: number
  /* Enterprise (per-surface) poll observability — #142. Upserted rows per tool
   * lane; raw `product` values that fell to the claude-other lane (value →
   * occurrence count; NEVER dropped, always labelled); and how many stale rows
   * the post-pull convergence pass pruned (see the cleanup note in
   * runEnterpriseAnalyticsPoll). Absent on the Admin (claude_code-only) path. */
  rowsByTool?: Record<string, number>
  unknownProducts?: Record<string, number>
  staleRowsDeleted?: number
  /*
   * The largest single (day, report) row count seen this run — the number that
   * actually sits against the client's ceiling of PAGE_LIMIT (1000) x MAX_PAGES
   * (100) = 100k rows per report per day, past which pages() throws.
   *
   * Recorded because adding a group_by dimension MULTIPLIES rows, and the
   * honest way to decide whether the next dimension is affordable is to read
   * what the last one cost rather than to argue about sparsity.
   *
   * rows/PAGE_LIMIT is a LOWER BOUND on pages, not a page count: the client
   * does not report how many it followed, and a short page costs the same page
   * budget as a full one. Good enough to see an order-of-magnitude move; not
   * good enough to sit close to the ceiling on. Absent on the Admin path.
   */
  peakRowsPerDayReport?: number
}

export interface PollOptions {
  startingAt: string // YYYY-MM-DD
  endingAt: string // YYYY-MM-DD
  /*
   * The Anthropic org this poll is for (provider_org.external_org_id). Encoded
   * into actual_spend.source as `anthropic-analytics-api:<orgId>` so the same
   * teammate active in multiple reconciled orgs gets one row per org (the
   * unique key is (teammate_id, date, tool, source)). Omitted → the legacy
   * single-org source 'anthropic-analytics-api'.
   */
  externalOrgId?: string
}

// Exported so server/reconciliation/source-org-ref.ts can parse this exact
// convention back apart without duplicating (and risking drift on) the literal.
export const SOURCE_PREFIX = 'anthropic-analytics-api'
export function sourceForOrg(externalOrgId?: string): string {
  return externalOrgId ? `${SOURCE_PREFIX}:${externalOrgId}` : SOURCE_PREFIX
}

/*
 * One (teammate, date, tool) aggregate ready to upsert into actual_spend. Both
 * the Admin (claude_code) and Enterprise-analytics pollers reduce a day's
 * records to these by the conflict key (teammate_id, date, tool) before writing
 * — DO UPDATE would otherwise let the last record CLOBBER earlier ones for the
 * same actor-day-surface. The Admin path only ever writes tool='claude-code'
 * (its endpoint is Code-specific by definition); the Enterprise path writes one
 * lane per `product` surface (#142) via mapProductToTool.
 */
interface ActualSpendAgg {
  teammateId: string
  date: string // YYYY-MM-DD
  tool: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  /* Verbatim source rows (one record → the record itself; many → the array). */
  rawPayload: unknown
}

/*
 * Idempotent actual_spend upsert shared by both pollers. The unique key is
 * (teammate_id, date, tool, source); tool is the aggregate's surface lane.
 * Returns true if a row was written/updated (always, given RETURNING id).
 * costUsd is fixed to 6 dp for the PG numeric; callers must pre-filter
 * non-finite cost so a single 'NaN' can't poison the column.
 *
 * Historical-homing dimension snapshot (mig 0101, design §3.1): stamped on
 * INSERT only, at the teammate's CURRENT placement — and deliberately absent
 * from the ON CONFLICT SET list, so a re-poll of an already-written day
 * refreshes cost/tokens/raw_payload but never re-homes it against a
 * post-reorg placement (server/reconciliation/dimension-snapshot.ts).
 *
 * Governance key + verdict (mig 0103, Workstream B): `governance.key` is the
 * SAME (provider_org_id, provider_enterprise_id) for the whole poll call (one
 * Anthropic org per call — resolved ONCE by the caller, not per row).
 * `governance.verdict` is likewise constant per call because only the provider
 * billing unit can decide §B chargeability. The verdict is NO LONGER frozen by a
 * period close: a re-poll refreshes it like any other field, and a month that
 * moves after being recorded reports the difference as a delta (mig 0128).
 */
/*
 * Exported for tests, deliberately — the seam outlived the guard that motivated
 * it. Migration 0116's close trigger interacted with ON CONFLICT specifically (a
 * BEFORE INSERT fires before Postgres resolves the conflict), and that was
 * missed once because the guard's tests used raw INSERT/UPDATE rather than the
 * shape production issues. 0128 drops the trigger, but "test the statement
 * production actually runs, not a re-implementation of it" is the lesson worth
 * keeping.
 */
export async function upsertActualSpend(
  db: PostgresJsDatabase<typeof schema>,
  agg: ActualSpendAgg,
  source: string,
  governance: { key: GovernanceKeyRef; verdict: Verdict },
): Promise<boolean> {
  const teammateIdSql = sql`${agg.teammateId}::uuid`
  const dims = teammateDimensionSnapshotSql(teammateIdSql)
  const result = await db.execute<{ id: string }>(
    sql`
      INSERT INTO actual_spend
        (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, raw_payload,
         region_id, org_unit_id, cost_owning_unit_id, dimension_source,
         provider_org_id, provider_enterprise_id, governance_key_status,
         chargeback_exempt, governance_verdict_source)
      VALUES
        (${agg.teammateId}::uuid, ${agg.date}::date, ${agg.tool},
         ${agg.inputTokens}::bigint, ${agg.outputTokens}::bigint,
         ${agg.costUsd.toFixed(6)}::numeric, ${source},
         ${JSON.stringify(agg.rawPayload)}::jsonb,
         ${dims.regionId}, ${dims.orgUnitId}, ${dims.costOwningUnitId}, ${DIMENSION_SOURCE_INGEST_SNAPSHOT},
         ${governance.key.providerOrgId}::uuid, ${governance.key.providerEnterpriseId}::uuid,
         ${governance.key.providerOrgId ? 'resolved' : 'unresolved'},
         ${governance.verdict.exempt}, ${governance.verdict.source})
      ON CONFLICT (teammate_id, date, tool, source)
      DO UPDATE SET
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cost_usd = EXCLUDED.cost_usd,
        raw_payload = EXCLUDED.raw_payload,
        pulled_at = NOW(),
        provider_org_id = EXCLUDED.provider_org_id,
        provider_enterprise_id = EXCLUDED.provider_enterprise_id,
        governance_key_status = EXCLUDED.governance_key_status,
        chargeback_exempt = EXCLUDED.chargeback_exempt,
        governance_verdict_source = EXCLUDED.governance_verdict_source
      RETURNING id::text AS id
    `,
  )
  return result.length > 0
}

/*
 * teammate.email → REAL teammate id, cached per email. MONEY-PATH GUARD
 * (PR #87 FIX 1): teammate.email is a PARTIAL unique index (mig 0057, WHERE NOT
 * provisional) — a real teammate and a provisional shadow can share an email.
 * actual_spend is the provider bill, so it MUST bind the REAL teammate: filter
 * `NOT provisional` (unique by the partial index; ORDER BY id is a deterministic
 * tiebreak).
 *
 * CASE-INSENSITIVE (lower(email)=lower($1)): bill-driven placement stores
 * createBillTeammate emails lowercased, while provider bills carry mixed-case
 * actor emails (First.Last@example.com). A case-SENSITIVE match would never
 * re-resolve a bill teammate — re-enqueuing it forever AND dropping cost revisions
 * after placement. This now matches the placement store's findTeammateByEmail so
 * the poller, placement, and reconciliation all bind the SAME teammate.
 */
async function resolveTeammateId(
  db: PostgresJsDatabase<typeof schema>,
  cache: Map<string, string | null>,
  email: string,
): Promise<string | null> {
  const key = email.toLowerCase() // normalise so mixed-case re-polls hit one cache slot
  let tmId = cache.get(key)
  if (tmId === undefined) {
    const [tm] = await db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM teammate
           WHERE lower(email) = lower(${email}) AND NOT provisional
           ORDER BY id LIMIT 1`,
    )
    tmId = tm?.id ?? null
    cache.set(key, tmId)
  }
  return tmId
}

export async function runAnalyticsPoll(
  db: PostgresJsDatabase<typeof schema>,
  client: AnthropicAnalyticsClient,
  opts: PollOptions,
): Promise<PollResult> {
  const source = sourceForOrg(opts.externalOrgId)
  let daysPulled = 0
  let total = 0
  let upserted = 0
  let skipped = 0

  // Governance key + base verdict (mig 0103): resolved ONCE for this org — every
  // aggregate this call writes belongs to the SAME Anthropic provider_org.
  const governanceKey = await resolveAnthropicGovernanceKey(db, createGovernanceKeyCache(), opts.externalOrgId)
  const governanceCtx = await loadGovernanceResolutionContext(db)
  const verdict = resolveAnthropicVerdict(governanceCtx, { providerOrgId: governanceKey.providerOrgId })

  // ING-4: the upsert key is (teammate_id, date, tool, source) but the API can
  // yield >1 record per actor-day (e.g. API + subscription, per subscription_type)
  // — and a paginated pull can split one day across pages. DO UPDATE would let
  // the last record CLOBBER the others, so aggregate by conflict key first.
  interface DayAgg extends ActualSpendAgg {
    recs: UsageRecord[]
  }
  const teammateCache = new Map<string, string | null>()
  const owed = new Map<string, OwedAgg>() // unknown-email bills → placement queue

  // ING-2: the real claude_code endpoint is single-day-per-request (the
  // reconciliation adapter already iterates per UTC day) — do the same here
  // instead of one month-wide call that only ever returned the first slice.
  for (const day of daysInclusive(opts.startingAt, opts.endingAt)) {
    const report = await client.getClaudeCodeUsage({ startingAt: day })
    // One loop iteration == one day pulled. (Pre-reshape, data[] held day-wrappers
    // so data.length happened to equal the day count; the FLAT per-user data[] makes
    // data.length the RECORD count, so count days explicitly.)
    daysPulled += 1
    const aggs = new Map<string, DayAgg>()
    // Real shape: data[] is a FLAT array of per-user records; tokens/cost live under
    // model_breakdown[] (cents). recordEmail/recordDate/sum* encapsulate that.
    for (const rec of report.data) {
      total += 1
      const email = recordEmail(rec)
      if (!email) {
        skipped += 1 // api_actor / no email -> can't bind a teammate
        continue
      }
      const tmId = await resolveTeammateId(db, teammateCache, email)
      if (!tmId) {
        skipped += 1
        // Don't drop it: enqueue the owed bill so placement-sync can provision the
        // user later and replay it into actual_spend (never $0, never lost).
        accumulateOwed(owed, email, recordDate(rec), CLAUDE_CODE_TOOL, sumRecordInputTokens(rec), sumRecordOutputTokens(rec), sumRecordCostUsd(rec))
        continue
      }
      const recDate = recordDate(rec)
      const key = `${tmId}:${recDate}`
      const agg = aggs.get(key) ?? {
        teammateId: tmId,
        date: recDate,
        tool: CLAUDE_CODE_TOOL, // the Admin claude_code endpoint is Code-specific by definition
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        rawPayload: null,
        recs: [],
      }
      agg.inputTokens += sumRecordInputTokens(rec)
      agg.outputTokens += sumRecordOutputTokens(rec)
      // Guard the sum (PG numeric accepts 'NaN'; one garbage record must not
      // poison the whole actor-day aggregate).
      const cost = sumRecordCostUsd(rec)
      if (Number.isFinite(cost)) {
        agg.costUsd += cost
      } else {
        consola.warn(`[analytics-poll] non-numeric estimated_cost skipped for ${agg.date}`)
      }
      agg.recs.push(rec)
      aggs.set(key, agg)
    }
    for (const agg of aggs.values()) {
      agg.rawPayload = agg.recs.length === 1 ? agg.recs[0] : agg.recs
      if (await upsertActualSpend(db, agg, source, { key: governanceKey, verdict })) upserted += 1
    }
  }

  await flushOwed(db, owed, { source, governanceKey })
  return {
    daysPulled,
    recordsTotal: total,
    recordsUpserted: upserted,
    recordsSkippedUnknownUser: skipped,
  }
}

/*
 * Enterprise-analytics poller (HIGH-A): the Claude Enterprise Analytics API
 * counterpart of runAnalyticsPoll. It gives enterprise orgs the SAME bill-anchored
 * actual_spend coverage as Admin/claude_code orgs — same target table, same
 * conflict key, same upsert. The reconciliation adapter's pullEnterpriseAnalytics
 * branch is mirrored here for the pull shape; the difference is the SINK: this
 * writes per-teammate-day actual_spend rows, the adapter writes reconciliation
 * ReconciledLines.
 *
 * Per UTC day (daysInclusive) we pull SERIALLY (NOT Promise.all — the Enterprise
 * API caps at 60 RPM org-wide, shared with reconciliation-sync) the usage + cost
 * reports with group_by[]=product&group_by[]=model over ALL products, then
 * aggregate per (teammate, day, SURFACE) — one lane per `product` via
 * mapProductToTool (#142: chat/Cowork/Office/etc are separate chargeback lanes,
 * no longer folded into the Claude Code number):
 *   - input_tokens  = Σ uncached_input_tokens   (usage rows)
 *   - output_tokens = Σ output_tokens           (usage rows)
 *   - cost_usd      = Σ token cost (centsStringToUsd) for cost rows where
 *                     cost_type is 'tokens' or null. web_search / code_execution
 *                     are EXCLUDED — those are ORG-GRAIN tool costs surfaced by the
 *                     reconciliation adapter at the cost-owning unit, NOT per-teammate
 *                     actual_spend (§8.5). Folding them in would inflate a developer's
 *                     bill-anchored spend with costs they don't personally own.
 * Unknown / unattributable products land in the labelled 'claude-other' lane and
 * are REPORTED (unknownProducts) — never silently dropped, never re-collapsed
 * into claude-code (the no-silent-cap rule; future surfaces stay visible).
 *
 * STALE-ROW CONVERGENCE: the upsert never deletes, so a (teammate, day) whose
 * spend previously collapsed into one 'claude-code' row (pre-split) — or whose
 * spend was revised away — would linger at its old value unless this run happens
 * to rewrite that exact (tool) key. After a FULLY-successful window pull we
 * therefore prune rows in (this source × the pulled window × the Claude-family
 * lanes) whose pulled_at predates this run: whatever the pull did not re-assert
 * is no longer part of the provider truth. Scoped strictly to this source +
 * window + CLAUDE_FAMILY_TOOLS so copilot/other sources are untouched; skipped
 * entirely if any day failed (a thrown day aborts before the prune).
 *
 * Identity: actor.email, null/deleted skipped (counted), resolved via the same
 * `NOT provisional` money-path guard as runAnalyticsPoll + the adapter.
 *
 * recordsTotal counts the source rows considered (usage + cost). daysPulled counts
 * DAYS, not records.
 */
export async function runEnterpriseAnalyticsPoll(
  db: PostgresJsDatabase<typeof schema>,
  client: AnthropicEnterpriseClient,
  opts: PollOptions,
): Promise<PollResult> {
  const source = sourceForOrg(opts.externalOrgId)
  let daysPulled = 0
  let peakRowsPerDayReport = 0
  /* Rows that ATTEMPTED identity resolution — the prune guard's denominator.
   * Distinct from `total` (reported as recordsTotal): org-grain tool rows are
   * counted there but never here, because they never try to bind a teammate. */
  let identityEligible = 0
  let total = 0
  let upserted = 0
  let skipped = 0
  const rowsByTool: Record<string, number> = {}
  const unknownProducts: Record<string, number> = {}
  const noteUnknownProduct = (product: string | null | undefined): void => {
    const key = product ?? '(null)'
    unknownProducts[key] = (unknownProducts[key] ?? 0) + 1
  }

  // Governance key + base verdict (mig 0103): resolved ONCE for this org — see
  // the identical comment in runAnalyticsPoll above.
  const governanceKey = await resolveAnthropicGovernanceKey(db, createGovernanceKeyCache(), opts.externalOrgId)
  const governanceCtx = await loadGovernanceResolutionContext(db)
  const verdict = resolveAnthropicVerdict(governanceCtx, { providerOrgId: governanceKey.providerOrgId })

  const teammateCache = new Map<string, string | null>()
  const owed = new Map<string, OwedAgg>() // unknown-email bills → placement queue

  // DB-clock start marker for the stale-row prune: rows this run touches get
  // pulled_at = their statement's NOW() (> this), rows it never re-asserts keep
  // an older pulled_at. DB time, not Date.now() — app/DB clock skew must not
  // widen or shrink the prune window.
  const [clock] = await db.execute<{ run_started: string }>(sql`SELECT now()::timestamptz AS run_started`)
  if (!clock) throw new Error('enterprise-analytics-poll: could not read DB clock for the prune marker')
  const runStarted = clock.run_started

  // One (teammate, day, surface-tool) aggregate, carrying the verbatim usage +
  // cost rows for raw_payload.
  interface EntDayAgg extends ActualSpendAgg {
    usageRows: EnterpriseUsageRow[]
    costRows: EnterpriseCostRow[]
  }

  for (const day of daysInclusive(opts.startingAt, opts.endingAt)) {
    daysPulled += 1
    // RFC-3339 single-day span: [day 00:00:00Z, next day 00:00:00Z). bucket_width=1d.
    const startingAt = `${day}T00:00:00Z`
    const next = new Date(`${day}T00:00:00.000Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    const endingAt = next.toISOString().replace(/\.\d{3}Z$/, 'Z')

    /*
     * TWO arrays, not one. `group_by[]` applies to whichever report it is sent
     * to, and `cost_type` exists only on CostRow -- UsageRow has no such field
     * (enterprise-client.ts). Sending it to the usage report would fragment
     * those rows by a dimension we cannot read back, multiplying rows against
     * the 100-page ceiling for zero benefit.
     *
     * cost_type on the COST report is what makes the web_search /
     * code_execution exclusion below reachable at all: the field is null on
     * every row until it is grouped, so the filter that reads it has never
     * once fired.
     */
    /*
     * `context_window` rides BOTH reports, per the canon clause: "Add
     * `context_window` and `speed` to both reports or neither: the usage and
     * cost reports are at different grains and a dimension on one side only
     * makes the join harder" (target-state-data-architecture.md; W0a D3).
     * `speed` is deliberately NOT taken — no card needs it. The dimension is a
     * GRAIN member on provider_usage_fact (mig 0127), so history heals exactly
     * as far as this poller's trailing window re-polls; older raw cannot heal
     * even by re-transform, because raw stores only what group_by asked.
     */
    const usageGroupBy = ['product', 'model', 'context_window']
    const costGroupBy = ['product', 'model', 'cost_type', 'context_window']
    // SERIALIZE (NOT Promise.all): 60 RPM org-wide cap shared with reconciliation-sync.
    // A concurrent usage+cost burst per day makes 429s more likely; resilientFetch
    // honors retry-after and serializing bounds the burst.
    const usage = await client.getUserUsageReport({ startingAt, endingAt, groupBy: usageGroupBy })
    const cost = await client.getUserCostReport({ startingAt, endingAt, groupBy: costGroupBy })
    peakRowsPerDayReport = Math.max(peakRowsPerDayReport, usage.data.length, cost.data.length)

    const aggs = new Map<string, EntDayAgg>()
    const getAgg = (teammateId: string, tool: string): EntDayAgg => {
      const key = `${teammateId}:${day}:${tool}`
      let agg = aggs.get(key)
      if (!agg) {
        agg = {
          teammateId,
          date: day,
          tool,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          rawPayload: null,
          usageRows: [],
          costRows: [],
        }
        aggs.set(key, agg)
      }
      return agg
    }

    // The surface lane for a report row; unmapped/null products are counted for
    // the run summary (they land in the labelled claude-other lane, never dropped).
    const rowTool = (product: string | null | undefined): string => {
      if (!isKnownProduct(product)) noteUnknownProduct(product)
      return mapProductToTool(product)
    }

    // Resolvable actor email (nullable/deleted → none, never guess a teammate).
    const actorEmail = (actor: { email?: string | null; deleted?: boolean }): string | null =>
      actor.email && !actor.deleted ? actor.email : null

    // --- usage: Σ uncached_input / output tokens per (teammate, day, surface) ---
    for (const row of usage.data) {
      total += 1
      identityEligible += 1
      const tool = rowTool(row.product)
      const email = actorEmail(row.actor)
      const teammateId = email ? await resolveTeammateId(db, teammateCache, email) : null
      if (!teammateId) {
        skipped += 1
        if (email) accumulateOwed(owed, email, day, tool, row.uncached_input_tokens, row.output_tokens, 0)
        continue
      }
      const agg = getAgg(teammateId, tool)
      agg.inputTokens += row.uncached_input_tokens
      agg.outputTokens += row.output_tokens
      agg.usageRows.push(row)
    }

    // --- cost: Σ TOKEN cost per (teammate, day, surface); EXCLUDE org-grain tool costs ---
    for (const row of cost.data) {
      // web_search / code_execution are ORG-GRAIN (emitted by the reconciliation
      // adapter at the cost-owning unit) — they NEVER fold into per-teammate
      // actual_spend. Only token cost (cost_type 'tokens' or null) belongs here.
      //
      total += 1
      if (row.cost_type === 'web_search' || row.cost_type === 'code_execution') {
        continue
      }
      /*
       * COUNTED SEPARATELY from `total`, because the two answer different
       * questions and only one of them is a safety guard.
       *
       * `total` is reported as recordsTotal: how many source rows this run
       * considered. `identityEligible` is the DENOMINATOR of the stale-prune
       * guard (skipped/eligible <= PRUNE_MAX_SKIP_RATIO), which refuses to
       * prune when an outsized share of rows failed to bind a teammate —
       * because that is OUR failure, not a provider revision, and pruning then
       * erases rows a broken run merely failed to re-assert.
       *
       * Org-grain tool rows never attempt identity resolution, so counting them
       * in the guard DILUTES it: one unbindable token row beside two tool rows
       * reads as 1/3 = 0.33, under the 0.5 threshold, when it is really 1/1 —
       * and the guard waves through a prune that deletes valid spend. Before
       * cost_type was requested these rows could not appear at all (the field
       * was null on every row), so this only became load-bearing when the
       * group_by widened.
       */
      identityEligible += 1
      const tool = rowTool(row.product)
      const usd = centsStringToUsd(row.amount) // fractional cents string -> USD
      const email = actorEmail(row.actor)
      const teammateId = email ? await resolveTeammateId(db, teammateCache, email) : null
      if (!teammateId) {
        skipped += 1
        if (email) accumulateOwed(owed, email, day, tool, 0, 0, Number.isFinite(usd) ? usd : 0)
        continue
      }
      if (!Number.isFinite(usd)) {
        consola.warn(`[enterprise-analytics-poll] non-numeric cost amount skipped for ${day}`)
        continue
      }
      const agg = getAgg(teammateId, tool)
      agg.costUsd += usd
      agg.costRows.push(row)
    }

    for (const agg of aggs.values()) {
      // raw_payload: the teammate-day-surface's usage + cost rows (the verbatim source).
      agg.rawPayload = { day, usage: agg.usageRows, cost: agg.costRows }
      if (await upsertActualSpend(db, agg, source, { key: governanceKey, verdict })) {
        upserted += 1
        rowsByTool[agg.tool] = (rowsByTool[agg.tool] ?? 0) + 1
      }
    }
  }

  // Stale-row convergence prune (see the contract comment above). Only reached
  // when EVERY day in the window pulled + wrote successfully — a thrown day
  // aborts the run before this point, so a partial pull can never delete rows
  // it did not get the chance to re-assert.
  //
  // IDENTITY-FAILURE GUARD (ratio, not boolean): if an outsized share of the
  // API rows failed to bind a teammate, the failure is likely OURS (identity
  // resolution regression), not a provider revision — pruning then would erase
  // rows the broken run merely failed to re-assert. Healthy runs always skip a
  // FEW rows (api_actors, not-yet-provisioned users → owed queue), so the guard
  // is a ratio: prune only while skipped/identityEligible ≤ PRUNE_MAX_SKIP_RATIO.
  // The denominator is IDENTITY-ELIGIBLE rows, not every row considered: org-grain
  // tool rows (web_search / code_execution) never attempt to bind a teammate, so
  // counting them would dilute the guard into waving through the very prune it
  // exists to refuse. They still count toward the reported recordsTotal. A
  // genuinely quiet window — zero API rows — DOES prune (clears revised-away
  // days). Partially-skipped spend is never lost either way: it is queued as an
  // owed bill and placement-sync replays it into actual_spend.
  //
  // CONCURRENT-RUN NOTE (deliberate, argued in the #142 review): two
  // overlapping runs for the same source (cron tick + a long --opts historical
  // re-pull) cannot lose live money through this prune. A run re-asserts every
  // key its OWN pull returned before its prune fires, and rows written by the
  // other run AFTER this run's marker survive `pulled_at < marker`. The only
  // rows a run deletes are keys absent from its own (newest-at-marker-time) API
  // snapshot — which is the convergence we want. The residual hazard is a
  // transient mix of two revision snapshots, rewritten by the next 15-min tick;
  // bounded and self-healing, so no advisory lock is taken.
  const PRUNE_MAX_SKIP_RATIO = 0.5
  let staleRowsDeleted = 0
  const skipRatio = identityEligible > 0 ? skipped / identityEligible : 0
  if (skipRatio <= PRUNE_MAX_SKIP_RATIO) {
    const lanedList = sql.join(
      CLAUDE_FAMILY_TOOLS.map((t) => sql`${t}`),
      sql.raw(', '),
    )
    const pruned = await db.execute<{ id: string }>(
      sql`
        DELETE FROM actual_spend
        WHERE source = ${source}
          AND date >= ${opts.startingAt}::date
          AND date <= ${opts.endingAt}::date
          AND tool IN (${lanedList})
          AND pulled_at < ${runStarted}::timestamptz
        RETURNING id::text AS id
      `,
    )
    staleRowsDeleted = pruned.length
  } else {
    consola.warn(
      `[enterprise-analytics-poll] skipping stale-row prune: ${skipped}/${identityEligible} identity-eligible API rows failed to bind a teammate (ratio ${skipRatio.toFixed(2)} > ${PRUNE_MAX_SKIP_RATIO}) — identity resolution looks broken`,
    )
  }

  await flushOwed(db, owed, { source, governanceKey })

  if (staleRowsDeleted > 0 || Object.keys(unknownProducts).length > 0) {
    // Money rows vanishing (prune) or a surface we don't recognise (drift) are
    // consequential — leave an audit trail beyond worker logs. Routine upserts
    // stay un-audited (they are observable via pulled_at + worker_run).
    if (Object.keys(unknownProducts).length > 0) {
      consola.warn('[enterprise-analytics-poll] unmapped product values landed in claude-other', unknownProducts)
    }
    // subject_id is a UUID column and externalOrgId is the EXTERNAL string id
    // ('org-acme') — it rides the payload instead, mirroring the
    // identity-sync-github precedent (slug in payload, uuid-or-null subject).
    await recordAuditEvent(db, {
      eventType: 'actual-spend-surface-adjusted',
      actorSystem: 'worker:analytics-poll',
      subjectKind: 'provider_org',
      subjectId: null,
      payload: {
        window: { startingAt: opts.startingAt, endingAt: opts.endingAt },
        source,
        externalOrgId: opts.externalOrgId ?? null,
        staleRowsDeleted,
        unknownProducts,
        rowsByTool,
        // On the audit payload, not just the return value, so the trend is
        // readable after the fact -- which is when the "can we afford another
        // group_by dimension" question actually gets asked.
        peakRowsPerDayReport,
      },
    })
  }

  return {
    daysPulled,
    recordsTotal: total,
    peakRowsPerDayReport,
    recordsUpserted: upserted,
    recordsSkippedUnknownUser: skipped,
    rowsByTool,
    unknownProducts,
    staleRowsDeleted,
  }
}

export interface MultiOrgPollResult {
  orgsConsidered: number
  orgsPolled: number
  orgsSkippedNoCredential: number
  perOrg: Array<{ externalOrgId: string; polled: boolean; reason?: string; result?: PollResult }>
}

/*
 * Resolve a reconciled org's Anthropic key from its credentialSecretName.
 *
 * Thin alias over the SHARED credential resolver (reconciliation/credentials.ts) —
 * the single source of truth for the `NUXT_ANTHROPIC_KEY_<UPPER_SNAKE>` convention
 * and the strict charset that stops two secret names collapsing onto one env var.
 * (Previously duplicated the prefix + regex here; consolidated.) Returns null when
 * unset/malformed so the caller skips the org — never fail the run for one org.
 */
export function resolveOrgApiKey(credentialSecretName: string | null | undefined): string | null {
  return readSecret('anthropic', credentialSecretName)
}

/*
 * Multi-org poller (slice 6): poll every RECONCILED Anthropic provider_org with
 * its own admin key, stamping each org onto actual_spend.source. Indicative
 * orgs are NOT polled (we hold no admin key and don't reconcile them — their
 * spend stays telemetry-only). With zero reconciled orgs this is a clean no-op
 * (orgsPolled: 0) — it does NOT require NUXT_ANTHROPIC_API_ENDPOINT, so the
 * scheduled job succeeds until a reconciled org is onboarded.
 */
export async function runAnalyticsPollReconciledOrgs(
  db: PostgresJsDatabase<typeof schema>,
  opts: PollOptions,
  // onlyExternalOrgId (#142): scope the poll to one reconciled org — the
  // recommended companion to a historical window override, so a long re-pull
  // doesn't walk every org against the shared 60-RPM cap. Unknown id → clean
  // no-op (orgsConsidered 0), visible in the result.
  scope: { onlyExternalOrgId?: string } = {},
): Promise<MultiOrgPollResult> {
  const orgFilter = scope.onlyExternalOrgId ? sql` AND external_org_id = ${scope.onlyExternalOrgId}` : sql``
  const orgs = await db.execute<{
    external_org_id: string
    credential_secret_name: string | null
    api_kind: string | null
  }>(
    sql`
      SELECT external_org_id, credential_secret_name, api_kind
      FROM provider_org
      WHERE provider = 'anthropic' AND reconciliation_mode = 'reconciled'${orgFilter}
      ORDER BY external_org_id
    `,
  )

  const result: MultiOrgPollResult = {
    orgsConsidered: orgs.length,
    orgsPolled: 0,
    orgsSkippedNoCredential: 0,
    perOrg: [],
  }
  if (orgs.length === 0) return result // no reconciled orgs → nothing to reconcile

  const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT
  for (const org of orgs) {
    const apiKey = resolveOrgApiKey(org.credential_secret_name)
    // Both api_kinds honor the no-key / no-endpoint skip — never fail the run for
    // one org. (No key for an enterprise org = its analytics key isn't wired yet.)
    if (!apiKey || !endpoint) {
      result.orgsSkippedNoCredential += 1
      result.perOrg.push({
        externalOrgId: org.external_org_id,
        polled: false,
        reason: !endpoint
          ? 'NUXT_ANTHROPIC_API_ENDPOINT unset'
          : 'no api key for credential_secret_name',
      })
      continue
    }
    // FAULT ISOLATION (the multi-org contract: "never fail the run for one org"):
    // a client throws on any non-200, so one org's 401/429/transient must be caught
    // + recorded, never abort the remaining orgs.
    //
    // api_kind BRANCH (mig 0063): enterprise-analytics orgs are now POLLED via the
    // Enterprise client into actual_spend (HIGH-A — bill-anchored coverage parity
    // with the Admin path), instead of being skipped. The reconciliation-sync ADAPTER
    // still independently maps them to reconciliation_record; the two are separate
    // sinks (actual_spend vs reconciliation lines), not a double-write of the same row.
    try {
      let r: PollResult
      if (org.api_kind === 'enterprise-analytics') {
        const client = new AnthropicEnterpriseClient(endpoint, apiKey)
        r = await runEnterpriseAnalyticsPoll(db, client, { ...opts, externalOrgId: org.external_org_id })
      } else {
        const client = new AnthropicAnalyticsClient(endpoint, apiKey)
        r = await runAnalyticsPoll(db, client, { ...opts, externalOrgId: org.external_org_id })
      }
      result.orgsPolled += 1
      result.perOrg.push({ externalOrgId: org.external_org_id, polled: true, result: r })
    } catch (err) {
      result.perOrg.push({
        externalOrgId: org.external_org_id,
        polled: false,
        reason: `poll failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return result
}
