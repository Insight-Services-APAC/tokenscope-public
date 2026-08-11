/*
 * Provider-recorded day detail — the response shape for GET /me/unaccounted/{id}.
 * Design: docs/design/reporting-consolidation/05-api-sourced-usage-carries-its-
 * dimensions.md, work item 2.
 *
 * WHAT THIS IS. A day of usage the provider's API reported, because the teammate
 * had no OTel emission for it. Until now it rendered as a bare dollar figure and
 * a Tag button. The dimensions were already stored — `provider_usage_fact`
 * carries model, token lanes and requests for the same (teammate, day, tool) —
 * and this contract surfaces them.
 *
 * EVERY FIGURE HERE IS OBSERVED, NEVER DERIVED. `shared/reports/model-
 * attribution.ts` draws the line this contract sits on: the provider's per-model
 * figures "ARE measured and are surfaced from the API-truth side instead, where
 * they are observed rather than derived". Nothing in this payload is a
 * proportion, an apportionment or a ratio; no money figure is produced by
 * dividing one total by another.
 *
 * TWO TOTALS, AND THEY ARE DIFFERENT QUANTITIES. `unallocated_cost_usd` is the
 * reconciled residual (`unaccounted_usage.cost_usd` = max(0, API day total − Σ
 * OTel captured)) — the amount a tag decision moves. `provider_cost_usd` is what
 * the provider's own rows sum to for that key. They are EQUAL when the teammate
 * emitted no OTel that day, which is the ordinary case for these records, and
 * differ when OTel covered part of it. Both come from ONE statement so they are
 * always the same snapshot; neither is computed from the other.
 *
 * ABSENT BY NATURE, and never faked: there is no session id, no start/end
 * timestamp and no conversation-vs-harness split on a day the provider counted —
 * those exist only at OTel granularity. Cache SAVINGS is absent for a different
 * reason, recorded on `by_token_type` below.
 */
import { z } from 'zod'

/** The four token lanes, in canonical render order. Same vocabulary as a session. */
export const PROVIDER_DAY_TOKEN_LANES = ['input', 'output', 'cache-read', 'cache-write'] as const
export type ProviderDayTokenLane = (typeof PROVIDER_DAY_TOKEN_LANES)[number]

/**
 * Why a money row carries no model. The three cases are kept APART because two
 * of them are permanent and one is transient, and a transient gap that renders
 * like a structural one makes the bucket flicker between refreshes — worse for
 * trust than a bucket that never moves.
 *
 * - `provider-reports-day-grain` — STRUCTURAL, permanent. Copilot bills
 *   `ai_credits_used` at day grain and sends no money at model grain at all;
 *   mig 0120's `provider_usage_fact_github_money_grain_chk` makes a github row
 *   carrying both a model and a cost a constraint violation. This will never
 *   resolve into models.
 * - `provider-carried-no-model` — STRUCTURAL for this record. A non-github money
 *   row the provider sent without a model.
 * - `awaiting-provider-detail` — TRANSIENT. `unaccounted_usage` recomputes every
 *   2h and `provider_usage_fact` hourly, so a key can hold a fill with no
 *   supporting fact rows for up to an hour — most likely TODAY, which is what
 *   people check most. It resolves on its own.
 */
export const PROVIDER_DAY_NULL_MODEL_REASONS = [
  'provider-reports-day-grain',
  'provider-carried-no-model',
  'awaiting-provider-detail',
] as const
export const ProviderDayNullModelReason = z.enum(PROVIDER_DAY_NULL_MODEL_REASONS)
export type ProviderDayNullModelReason = z.infer<typeof ProviderDayNullModelReason>

/**
 * One model's observed slice of the day.
 *
 * `cost_usd` and `tokens` are INDEPENDENTLY AGGREGATED and generally disagree on
 * share. `provider_usage_fact_measure_chk` (mig 0118) puts cost and tokens in
 * DISJOINT rows — a cost row carries no tokens, a token row carries no cost — so
 * a model's dollar share is not its token share. `tokens` comes from the token
 * rows' own `GROUP BY model`, never from the cost proportion; reusing the cost
 * proportion for tokens is the defect that constraint exists to make visible.
 *
 * `model` is null only on a disclosed bucket, and `null_model_reason` then says
 * which of the three cases it is.
 */
export const ProviderDayModelSpend = z.object({
  model: z.string().nullable(),
  /**
   * NULL when no cost row has been derived for this model yet — never '0.00'.
   * The token row can exist before the cost row (`provider_usage_fact`'s
   * measure check keeps them in disjoint rows), so a model can be observed with
   * its dollars still unknown. Zero here would assert a measurement we have not
   * made, and would contradict the nullable `provider_cost_usd` above it.
   */
  cost_usd: z.string().nullable(),
  /**
   * NULL when no contributing row carried a token column for this group — the
   * same unknown-stays-unknown rule as `cost_usd`, on the token lane. It is the
   * ORDINARY state for a Copilot MODEL row: the GitHub arm's model rows carry
   * `requests` alone (provider-transform-github.ts's three-row shape), with
   * every token column NULL, because Copilot never measures tokens at model
   * grain. 0 here is a measurement — the provider's rows summed to zero.
   */
  tokens: z.number().nullable(),
  /**
   * NULL when no contributing row carried `requests` — e.g. the day-grain
   * bucket, whose credits and CLI-token rows never carry the field. On a
   * Copilot MODEL row this is the row's ONE measure
   * (`totals_by_model_feature[].user_initiated_interaction_count`), present
   * regardless of the row's null cost and tokens.
   */
  requests: z.number().nullable(),
  null_model_reason: ProviderDayNullModelReason.nullable(),
})
export type ProviderDayModelSpend = z.infer<typeof ProviderDayModelSpend>

/**
 * One token lane. TOKENS ONLY, no cost — and that is a property of the source,
 * not an omission. The provider's usage report carries the four lanes with no
 * money on them; its cost report carries money grouped by `cost_type`, which is
 * not the same axis. Putting a dollar figure on a lane would mean pricing tokens
 * at a rate derived by dividing a cost total by a token total from a different
 * set of rows — a money figure from a ratio.
 *
 * Cache SAVINGS is absent for exactly that reason. A session's `savings_usd`
 * (server/usage/breakdowns.ts) reprices cache-read tokens at each model's
 * effective input rate, `inCost / inTok`, taken from ledger rows that carry both.
 * The provider lane has no row that carries both, so the same figure here would
 * be a ratio across disjoint rows. The observed cache lanes are reported; the
 * counterfactual is not.
 */
export const ProviderDayLaneSpend = z.object({
  token_type: z.string(),
  tokens: z.number(),
})
export type ProviderDayLaneSpend = z.infer<typeof ProviderDayLaneSpend>

export const ProviderDayDetail = z.object({
  /** `unaccounted_usage.id` — the taggable record. */
  id: z.string(),
  /** 'YYYY-MM-DD' (UTC). */
  day: z.string(),
  tool: z.string(),

  // ── Tagging state, so the drawer shows the same subject the worklist does ──
  project_id: z.string().nullable(),
  project_code: z.string().nullable(),
  project_display_name: z.string().nullable(),
  activity: z.string().nullable(),
  dismissed: z.boolean(),

  /** The reconciled residual this decision tags. Always present. */
  unallocated_cost_usd: z.string(),
  /** The residual's own token count, as reconciliation recorded it. */
  unallocated_tokens: z.number(),

  /**
   * Σ of the provider's own cost rows for the key. NULL — not '0.00' — when the
   * provider has contributed no cost row yet, because "$0.00" would assert the
   * provider recorded nothing, which is a different fact from "not yet derived".
   */
  provider_cost_usd: z.string().nullable(),
  /** Σ of the four observed token lanes. */
  tokens: z.number(),
  /** Σ observed requests. */
  requests: z.number(),
  /**
   * Σ `server_tool_use.web_search_requests` (mig 0122). NULL when no contributing
   * row carried the field — distinct from 0, which the provider did report.
   */
  web_search_requests: z.number().nullable(),

  /**
   * How many distinct provider sources contributed. `unaccounted_usage` keys on
   * (teammate_id, day, tool) with NO source component (mig 0071), while
   * `provider_usage_fact`'s grain LEADS with source (mig 0118) — so a teammate
   * holding licences in two provider orgs has ONE fill row standing against TWO
   * orgs' rows. The read aggregates across sources for the key deliberately, and
   * this count is how that is disclosed rather than hidden.
   */
  source_count: z.number(),

  /**
   * `observed` — at least one `provider_usage_fact` row exists for the key.
   * `awaiting-provider-detail` — none does yet (see the reason enum above).
   */
  detail_state: z.enum(['observed', 'awaiting-provider-detail']),

  by_model: z.array(ProviderDayModelSpend),
  by_token_type: z.array(ProviderDayLaneSpend),
})
export type ProviderDayDetail = z.infer<typeof ProviderDayDetail>
