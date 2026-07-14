/*
 * Anthropic adapter (Stream A). Emits provider-neutral ReconciledLine[].
 *
 * Two APIs co-exist, selected per-org by provider_org.api_kind (mig 0063) and
 * threaded onto AdapterScope.apiKind by reconciliation-sync:
 *   - 'claude-code-admin'    → the Claude Code Analytics API (Admin):
 *       claude_code (per-user model_tokens) + cost_report (org-grain web_search /
 *       code_execution). The legacy path. See §4.1, §5.1, §8.5.
 *   - 'enterprise-analytics' → the Claude Enterprise Analytics API:
 *       user_usage_report + user_cost_report, joined per (actor, product, day) into
 *       per-teammate-day model_tokens lines (per-product split preserved in `raw`).
 *   - null / unset → defaults to the claude-code-admin path (pre-0063 behaviour).
 *
 * Identity: both Anthropic endpoints only return the org's own seats, so a matched
 * actor email is reconcilable (estimated); an unmatched/deleted email is carried
 * forward (skip), NOT guessed — exact match, NOT provisional. The indicative
 * personal-Max lane lives on the OTel side (cost_basis='telemetry-only'), not here.
 *
 * Both endpoints are single-day-per-request here (we iterate per UTC day) so the
 * bucket day is unambiguous — the documented per-row shapes carry no date field.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../../drizzle/schema'
import {
  AnthropicAnalyticsClient,
  daysInclusive,
  recordEmail,
  recordDate,
  sumRecordTokens,
  sumRecordCostUsd,
} from '../../anthropic/client'
import {
  AnthropicEnterpriseClient,
  centsStringToUsd,
  type EnterpriseUsageRow,
  type EnterpriseCostRow,
} from '../../anthropic/enterprise-client'
import type { Adapter, ReconciledLine } from '../types'
import type { AdapterScope } from './registry'
import { reconciledTeammateLine } from './teammate-line'

type Db = PostgresJsDatabase<typeof schema>

/** Map a cost_report description to a category, or null to skip (token cost etc.). */
function costCategory(description: string | null | undefined): 'web_search' | 'code_execution' | null {
  const d = (description ?? '').toLowerCase()
  if (d.includes('code execution')) return 'code_execution'
  if (d.includes('web search')) return 'web_search'
  return null
}

export function createAnthropicAdapter(db: Db, scope: AdapterScope): Adapter {
  const teammateCache = new Map<string, string | null>()

  async function resolveTeammate(email: string): Promise<string | null> {
    const key = email.toLowerCase()
    if (teammateCache.has(key)) return teammateCache.get(key)!
    // CASE-INSENSITIVE (lower(email)=lower($1)), in lockstep with analytics-poller.ts
    // so reconciliation and the actuals poller resolve the SAME teammate. Bill-driven
    // placement stores createBillTeammate emails lowercased while provider bills carry
    // mixed-case actor emails, so an exact match would let the poller bind a teammate
    // that reconciliation misses → a phantom variance. Backed by the case-insensitive
    // partial unique index (mig 0067) so the real row stays unique under lower(email).
    //
    // MONEY-PATH GUARD (PR #87 FIX 1): teammate.email is a PARTIAL unique index
    // (WHERE NOT provisional), so a real teammate and provisional shadow(s) can share
    // an email. The provider bill MUST bind the REAL teammate — filter `NOT provisional`
    // server-side. ORDER BY id is a deterministic tiebreak.
    const [row] = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM teammate
       WHERE lower(email) = lower(${email}) AND NOT provisional
       ORDER BY id LIMIT 1
    `)
    const id = row?.id ?? null
    teammateCache.set(key, id)
    return id
  }

  /*
   * claude-code-admin path (legacy): claude_code per-user model_tokens +
   * cost_report org-grain web_search / code_execution.
   */
  async function pullClaudeCodeAdmin(opts: { startDate: string; endDate: string }): Promise<ReconciledLine[]> {
    const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT
    if (!endpoint) return [] // not configured -> clean no-op (matches the poller)
    const client = new AnthropicAnalyticsClient(endpoint, scope.credential.value)
    const lines: ReconciledLine[] = []

    // --- claude_code: per-user model-token spend (the core reconcilable lane) ---
    // Real shape (mig-0063 'claude-code-admin'): data[] is a FLAT array of per-user
    // records; tokens + cost are nested under model_breakdown[] (estimated_cost.amount
    // in CENTS). recordEmail/recordDate/sumRecordTokens/sumRecordCostUsd encapsulate that.
    for (const day of daysInclusive(opts.startDate, opts.endDate)) {
      const report = await client.getClaudeCodeUsage({ startingAt: day })
      for (const rec of report.data) {
        const email = recordEmail(rec)
        if (!email) continue // api_actor / no email -> carry forward, not guessed
        const teammateId = await resolveTeammate(email)
        if (!teammateId) continue // carry forward — teammate not onboarded yet
        const tokens = sumRecordTokens(rec)
        const usd = sumRecordCostUsd(rec) // cents -> USD, summed across model_breakdown[]
        // Anthropic reconciles in USD (estimated_cost); the rate is informational for
        // tokens (the engine sums cost_usd, not quantity*rate). The shared builder derives
        // it as usd/tokens (and '0' when tokens is 0), preserving the prior behaviour.
        lines.push(
          reconciledTeammateLine({
            provider: 'anthropic',
            enterpriseRef: scope.externalRef,
            periodDate: recordDate(rec),
            teammateId,
            category: 'model_tokens',
            quantity: tokens,
            unitType: 'tokens',
            amountUsd: usd,
            spendClass: 'estimated',
            raw: rec,
          }),
        )
      }
    }

    // --- cost_report: org-grain web_search / code_execution (best-effort) ---
    // [VERIFY] the cost_report result shape + whether `amount` is dollars or cents
    // (assumed cents per the docs) once an admin key is available. Until then this
    // is graceful: the synthetic stub has no cost_report endpoint -> 404 -> skipped.
    try {
      const cost = await client.getCostReport({ startingAt: opts.startDate, endingAt: opts.endDate })
      for (const bucket of cost.data) {
        const periodDate = bucket.starting_at.slice(0, 10)
        for (const r of bucket.results) {
          const category = costCategory(r.description)
          if (!category) continue
          const usd = Number(r.amount) / 100 // [VERIFY] cents -> USD
          if (!Number.isFinite(usd) || usd <= 0) continue
          lines.push({
            provider: 'anthropic',
            enterpriseRef: scope.externalRef,
            licenseOrg: null,
            periodDate,
            subject: { kind: 'org', costOwningUnitId: null },
            category,
            unit: { quantity: 0, unitType: 'tokens' },
            rateUsdPerUnit: '0',
            amountUsd: usd.toFixed(6),
            spendClass: 'estimated',
            raw: r,
          })
        }
      }
    } catch (err) {
      // cost_report unavailable / shape unverified — skip the org lines this run,
      // but surface it: a 401/500 must not look like the expected "no endpoint" 404.
      console.warn(`[anthropic-adapter] cost_report skipped for ${scope.externalRef}: ${String(err)}`)
    }

    return lines
  }

  /*
   * enterprise-analytics path: user_usage_report (tokens) + user_cost_report (USD),
   * group_by[]=product&group_by[]=model, ALL products. Pulled PER UTC DAY so the
   * bucket day is unambiguous (the documented per-row shape carries no date).
   *
   * MATCHING (doc-ambiguity, see report): usage rows carry (actor, product, model);
   * cost rows carry (actor, product, cost_type, token_type) — NO model. So usage and
   * cost are matched/aggregated on (actor.email, product) within the day. Per the
   * contract we then emit ONE model_tokens ReconciledLine per (teammate, day):
   *   - unit.quantity = Σ total_tokens across all the teammate's products that day
   *   - amountUsd     = Σ (cost.amount ÷ 100) across all the teammate's products
   *   - periodDate    = the bucket day (UTC)
   * The engine sums by conflict key (provider, ref, day, category, teammate), so even
   * if we emitted per-product the rows would collapse to per-teammate-day; we keep the
   * per-product breakdown in `raw` for a future read-model.
   */
  async function pullEnterpriseAnalytics(opts: { startDate: string; endDate: string }): Promise<ReconciledLine[]> {
    const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT
    if (!endpoint) return [] // not configured -> clean no-op
    const client = new AnthropicEnterpriseClient(endpoint, scope.credential.value)
    const lines: ReconciledLine[] = []

    for (const day of daysInclusive(opts.startDate, opts.endDate)) {
      // RFC-3339 single-day span: [day 00:00:00Z, next day 00:00:00Z). bucket_width=1d.
      const startingAt = `${day}T00:00:00Z`
      const next = new Date(`${day}T00:00:00.000Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      const endingAt = next.toISOString().replace(/\.\d{3}Z$/, 'Z')

      const groupBy = ['product', 'model']
      // Serialize (NOT Promise.all): the Enterprise API caps at 60 RPM org-wide, shared
      // with reconciliation-sync. A concurrent usage+cost burst per day makes 429s more
      // likely; resilientFetch honors retry-after, and serializing bounds the burst.
      const usage = await client.getUserUsageReport({ startingAt, endingAt, groupBy })
      const cost = await client.getUserCostReport({ startingAt, endingAt, groupBy })

      // Per-(actor email, product) aggregation within the day.
      interface ProductAgg {
        email: string
        product: string
        tokens: number
        usd: number
        usageRows: EnterpriseUsageRow[]
        costRows: EnterpriseCostRow[]
      }
      // teammateId -> { day rollup + per-product breakdown }.
      interface TeammateAgg {
        teammateId: string
        tokens: number
        usd: number
        products: Map<string, ProductAgg>
      }
      const byTeammate = new Map<string, TeammateAgg>()
      // Tool costs (web_search / code_execution) are ORG-GRAIN per §8.5 (types.ts:53-55):
      // surfaced at the cost-owning unit, NOT pro-rata'd onto developers — matching the
      // admin path's subject:{kind:'org'}. Aggregated per category across ALL actors.
      interface ToolCostAgg {
        category: 'web_search' | 'code_execution'
        usd: number
        rows: EnterpriseCostRow[]
      }
      const toolCostByCategory = new Map<'web_search' | 'code_execution', ToolCostAgg>()

      const ensureProduct = (agg: TeammateAgg, email: string, product: string): ProductAgg => {
        let p = agg.products.get(product)
        if (!p) {
          p = { email, product, tokens: 0, usd: 0, usageRows: [], costRows: [] }
          agg.products.set(product, p)
        }
        return p
      }

      const resolveActor = async (
        actor: { email?: string | null; deleted?: boolean },
      ): Promise<string | null> => {
        // Nullable / deleted actor email -> carry forward (skip), never guess.
        if (!actor.email || actor.deleted) return null
        return resolveTeammate(actor.email)
      }

      // --- usage: tokens per (teammate, product) ---
      for (const row of usage.data) {
        const teammateId = await resolveActor(row.actor)
        if (!teammateId) continue
        const email = row.actor.email!
        const agg = byTeammate.get(teammateId) ?? {
          teammateId,
          tokens: 0,
          usd: 0,
          products: new Map<string, ProductAgg>(),
        }
        const product = row.product ?? 'unknown'
        const p = ensureProduct(agg, email, product)
        p.tokens += row.total_tokens
        p.usageRows.push(row)
        agg.tokens += row.total_tokens
        byTeammate.set(teammateId, agg)
      }

      // --- cost: token cost per (teammate, product); tool cost org-grain per category ---
      for (const row of cost.data) {
        const usd = centsStringToUsd(row.amount) // fractional cents string -> USD
        if (!Number.isFinite(usd)) {
          console.warn(`[anthropic-adapter] enterprise non-numeric cost amount skipped for ${day}`)
          continue
        }
        // Tool costs (web_search / code_execution) are ORG-GRAIN — aggregate per category
        // across all actors, no teammate resolution (§8.5). Token cost (cost_type
        // 'tokens'/null) folds into the teammate's model_tokens.
        const toolCat =
          row.cost_type === 'web_search' ? 'web_search'
          : row.cost_type === 'code_execution' ? 'code_execution'
          : null
        if (toolCat) {
          const t = toolCostByCategory.get(toolCat) ?? { category: toolCat, usd: 0, rows: [] }
          t.usd += usd
          t.rows.push(row)
          toolCostByCategory.set(toolCat, t)
          continue
        }
        const teammateId = await resolveActor(row.actor)
        if (!teammateId) continue
        const email = row.actor.email!
        const agg = byTeammate.get(teammateId) ?? {
          teammateId,
          tokens: 0,
          usd: 0,
          products: new Map<string, ProductAgg>(),
        }
        const product = row.product ?? 'unknown'
        const p = ensureProduct(agg, email, product)
        p.usd += usd
        p.costRows.push(row)
        agg.usd += usd
        byTeammate.set(teammateId, agg)
      }

      // --- emit one model_tokens line per (teammate, day); per-product split in raw ---
      for (const agg of byTeammate.values()) {
        const perProduct = [...agg.products.values()].map((p) => ({
          product: p.product,
          tokens: p.tokens,
          usd: Number(p.usd.toFixed(6)),
          usage: p.usageRows,
          cost: p.costRows,
        }))
        lines.push(
          reconciledTeammateLine({
            provider: 'anthropic',
            enterpriseRef: scope.externalRef,
            periodDate: day,
            teammateId: agg.teammateId,
            category: 'model_tokens',
            quantity: agg.tokens,
            unitType: 'tokens',
            amountUsd: agg.usd,
            spendClass: 'estimated',
            // PER-PRODUCT breakdown preserved for a future read-model. The engine sums
            // by conflict key so this raw is the only place the split survives.
            raw: { email: [...agg.products.values()][0]?.email ?? null, day, perProduct },
          }),
        )
      }

      // --- ORG-GRAIN tool-cost lines (web_search / code_execution), kept OUT of
      // model_tokens and NOT pro-rata'd onto developers — matches the admin path + §8.5. ---
      for (const t of toolCostByCategory.values()) {
        lines.push({
          provider: 'anthropic',
          enterpriseRef: scope.externalRef,
          licenseOrg: null,
          periodDate: day,
          subject: { kind: 'org', costOwningUnitId: null },
          category: t.category,
          unit: { quantity: 0, unitType: 'tokens' },
          rateUsdPerUnit: '0',
          amountUsd: t.usd.toFixed(6),
          spendClass: 'estimated',
          raw: { day, category: t.category, cost: t.rows },
        })
      }
    }

    return lines
  }

  return {
    provider: 'anthropic',
    enterpriseRef: scope.externalRef,
    async pull(opts): Promise<ReconciledLine[]> {
      // BRANCH on the org's api_kind (mig 0063). Default (null/unset) is the legacy
      // claude-code-admin path so pre-0063 / unthreaded callers are unchanged.
      if (scope.apiKind === 'enterprise-analytics') {
        return pullEnterpriseAnalytics(opts)
      }
      return pullClaudeCodeAdmin(opts)
    },
  }
}
