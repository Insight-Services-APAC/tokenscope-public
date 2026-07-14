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

/* An unknown-email (no teammate yet) owed bill, aggregated per (email, day) so
 * multiple records sum rather than overwrite — the bill-driven-placement trigger.
 * The poller ENQUEUES these (no Graph, just a durable INSERT); the placement-sync
 * worker provisions+places the user and replays them into actual_spend (M2). */
interface OwedAgg {
  email: string
  date: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}
function accumulateOwed(m: Map<string, OwedAgg>, email: string, date: string, inT: number, outT: number, cost: number): void {
  const e = email.toLowerCase()
  const key = `${e}:${date}`
  const a = m.get(key) ?? { email: e, date, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  a.inputTokens += inT
  a.outputTokens += outT
  if (Number.isFinite(cost)) a.costUsd += cost
  m.set(key, a)
}
async function flushOwed(
  db: PostgresJsDatabase<typeof schema>,
  m: Map<string, OwedAgg>,
  args: { source: string; tool: string },
): Promise<void> {
  for (const a of m.values()) {
    await enqueueOwedBill(db, {
      provider: 'anthropic',
      actualSource: args.source,
      email: a.email,
      tool: args.tool,
      date: a.date,
      costUsd: a.costUsd,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
    })
  }
}

export interface PollResult {
  daysPulled: number
  recordsTotal: number
  recordsUpserted: number
  recordsSkippedUnknownUser: number
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

const SOURCE_PREFIX = 'anthropic-analytics-api'
export function sourceForOrg(externalOrgId?: string): string {
  return externalOrgId ? `${SOURCE_PREFIX}:${externalOrgId}` : SOURCE_PREFIX
}

/*
 * One (teammate, date) aggregate ready to upsert into actual_spend. Both the
 * Admin (claude_code) and Enterprise-analytics pollers reduce a day's records to
 * these by the conflict key (teammate_id, date) before writing — DO UPDATE would
 * otherwise let the last record CLOBBER earlier ones for the same actor-day.
 */
interface ActualSpendAgg {
  teammateId: string
  date: string // YYYY-MM-DD
  inputTokens: number
  outputTokens: number
  costUsd: number
  /* Verbatim source rows (one record → the record itself; many → the array). */
  rawPayload: unknown
}

/*
 * Idempotent actual_spend upsert shared by both pollers. The unique key is
 * (teammate_id, date, tool, source); tool is always 'claude-code'. Returns true
 * if a row was written/updated (always, given RETURNING id). costUsd is fixed to
 * 6 dp for the PG numeric; callers must pre-filter non-finite cost so a single
 * 'NaN' can't poison the column.
 */
async function upsertActualSpend(
  db: PostgresJsDatabase<typeof schema>,
  agg: ActualSpendAgg,
  source: string,
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(
    sql`
      INSERT INTO actual_spend
        (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, raw_payload)
      VALUES
        (${agg.teammateId}::uuid, ${agg.date}::date, 'claude-code',
         ${agg.inputTokens}::bigint, ${agg.outputTokens}::bigint,
         ${agg.costUsd.toFixed(6)}::numeric, ${source},
         ${JSON.stringify(agg.rawPayload)}::jsonb)
      ON CONFLICT (teammate_id, date, tool, source)
      DO UPDATE SET
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cost_usd = EXCLUDED.cost_usd,
        raw_payload = EXCLUDED.raw_payload,
        pulled_at = NOW()
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
        accumulateOwed(owed, email, recordDate(rec), sumRecordInputTokens(rec), sumRecordOutputTokens(rec), sumRecordCostUsd(rec))
        continue
      }
      const recDate = recordDate(rec)
      const key = `${tmId}:${recDate}`
      const agg = aggs.get(key) ?? {
        teammateId: tmId,
        date: recDate,
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
        console.warn(`[analytics-poll] non-numeric estimated_cost skipped for ${agg.date}`)
      }
      agg.recs.push(rec)
      aggs.set(key, agg)
    }
    for (const agg of aggs.values()) {
      agg.rawPayload = agg.recs.length === 1 ? agg.recs[0] : agg.recs
      if (await upsertActualSpend(db, agg, source)) upserted += 1
    }
  }

  await flushOwed(db, owed, { source, tool: 'claude-code' })
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
 * aggregate per (teammate, day) ACROSS ALL products:
 *   - input_tokens  = Σ uncached_input_tokens   (usage rows)
 *   - output_tokens = Σ output_tokens           (usage rows)
 *   - cost_usd      = Σ token cost (centsStringToUsd) for cost rows where
 *                     cost_type is 'tokens' or null. web_search / code_execution
 *                     are EXCLUDED — those are ORG-GRAIN tool costs surfaced by the
 *                     reconciliation adapter at the cost-owning unit, NOT per-teammate
 *                     actual_spend (§8.5). Folding them in would inflate a developer's
 *                     bill-anchored spend with costs they don't personally own.
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
  let total = 0
  let upserted = 0
  let skipped = 0

  const teammateCache = new Map<string, string | null>()
  const owed = new Map<string, OwedAgg>() // unknown-email bills → placement queue

  // One (teammate, day) aggregate, carrying the verbatim usage + cost rows for raw_payload.
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

    const groupBy = ['product', 'model']
    // SERIALIZE (NOT Promise.all): 60 RPM org-wide cap shared with reconciliation-sync.
    // A concurrent usage+cost burst per day makes 429s more likely; resilientFetch
    // honors retry-after and serializing bounds the burst.
    const usage = await client.getUserUsageReport({ startingAt, endingAt, groupBy })
    const cost = await client.getUserCostReport({ startingAt, endingAt, groupBy })

    const aggs = new Map<string, EntDayAgg>()
    const getAgg = (teammateId: string): EntDayAgg => {
      const key = `${teammateId}:${day}`
      let agg = aggs.get(key)
      if (!agg) {
        agg = {
          teammateId,
          date: day,
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

    // Resolvable actor email (nullable/deleted → none, never guess a teammate).
    const actorEmail = (actor: { email?: string | null; deleted?: boolean }): string | null =>
      actor.email && !actor.deleted ? actor.email : null

    // --- usage: Σ uncached_input / output tokens per (teammate, day), all products ---
    for (const row of usage.data) {
      total += 1
      const email = actorEmail(row.actor)
      const teammateId = email ? await resolveTeammateId(db, teammateCache, email) : null
      if (!teammateId) {
        skipped += 1
        if (email) accumulateOwed(owed, email, day, row.uncached_input_tokens, row.output_tokens, 0)
        continue
      }
      const agg = getAgg(teammateId)
      agg.inputTokens += row.uncached_input_tokens
      agg.outputTokens += row.output_tokens
      agg.usageRows.push(row)
    }

    // --- cost: Σ TOKEN cost per (teammate, day); EXCLUDE org-grain tool costs ---
    for (const row of cost.data) {
      total += 1
      // web_search / code_execution are ORG-GRAIN (emitted by the reconciliation
      // adapter at the cost-owning unit) — they NEVER fold into per-teammate
      // actual_spend. Only token cost (cost_type 'tokens' or null) belongs here.
      if (row.cost_type === 'web_search' || row.cost_type === 'code_execution') {
        continue
      }
      const usd = centsStringToUsd(row.amount) // fractional cents string -> USD
      const email = actorEmail(row.actor)
      const teammateId = email ? await resolveTeammateId(db, teammateCache, email) : null
      if (!teammateId) {
        skipped += 1
        if (email) accumulateOwed(owed, email, day, 0, 0, Number.isFinite(usd) ? usd : 0)
        continue
      }
      if (!Number.isFinite(usd)) {
        console.warn(`[enterprise-analytics-poll] non-numeric cost amount skipped for ${day}`)
        continue
      }
      const agg = getAgg(teammateId)
      agg.costUsd += usd
      agg.costRows.push(row)
    }

    for (const agg of aggs.values()) {
      // raw_payload: the teammate-day's usage + cost rows (the verbatim source).
      agg.rawPayload = { day, usage: agg.usageRows, cost: agg.costRows }
      if (await upsertActualSpend(db, agg, source)) upserted += 1
    }
  }

  await flushOwed(db, owed, { source, tool: 'claude-code' })
  return {
    daysPulled,
    recordsTotal: total,
    recordsUpserted: upserted,
    recordsSkippedUnknownUser: skipped,
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
): Promise<MultiOrgPollResult> {
  const orgs = await db.execute<{
    external_org_id: string
    credential_secret_name: string | null
    api_kind: string | null
  }>(
    sql`
      SELECT external_org_id, credential_secret_name, api_kind
      FROM provider_org
      WHERE provider = 'anthropic' AND reconciliation_mode = 'reconciled'
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
