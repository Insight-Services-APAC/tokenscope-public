/*
 * Provider-recorded day detail — the read behind GET /me/unaccounted/{id}.
 * Design: docs/design/reporting-consolidation/05-api-sourced-usage-carries-its-
 * dimensions.md work item 2. Response contract: shared/schemas/provider-day.ts.
 *
 * ── ONE STATEMENT, NEVER TWO ────────────────────────────────────────────────
 *
 * The fill total and its breakdown come from a SINGLE statement, and that is a
 * correctness requirement rather than a performance one. `unaccounted_usage` is
 * recomputed every 2h (registry.ts) and `provider_usage_fact` hourly, each in its
 * own transaction, and server/db runs READ COMMITTED with no generation stamp.
 * Two independently-issued queries can straddle a commit, so a user who clicks a
 * total and then sees a breakdown would be shown rows that do not belong to the
 * number they clicked — the precise failure this work exists to prevent. One CTE
 * pins one snapshot for every figure the drawer renders.
 *
 * ── OBSERVED, NEVER DERIVED ─────────────────────────────────────────────────
 *
 * Every figure is read from the provider's own rows. There is NO proportion, NO
 * apportionment and NO ratio anywhere in this file — in particular the residual
 * is never split across models, which is the separate, contested question
 * `shared/reports/model-attribution.ts:16-31` is about. This read does not touch
 * it: it reports what the provider sent for the key, alongside the residual, and
 * never computes one from the other.
 *
 * Consequently there is no division to guard. The design's `NULLIF` guard exists
 * for `fill × model_cost / Σ model_cost`; that expression appears nowhere here,
 * so the zero-supporting-row case is handled STRUCTURALLY (a disclosed bucket
 * carrying the whole residual) rather than arithmetically. A decorative NULLIF
 * around a division this file does not perform would be enforcement-shaped code
 * that enforces nothing.
 *
 * ── WHY THE GROUP BY IS SAFE OVER MIXED ROWS ────────────────────────────────
 *
 * `provider_usage_fact_measure_chk` (mig 0118) makes cost rows and token rows
 * DISJOINT: a cost row's token columns are NULL, a token row's `cost_usd` is
 * NULL. So one `GROUP BY model` yields both aggregates without a filter and
 * without double counting — `SUM(cost_usd)` ignores token rows, the token sums
 * ignore cost rows. This is the property 0118:140-157 documents, and it is also
 * why a model's dollar share and its token share are computed independently and
 * are allowed to disagree.
 *
 * ── THE JOIN SPANS `source`, DELIBERATELY ───────────────────────────────────
 *
 * `unaccounted_usage` keys on (teammate_id, day, tool) with NO source component
 * (mig 0071); `provider_usage_fact`'s grain LEADS with `source` (mig 0118). A
 * teammate holding licences in two provider orgs therefore has ONE fill row
 * standing against TWO orgs' fact rows. The join omits `source` on purpose and
 * `source_count` discloses when more than one contributed. Mig 0121 ships the
 * index this predicate needs, since the grain uidx cannot serve it.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  PROVIDER_DAY_TOKEN_LANES,
  type ProviderDayDetail,
  type ProviderDayLaneSpend,
  type ProviderDayModelSpend,
} from '#shared/schemas/provider-day'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** One `by_model` group as the statement's `json_agg` emits it. */
interface ModelGroup {
  model: string | null
  cost_usd: string | null
  /** NULL when no row in the group carried a token column (see the CTE). */
  tokens: string | null
  /** NULL when no row in the group carried `requests` (see the CTE). */
  requests: string | null
  /** TRUE when any money in this group came from a github row (mig 0120: those
   *  are day-grain by construction and never resolve into models). */
  github_money: boolean
}

interface DetailRow extends Record<string, unknown> {
  id: string
  day: string
  tool: string
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  activity: string | null
  dismissed: boolean
  unallocated_cost_usd: string
  unallocated_tokens: string
  provider_cost_usd: string | null
  tokens: string
  requests: string
  web_search_requests: string | null
  fact_rows: string
  source_count: string
  input_tokens: string
  output_tokens: string
  cache_read_tokens: string
  cache_creation_tokens: string
  by_model: ModelGroup[] | null
}

/** Money as a fixed 2dp string, matching the /me API convention. */
const usd = (v: string | number): string => Number(v).toFixed(2)

/**
 * Read one provider-recorded day's detail for ONE teammate.
 *
 * Ownership is the WHERE clause, not a post-filter: a record belonging to
 * someone else simply produces no row, and the caller 404s — indistinguishable
 * from one that does not exist, so there is no cross-teammate probing.
 *
 * Returns null when the caller does not own the record (or it is gone).
 */
export async function fetchProviderDayDetail(
  tx: Tx,
  teammateId: string,
  recordId: string,
): Promise<ProviderDayDetail | null> {
  const rows = await tx.execute<DetailRow>(sql`
    WITH fill AS (
      SELECT u.id, u.teammate_id, u.day, u.tool, u.cost_usd, u.tokens,
             u.project_id, u.activity, u.dismissed_at,
             p.code AS project_code, p.display_name AS project_display_name
        FROM unaccounted_usage u
        LEFT JOIN project p ON p.id = u.project_id
       WHERE u.id = ${recordId}::uuid
         AND u.teammate_id = ${teammateId}::uuid
    ),
    -- Every provider row for the fill's key, ACROSS EVERY SOURCE (see header).
    facts AS (
      SELECT f.source, f.provider, f.model, f.cost_usd,
             f.input_tokens, f.output_tokens, f.cache_read_tokens,
             f.cache_creation_tokens, f.requests, f.web_search_requests
        FROM provider_usage_fact f
        JOIN fill ON f.teammate_id = fill.teammate_id
                 AND f.date       = fill.day
                 AND f.tool       = fill.tool
    ),
    -- One pass per model. Cost and token measures live in disjoint rows, so both
    -- aggregates are correct without a filter and neither derives the other.
    --
    -- EVERY MEASURE HERE IS NULL-PRESERVING, like web_search_requests below:
    -- SUM skips NULLs and yields NULL when NO contributing row carried the
    -- measure, which is "this group was never measured for it" as distinct from
    -- "the provider reported zero". That distinction is load-bearing for the
    -- Copilot three-row shape (provider-transform-github.ts): a MODEL row
    -- carries ONLY requests, so its token and cost cells are unknown — a
    -- COALESCE here fabricated a 0-token, 0-request measurement onto rows the
    -- provider never made it for, and the drawer rendered the fabrication.
    by_model AS (
      SELECT
        model,
        SUM(cost_usd)                                       AS cost_usd,
        -- NULL only when a ROW carries no token column at all (num_nonnulls=0);
        -- a row carrying any lane still sums its absent lanes as 0, because the
        -- provider's token measurement for that row exists.
        SUM(CASE WHEN num_nonnulls(input_tokens, output_tokens,
                                   cache_read_tokens, cache_creation_tokens) = 0
                 THEN NULL
                 ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                    + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)
            END)::bigint                                    AS tokens,
        SUM(requests)::bigint                               AS requests,
        COALESCE(bool_or(provider = 'github' AND cost_usd IS NOT NULL), FALSE)
                                                            AS github_money
        FROM facts
       GROUP BY model
    ),
    -- Aggregates with no GROUP BY always return exactly one row, so this stays a
    -- single row even when facts is empty — the CROSS JOIN below cannot drop
    -- the fill. (No backticks in this literal: one inside a SQL comment closes
    -- the template and the parse error points at the wrong line entirely.)
    totals AS (
      SELECT
        SUM(cost_usd)                                       AS provider_cost_usd,
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                   + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)), 0)::bigint
                                                            AS tokens,
        COALESCE(SUM(COALESCE(requests, 0)), 0)::bigint     AS requests,
        -- NULL-PRESERVING on purpose: SUM skips NULLs and yields NULL when every
        -- contributing row was NULL, which is exactly "no row carried the field"
        -- as distinct from "the provider reported zero".
        SUM(web_search_requests)::bigint                    AS web_search_requests,
        COUNT(*)::bigint                                    AS fact_rows,
        COUNT(DISTINCT source)::bigint                      AS source_count,
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint AS input_tokens,
        COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::bigint AS output_tokens,
        COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0)::bigint AS cache_creation_tokens
        FROM facts
    )
    SELECT
      fill.id::text                                         AS id,
      fill.day::text                                        AS day,
      fill.tool                                             AS tool,
      fill.project_id::text                                 AS project_id,
      fill.project_code                                     AS project_code,
      fill.project_display_name                             AS project_display_name,
      fill.activity                                         AS activity,
      (fill.dismissed_at IS NOT NULL)                       AS dismissed,
      fill.cost_usd::text                                   AS unallocated_cost_usd,
      fill.tokens::text                                     AS unallocated_tokens,
      t.provider_cost_usd::text                             AS provider_cost_usd,
      t.tokens::text                                        AS tokens,
      t.requests::text                                      AS requests,
      t.web_search_requests::text                           AS web_search_requests,
      t.fact_rows::text                                     AS fact_rows,
      t.source_count::text                                  AS source_count,
      t.input_tokens::text                                  AS input_tokens,
      t.output_tokens::text                                 AS output_tokens,
      t.cache_read_tokens::text                             AS cache_read_tokens,
      t.cache_creation_tokens::text                         AS cache_creation_tokens,
      (
        SELECT COALESCE(
          json_agg(json_build_object(
            'model',        m.model,
            'cost_usd',     m.cost_usd::text,
            'tokens',       m.tokens::text,
            'requests',     m.requests::text,
            'github_money', m.github_money
          ) ORDER BY m.cost_usd DESC NULLS LAST, m.tokens DESC, m.model NULLS LAST),
          '[]'::json)
          FROM by_model m
      )                                                     AS by_model
      FROM fill
      CROSS JOIN totals t
  `)

  const row = [...rows][0]
  if (!row) return null

  const factRows = Number(row.fact_rows)
  const unallocated = usd(row.unallocated_cost_usd)

  /*
   * THE ZERO-FACT-ROW CASE, SPECIFIED RATHER THAN DISCOVERED.
   *
   * A key can hold a fill with no supporting `provider_usage_fact` rows for up
   * to an hour, because the two writers run on different cadences — and the day
   * most likely to be in that window is TODAY, which is what people check most.
   *
   * The whole residual renders in ONE disclosed bucket carrying a reason that
   * says it is transient. It is never NULL, never $0 and never silently dropped,
   * and it is distinguishable in the response from Copilot's structural
   * day-grain bucket, so a gap that will resolve on its own cannot be mistaken
   * for one that never will.
   */
  if (factRows === 0) {
    return {
      ...header(row),
      provider_cost_usd: null,
      tokens: 0,
      requests: 0,
      web_search_requests: null,
      source_count: 0,
      detail_state: 'awaiting-provider-detail',
      by_model: [
        {
          model: null,
          cost_usd: unallocated,
          // The residual's own figures, which reconciliation DID record — as
          // distinct from `requests`, which nothing has measured for this key
          // yet and which therefore stays null rather than claiming a zero.
          tokens: Number(row.unallocated_tokens),
          requests: null,
          null_model_reason: 'awaiting-provider-detail',
        },
      ],
      by_token_type: [],
    }
  }

  const byModel: ProviderDayModelSpend[] = (row.by_model ?? []).map((g) => ({
    model: g.model,
    /*
     * NULL when no cost row has been derived for this model yet — NOT '0.00'.
     *
     * `provider_cost_usd` is already nullable for exactly this state, and
     * coercing the per-model figure to zero beside it turned "not yet derived"
     * into "the provider recorded nothing", which is a measurement we have not
     * made. It also rendered a $0.00 model mix while the total above it was
     * correctly blank — two answers to one question, on one card.
     *
     * The token row can exist before the cost row (measure_chk keeps them in
     * disjoint rows), so this is a real, reachable state, not a defensive NULL.
     */
    cost_usd: g.cost_usd == null ? null : usd(g.cost_usd),
    /*
     * The same rule on the other two measures: NULL survives, because
     * Number(null) is 0 and a 0 in this payload is a MEASUREMENT — the exact
     * coercion that made a Copilot model row's never-measured cells render as
     * fabricated zeros (Dev, 2026-08-04).
     */
    tokens: g.tokens == null ? null : Number(g.tokens),
    requests: g.requests == null ? null : Number(g.requests),
    null_model_reason:
      g.model !== null
        ? null
        : g.github_money
          ? 'provider-reports-day-grain'
          : 'provider-carried-no-model',
  }))

  /*
   * The four lanes, in canonical order, from the token rows' own columns. A lane
   * with nothing in it is omitted rather than rendered as a zero — the same rule
   * the session panel's lane list follows.
   */
  const laneTokens: Record<(typeof PROVIDER_DAY_TOKEN_LANES)[number], number> = {
    input: Number(row.input_tokens),
    output: Number(row.output_tokens),
    'cache-read': Number(row.cache_read_tokens),
    'cache-write': Number(row.cache_creation_tokens),
  }
  const byTokenType: ProviderDayLaneSpend[] = PROVIDER_DAY_TOKEN_LANES.filter(
    (lane) => laneTokens[lane] > 0,
  ).map((lane) => ({ token_type: lane, tokens: laneTokens[lane] }))

  return {
    ...header(row),
    provider_cost_usd: row.provider_cost_usd === null ? null : usd(row.provider_cost_usd),
    tokens: Number(row.tokens),
    requests: Number(row.requests),
    web_search_requests: row.web_search_requests === null ? null : Number(row.web_search_requests),
    source_count: Number(row.source_count),
    detail_state: 'observed',
    by_model: byModel,
    by_token_type: byTokenType,
  }
}

/** The fields that describe the taggable record itself, identical in both states. */
function header(row: DetailRow) {
  return {
    id: row.id,
    day: row.day,
    tool: row.tool,
    project_id: row.project_id,
    project_code: row.project_code,
    project_display_name: row.project_display_name,
    activity: row.activity,
    dismissed: row.dismissed,
    unallocated_cost_usd: usd(row.unallocated_cost_usd),
    unallocated_tokens: Number(row.unallocated_tokens),
  }
}
