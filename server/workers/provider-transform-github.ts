/*
 * provider-transform-github — the GitHub Copilot arm of the billed lane
 * (task #49).
 *
 * ══ WHAT THIS WRITES: CONSUMPTION FACTS, NOT BILL FACTS ═════════════════════
 *
 * State it before anything else, because the Anthropic arm writes the opposite
 * and the two share a table.
 *
 * `provider = 'github'` rows in `provider_usage_fact` are per-user CONSUMPTION,
 * gross, valued at the credit rate the provider itself quoted. They are NOT an
 * invoice figure and are not expected to equal one:
 *
 *   - `ai_credits_used` is GitHub's own words "the same AI credits consumption
 *     data used in the usage-based billing API" (2026-06-19 changelog, quoted at
 *     adapters/github-client.ts:672-676). Consumption, before any allowance.
 *   - Copilot's authoritative BILL is `copilot_pool_bill` at `(org, sku, month)`
 *     (mig 0080), POOLED per cost centre and NET of the included allowance
 *     (`discountAmount`). It has no per-user grain and never will.
 *   - Pooled rows cannot live in `actual_spend` either — `teammate_id` is NOT
 *     NULL there (mig 0001:301).
 *
 * So the Anthropic arm's invariant — `Σ provider_usage_fact.cost_usd =
 * actual_spend.cost_usd` — DOES NOT TRANSFER, and this module does not claim a
 * weaker version of it. What it claims instead is stated in full under THE
 * INVARIANTS below, and each one is proven in
 * tests/integration/provider/provider-transform-github.test.ts.
 *
 * ══ THE SOURCE ══════════════════════════════════════════════════════════════
 *
 * `reconciliation_record`, the per-(teammate, day, category) Copilot ledger —
 * NOT a raw capture (`raw_provider_batch` is mig 0117 on the unmerged branch
 * feat/provider-raw-capture and has no GitHub writer at all) and NOT
 * `actual_spend` (its only Copilot writer is copilot-bill.ts's flat-seat
 * SHOWBACK row, which is a seat price, not usage).
 *
 * Two things come from DECLARED columns and need no payload archaeology:
 *   - `actual_usd`  — the money, already valued by the adapter
 *                     (github.ts:207 App mode, :162 PAT mode).
 *   - `period_date` — the day, a typed date column.
 * The MODEL dimension comes from `raw`, which is where the adapter parks the
 * provider's whole record (github.ts:213).
 *
 * TWO CONSEQUENCES OF THAT SOURCE, stated rather than discovered later:
 *
 * 1. **A `matched` day produces no ledger row, so it produces no fact row.**
 *    The reconcile engine `continue`s without writing when |delta| <= epsilon
 *    (engine.ts:282-285), so a Copilot user-day whose OTel emission already
 *    accounts for its credits is absent from the ledger — and therefore from
 *    this lane. This is the same bounded, documented gap the Anthropic arm has
 *    against `actual_spend.raw_payload`, and it is why the conservation
 *    invariant below is stated against THE LEDGER and never against "all
 *    Copilot consumption". `copilot-bill.ts` reads the provider month total
 *    directly for exactly this reason.
 *    REMOVAL CONDITION: a GitHub raw-capture writer (feat/provider-raw-capture,
 *    mig 0117) would let this arm read the provider response instead of the
 *    delta ledger, and the gap closes with it.
 *
 * 2. **An unresolved actor CANNOT arise from this source.** The adapter
 *    `continue`s a login it cannot map to a teammate before a line is ever built
 *    (github.ts:477-478), and the engine skips a line whose teammate has no
 *    dimensions. So every row here is already bound. The carry path exists in
 *    the SCHEMA (`actor_ref` + mig 0118's NULL-safe grain key) for a future raw
 *    source; this arm cannot produce one and does not pretend to. `actor_ref`
 *    still carries the provider's own login so a row can be re-derived without a
 *    re-fetch.
 *
 * ══ WHAT THE WIRE ACTUALLY GIVES ════════════════════════════════════════════
 *
 * Every claim below is from the OBSERVED capture
 * docs/design/provider-wire-captures/2026-08-02-provider-wire-shape.json, never
 * from a Zod schema and never from a worker. Code is only ever evidence of CODE.
 *
 *   | wire path                                                  | observed      |
 *   |------------------------------------------------------------|---------------|
 *   | ndjson_records[].ai_credits_used                            | 100%, ROOT    |
 *   | ndjson_records[].totals_by_model_feature[].model            | 487/487       |
 *   | ndjson_records[].totals_by_model_feature[].user_initiated_… | with it       |
 *   | ndjson_records[].totals_by_language_model[].model           | 756/756       |
 *   | ndjson_records[].totals_by_cli.token_usage.*_tokens_sum     | 47/200 SPARSE |
 *
 * `ai_credits_used` sits at the RECORD ROOT. **The money is at DAY GRAIN and
 * there is no model on it.** The model rows carry activity counts and LOC sums,
 * never credits.
 *
 * ══ SO: TWO TRUTHS, NEVER ONE INVENTED ONE ══════════════════════════════════
 *
 * Splitting a day's credits across its models by activity share would be a
 * RATIO — a number the provider never sent, indistinguishable at read time from
 * one it did. This module writes each truth at the grain it actually has:
 *
 *   row       | model      | cost_type    | measure
 *   ----------|------------|--------------|-------------------------------------
 *   CREDITS   | NULL       | 'ai-credits' | cost_usd — the day's money
 *   MODEL     | the model  | NULL         | requests — user-initiated interactions
 *   CLI TOKENS| NULL       | NULL         | input_tokens / output_tokens
 *
 * The prohibition is not left to good intentions: mig 0120's
 * `provider_usage_fact_github_money_grain_chk` REJECTS a `provider='github'` row
 * that carries both a model and a cost. A future ratio is a constraint
 * violation, not a silent number.
 *
 * MEASURES ARE SINGLE-HOMED, which is what makes a plain SUM over the arm safe.
 * Within one (source, teammate, date, tool): cost is on the CREDITS row alone,
 * tokens on the CLI TOKENS row alone, and `requests` only ever on MODEL rows.
 * `totals_by_cli.request_count` is deliberately NOT written — it would put a
 * second meaning into `requests` and make `SUM(requests)` double count.
 *
 * ══ THE INVARIANTS THIS ARM CLAIMS ══════════════════════════════════════════
 *
 * G1 CONSERVATION WITH THE LEDGER. Per (source, teammate, date, tool),
 *    `Σ cost_usd WHERE provider='github'` equals the live ledger's `actual_usd`
 *    for that key. Neither invented nor lost, and no allowance applied.
 * G2 MONEY IS DAY GRAIN. No `provider='github'` row carries both a model and a
 *    cost. Enforced by CHECK, asserted by test.
 * G3 THE POOLED BILL IS INDEPENDENT. This module never reads
 *    `copilot_pool_bill`. G1 and G2 hold unchanged when the pooled bill and the
 *    summed per-user consumption disagree — which they normally do, because one
 *    is net of an allowance and the other is gross.
 * G4 THE ANTHROPIC ARM IS UNTOUCHED. Its own conservation with `actual_spend`
 *    holds with GitHub rows present in the same table.
 *
 * ══ THE LIVE ROW ════════════════════════════════════════════════════════════
 *
 * `reconciliation_record` keeps history: terminal rows accumulate and
 * supersession writes a NEW row (mig 0038:88-97). The single LIVE row per
 * logical key is picked with the same DISTINCT ON that `v_teammate_usage_daily`
 * uses (mig 0086:73-87) — non-terminal status, `applied` beating a lingering
 * `proposed`, newest `computed_at` as tiebreak. Copied deliberately rather than
 * re-invented: if the billed lane and the §A usage view disagreed about which
 * ledger row is live, two surfaces would report two different Copilot totals.
 */
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import { COPILOT_AGENT_TOOL, COPILOT_CLI_TOOL } from '../../shared/usage/github-surface'
import { accumulate, blankFact, nonNegInt, type DerivedFacts, type Db, type FactRow } from './provider-fact'

/**
 * `provider_usage_fact.source` prefix for the Copilot per-user consumption lane.
 *
 * NOT an `actual_spend.source` — Copilot per-user consumption has no
 * `actual_spend` row (mig 0118's column comment is corrected by mig 0120 to say
 * so). It names the ownership domain this arm's lock and prune are keyed on: one
 * GitHub ENTERPRISE, which is also the credential grain
 * (adapters/github-client.ts:5-6) and `reconciliation_record.enterprise_ref`.
 */
export const COPILOT_CONSUMPTION_SOURCE_PREFIX = 'copilot-consumption'

export function sourceForGithubEnterprise(enterpriseRef: string): string {
  return `${COPILOT_CONSUMPTION_SOURCE_PREFIX}:${enterpriseRef}`
}

/** The enterprise_ref a Copilot consumption source names, or null when the
 *  string is not one of ours. Never guessed. */
export function parseGithubConsumptionSource(source: string): string | null {
  const prefix = `${COPILOT_CONSUMPTION_SOURCE_PREFIX}:`
  if (!source.startsWith(prefix)) return null
  const rest = source.slice(prefix.length).trim()
  return rest === '' ? null : rest
}

export function isGithubConsumptionSource(source: string): boolean {
  return parseGithubConsumptionSource(source) !== null
}

/**
 * `cost_type` on the Copilot CREDITS row.
 *
 * The provider's OWN unit vocabulary — `unitType: 'ai-credits'`
 * (github-client.ts:16, `reconciliation_record.actual_unit_type`) — exactly as
 * the Anthropic arm's `'tokens'` is Anthropic's. It is the discriminator a
 * reader uses to tell consumption money from billed money in one table, so it
 * must never be widened to a generic value like 'cost'.
 */
export const COPILOT_CREDITS_COST_TYPE = 'ai-credits'

/*
 * The §A usage lane a reconciliation category belongs to — the SAME mapping
 * v_teammate_usage_daily's CASE encodes (mig 0086:76-77, 0101:181). Shared so
 * the billed lane and the §A usage view can never disagree about which tool a
 * Copilot ledger row belongs to; two copies would be two chances to drift.
 */
export function copilotToolForCategory(category: string): string {
  return category === 'copilot_coding_agent' ? COPILOT_AGENT_TOOL : COPILOT_CLI_TOOL
}

/*
 * The App-mode NDJSON record's shape, as far as this module reads it. Declared
 * loosely on purpose: `UserMetricsRecordSchema` (github-client.ts) is what
 * VALIDATES the wire; by the time a record reaches here it has been through
 * `reconciliation_record.raw`, a jsonb round trip, so it is re-narrowed rather
 * than re-parsed. Every access below tolerates a missing or wrongly-typed
 * subtree by contributing nothing — a shape surprise must cost one dimension,
 * never the day's money.
 */
interface MetricsRecordShape {
  totals_by_model_feature?: unknown
  totals_by_cli?: unknown
}

/** One envelope of `reconciliation_record.raw`. The adapter writes two shapes
 *  and the engine may wrap either in an array — see `rawEnvelopes`. */
interface RawEnvelope {
  login?: unknown
  /** App mode (github.ts:213) — the whole users-1-day NDJSON record. */
  record?: unknown
  /** PAT mode (github.ts:173) — the ai_credit/usage items. Read for nothing
   *  today; see the PAT-MODE note on `deriveModelRows`. */
  items?: unknown
}

/**
 * `reconciliation_record.raw` normalised to a list of envelopes.
 *
 * THREE SHAPES REACH THIS COLUMN and all three are real:
 *   - App mode  `{ login, periodDate, credits, record }`   (github.ts:213)
 *   - PAT mode  `{ login, licenseOrg, periodDate, category, items }` (github.ts:173)
 *   - EITHER, wrapped in an ARRAY, when the engine's conflict-key aggregation
 *     merged more than one adapter line onto one ledger key — e.g. one teammate
 *     holding two GitHub logins in the enterprise (engine.ts:166).
 * Anything else (null, a scalar) yields no envelopes, so the day still gets its
 * CREDITS row from the declared columns and simply has no model dimension.
 */
function rawEnvelopes(raw: unknown): RawEnvelope[] {
  if (Array.isArray(raw)) return raw.filter((e): e is RawEnvelope => !!e && typeof e === 'object')
  if (raw && typeof raw === 'object') return [raw as RawEnvelope]
  return []
}

/** The single login this ledger row belongs to, or null when it does not belong
 *  to exactly one. A merged multi-login row has no single provider id, and this
 *  arm never picks one arbitrarily — `actor_ref` exists so a row can be
 *  re-derived, and a wrong id would misdirect that. */
function singleLogin(envelopes: RawEnvelope[]): string | null {
  const logins = new Set<string>()
  for (const e of envelopes) {
    if (typeof e.login === 'string' && e.login.trim() !== '') logins.add(e.login.trim())
  }
  return logins.size === 1 ? [...logins][0]! : null
}

function nonBlankString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * MODEL → user-initiated interactions, from ONE App-mode record.
 *
 * `totals_by_model_feature` is the axis, NOT `totals_by_language_model`: a
 * model's share of DELIBERATE user interactions is the closest thing Copilot has
 * to "how much work ran on this model", and the language dimension answers a
 * different question (04-prototype-delta.md §5). Both carry `model` on the wire
 * (487/487 and 756/756) — this is a choice between two available dimensions, not
 * a limitation.
 *
 * PAT MODE CONTRIBUTES NO MODEL ROWS, deliberately. `UsageItem` declares
 * `model` (github-client.ts:76) but the 2026-08-02 capture could not exercise
 * that surface at all — it reports `github-ai-credit-usage` as
 * "not-configured on this environment", so there is no observed evidence of
 * whether the field is populated, and none at all of whether `grossAmount` is
 * per-model money. Reading it would be inferring a wire from a parser, which is
 * the exact move docs/design/provider-wire-captures/README.md forbids. Worse, if
 * that surface DOES carry money at model grain it needs a different row shape
 * than this one and mig 0120's CHECK would reject the naive version.
 * REMOVAL CONDITION: run the wire probe against a PAT-mode enterprise; if
 * `usageItems[].model` is populated, extend this function and revisit mig 0120's
 * CHECK in the same change. Tracked as #49's follow-up.
 */
function deriveModelRows(record: MetricsRecordShape): Map<string, number> {
  const byModel = new Map<string, number>()
  const rows = record.totals_by_model_feature
  if (!Array.isArray(rows)) return byModel
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const model = nonBlankString(row.model)
    if (!model) continue
    // One model appears under several features in one record, so this SUMS —
    // it never overwrites.
    byModel.set(model, (byModel.get(model) ?? 0) + nonNegInt(row.user_initiated_interaction_count))
  }
  return byModel
}

/**
 * CLI prompt/output token sums from ONE App-mode record, or null when the record
 * carries none.
 *
 * SPARSE BY NATURE — 47/200 stored records carry `totals_by_cli` (2/12 live).
 * Absence is the ordinary case and means "this user did not use the CLI that
 * day", never "tokens were lost". These are DAY GRAIN: `totals_by_cli` sits at
 * the record root with no model beneath it, so the tokens are written with
 * `model NULL` rather than attributed to a model that did not send them.
 */
function deriveCliTokens(record: MetricsRecordShape): { input: number; output: number } | null {
  const cli = record.totals_by_cli
  if (!cli || typeof cli !== 'object') return null
  const usage = (cli as Record<string, unknown>).token_usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const input = nonNegInt(u.prompt_tokens_sum)
  const output = nonNegInt(u.output_tokens_sum)
  if (input === 0 && output === 0) return null
  return { input, output }
}

type LedgerRow = {
  date: string
  teammate_id: string | null
  category: string
  provider_org_id: string | null
  provider_enterprise_id: string | null
  actual_usd: string | null
  raw: unknown
}

/**
 * Every Copilot enterprise with ledger rows in the window, as source strings.
 * Discovered from the DATA rather than from `provider_enterprise` so this stays
 * in step with what the reconciler actually wrote.
 */
export async function discoverGithubConsumptionSources(
  db: Db,
  opts: { startingAt: string; endingAt: string },
): Promise<string[]> {
  const rows = await db.execute<{ enterprise_ref: string }>(
    // provider='github' is THIS ARM's predicate (#49), not a temporary narrowing:
    // reconciliation_record carries both providers and only Copilot rows belong to
    // this lane. It goes when the arm goes, and not before.
    sql`SELECT DISTINCT enterprise_ref
          FROM reconciliation_record
         WHERE provider = 'github'
           AND scope = 'teammate'
           AND status NOT IN ('rejected', 'superseded')
           AND period_date >= ${opts.startingAt}::date
           AND period_date <= ${opts.endingAt}::date
         ORDER BY enterprise_ref`,
  )
  return rows.map((r) => sourceForGithubEnterprise(r.enterprise_ref))
}

/**
 * Derive every GitHub fact row for ONE enterprise's window.
 *
 * Pure of any write, so a throw anywhere in here aborts before a single row is
 * touched — which is what lets the orchestrator take its prune decision before
 * publishing anything.
 */
export async function deriveGithubFacts(
  db: Db,
  source: string,
  opts: { startingAt: string; endingAt: string },
): Promise<DerivedFacts> {
  const enterpriseRef = parseGithubConsumptionSource(source)
  if (!enterpriseRef) {
    throw new Error(
      `provider-transform: source '${source}' is not a Copilot consumption source (expected '${COPILOT_CONSUMPTION_SOURCE_PREFIX}:<enterpriseRef>').`,
    )
  }

  /*
   * THE LIVE ROW per logical key — mig 0086:73-87's DISTINCT ON, verbatim in
   * shape. `teammate_id IS NOT NULL` mirrors the view and is also structurally
   * redundant here (scope='teammate' rows always carry one); it is kept so the
   * two statements read identically and a future scope value cannot silently
   * widen this one.
   *
   * `r.provider = 'github'` is THIS ARM's predicate (#49) and is PERMANENT, not
   * scaffolding: reconciliation_record carries Anthropic rows too, and those
   * reach the fact table through the Anthropic arm's own source. Nothing here
   * disappears when another provider is added — a third provider gets a third
   * derive function with a third predicate.
   */
  const rows = await db.execute<LedgerRow>(
    // The live-row DISTINCT ON of mig 0086; provider='github' is this arm's own
    // permanent predicate (#49), not a narrowing awaiting a widening.
    sql`SELECT DISTINCT ON (r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id)
               r.period_date::text AS date,
               r.teammate_id::text AS teammate_id,
               r.category,
               r.provider_org_id::text AS provider_org_id,
               r.provider_enterprise_id::text AS provider_enterprise_id,
               r.actual_usd::text AS actual_usd,
               r.raw
          FROM reconciliation_record r
         WHERE r.provider = 'github'
           AND r.enterprise_ref = ${enterpriseRef}
           AND r.scope = 'teammate'
           AND r.teammate_id IS NOT NULL
           AND r.status NOT IN ('rejected', 'superseded')
           AND r.period_date >= ${opts.startingAt}::date
           AND r.period_date <= ${opts.endingAt}::date
         ORDER BY r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id,
                  CASE r.status WHEN 'applied' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                  r.computed_at DESC`,
  )

  const facts = new Map<string, FactRow>()
  let providerRowsConsidered = 0
  let unresolvedActorRows = 0
  let identityEligibleRows = 0

  for (const row of rows) {
    const envelopes = rawEnvelopes(row.raw)
    const base = {
      source,
      provider: 'github' as const,
      providerOrgId: row.provider_org_id,
      providerEnterpriseId: row.provider_enterprise_id,
      teammateId: row.teammate_id,
      actorRef: singleLogin(envelopes),
      date: row.date,
      tool: copilotToolForCategory(row.category),
      /*
       * The Copilot wire carries no context-window dimension anywhere (capture
       * 2026-08-02) — NULL by construction on every GitHub row, stated here
       * rather than defaulted so the absence is a decision, not an accident.
       */
      contextWindow: null,
      currency: 'USD',
    }
    providerRowsConsidered += 1
    identityEligibleRows += 1
    if (!base.teammateId) unresolvedActorRows += 1

    /*
     * ── THE CREDITS ROW — the day's money, at the grain it actually has ────
     *
     * From the DECLARED column `actual_usd`, not from the payload: the adapter
     * has already applied the provider's own rate (github.ts:207 flat
     * AIC_USD_RATE for App mode; :159-162 the authoritative
     * grossAmount/grossQuantity rate for PAT mode), and re-deriving it here
     * would be a second opinion that can disagree with the ledger this arm
     * conserves against.
     *
     * A non-numeric amount is SKIPPED and warned, never coerced to 0 — the same
     * rule as the Anthropic arm's unparseable `amount`. A missing figure is a
     * signal; filling it destroys the signal. (`actual_usd` is NOT NULL in mig
     * 0038, so this is a backstop against a jsonb/numeric surprise, not a live
     * branch — and a defensive branch is not evidence that a case occurs.)
     */
    const usd = row.actual_usd === null ? Number.NaN : Number(row.actual_usd)
    if (!Number.isFinite(usd)) {
      consola.warn(
        `[provider-transform:github] non-numeric actual_usd skipped for ${row.date} (source ${source}) — no credits fact row written`,
      )
    } else {
      accumulate(
        facts,
        blankFact({ ...base, model: null, costType: COPILOT_CREDITS_COST_TYPE }),
        (into) => {
          into.costUsd = (into.costUsd ?? 0) + usd
        },
      )
    }

    for (const envelope of envelopes) {
      const record = envelope.record
      if (!record || typeof record !== 'object') continue
      const shape = record as MetricsRecordShape

      // ── MODEL ROWS — the dimension, carrying ACTIVITY and never money ────
      for (const [model, interactions] of deriveModelRows(shape)) {
        accumulate(facts, blankFact({ ...base, model, costType: null }), (into) => {
          into.requests = (into.requests ?? 0) + interactions
        })
      }

      // ── CLI TOKEN ROW — day grain, model NULL (the wire has no model here) ─
      const tokens = deriveCliTokens(shape)
      if (tokens) {
        accumulate(facts, blankFact({ ...base, model: null, costType: null }), (into) => {
          into.inputTokens = (into.inputTokens ?? 0) + tokens.input
          into.outputTokens = (into.outputTokens ?? 0) + tokens.output
        })
      }
    }
  }

  return {
    facts,
    sourceRowsRead: rows.length,
    providerRowsConsidered,
    unresolvedActorRows,
    identityEligibleRows,
  }
}
