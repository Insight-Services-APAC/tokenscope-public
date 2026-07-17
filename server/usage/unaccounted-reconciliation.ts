/*
 * Unaccounted-usage reconciliation — docs/design/provider-billing-attribution-model.md §A.
 *
 * The provider usage API is the COMPLETE truth of a person's spend (every container,
 * enrolled or not). OTel only captures enrolled containers, so it UNDERCOUNTS. For each
 * (teammate, day, tool) this computes:
 *
 *     unaccounted = max(0, API daily total − Σ OTel captured that day)
 *
 * and upserts ONE `unaccounted_usage` row per (teammate, day, tool) — the taggable
 * "needs tagging" record. The API has no session ids, so the day is the finest grain.
 *
 * Idempotent + tag-preserving: a recompute (e.g. late OTel arriving for a day) only
 * UPDATES `cost_usd` (and the denormalised dims); it never touches `project_id` /
 * `activity` / `tagged_*`, so a record the developer already tagged keeps its tag while
 * its amount shrinks. By construction OTel-captured + unaccounted = the API total, so
 * tagging the record can never double-count.
 *
 * `GREATEST(0, …)`: if OTel OVER-estimated a day (estimate > the API usage), the delta
 * floors at 0 — §A only guarantees we never UNDER-count; an over-estimate is the
 * over-emission detector's concern, not this one's.
 *
 * Source of the API total: the `v_teammate_usage_daily` view (mig 0073) — the per-(teammate,
 * day, tool) provider USAGE truth. It encapsulates where each tool's usage lives: claude-code
 * from actual_spend (pure-metered, bill ≈ usage); copilot-cli GROSS from reconciliation_record
 * (GitHub ai_credit/usage, per-(user, day)). Tool-agnostic — adding a tool means extending the
 * view, not this query.
 *
 * EXCEPT the DISPLAY-ONLY usage lanes (GITHUB_INGEST_ONLY_USAGE_TOOLS): 'copilot-agent'
 * (mig 0086, design D4) is the OTel-INVISIBLE coding-agent lane — no session ever emits it,
 * so "API − OTel" would equal the FULL amount every day and every coding-agent dollar would
 * become a permanent, untaggable worklist item. It is usage display only (the view + its
 * §A display readers), never a needs-tagging record. copilot-cli (interactive) semantics are
 * unchanged: enrolled containers emit OTel, so the gap is genuinely taggable usage.
 *
 * INTENTIONAL SURFACE DIVERGENCE (owner decision, r1 finding 5): because this exclusion
 * means the coding-agent lane never writes unaccounted_usage — and it has no OTel
 * attribution rows either — 'copilot-agent' dollars are ABSENT from v_complete_usage
 * (attribution ∪ unaccounted) and therefore from the completeness rollups (Across /
 * Regional / Cost-Centre usage cards), while remaining §A-VISIBLE in
 * v_teammate_usage_daily readers (e.g. Finance Overage Drivers). Folding them into
 * v_complete_usage would need a NON-TAGGABLE completeness feed (a union arm that can
 * never become a worklist item) — an owner follow-up, deliberately not done here. See
 * mig 0086's header; pinned by tests/integration/usage/copilot-usage-completeness.test.ts.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { GITHUB_INGEST_ONLY_USAGE_TOOLS } from '../../shared/usage/github-surface'
import { laneListSql } from '../../shared/usage/vendor'

type Db = PostgresJsDatabase<typeof schema>

export interface ReconcileUnaccountedOptions {
  /** Inclusive UTC day window [startDate, endDate] (YYYY-MM-DD). */
  startDate: string
  endDate: string
  /** Optional: reconcile a single teammate (else all). */
  teammateId?: string
}

export interface ReconcileUnaccountedResult {
  rowsUpserted: number
  /** Number of (teammate, day, tool) records that have a positive unaccounted delta. */
  recordsWithDelta: number
  totalUnaccountedUsd: number
}

export async function reconcileUnaccountedUsage(
  db: Db,
  opts: ReconcileUnaccountedOptions,
): Promise<ReconcileUnaccountedResult> {
  const teammateFilter = opts.teammateId ? sql`AND teammate_id = ${opts.teammateId}::uuid` : sql``
  const teammateFilterOtel = opts.teammateId ? sql`AND ar.teammate_id = ${opts.teammateId}::uuid` : sql``

  // One set-based upsert: aggregate the API total (actual_spend) and the OTel-captured
  // total (attribution_record) per (teammate, day, tool), take the floored difference,
  // upsert. project_id / activity / tagged_* are deliberately NOT in the SET (tag-preserving).
  const rows = await db.execute<{ id: string }>(sql`
    WITH api AS (
      SELECT teammate_id, day, tool, usage_usd AS api_usd, COALESCE(tokens, 0) AS api_tokens
      FROM v_teammate_usage_daily
      WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date
        -- Display-only lanes (see header): never a taggable unaccounted record.
        AND tool NOT IN (${laneListSql(GITHUB_INGEST_ONLY_USAGE_TOOLS)})
        ${teammateFilter}
    ),
    otel AS (
      SELECT ar.teammate_id,
             (ar.ts_event AT TIME ZONE 'UTC')::date AS day,
             ar.tool,
             SUM(ar.cost_usd) AS otel_usd,
             SUM(ar.tokens) AS otel_tokens
      FROM attribution_record ar
      WHERE ar.ts_event >= ${opts.startDate}::date::timestamptz
        AND ar.ts_event < (${opts.endDate}::date + 1)::timestamptz
        ${teammateFilterOtel}
        -- Exclude dev-CONFIRMED forgeries (mirrors over-emission-detection): otherwise a
        -- quarantined forgery inflates the OTel total and MASKS genuine un-enrolled usage
        -- that day (unaccounted = max(0, API − inflated-OTel) → wrongly 0). The under and
        -- over lanes must net against the SAME corroborated OTel.
        AND NOT EXISTS (
          SELECT 1 FROM session_quarantine sq
          WHERE sq.teammate_id = ar.teammate_id AND sq.conversation_id = ar.claude_session_id
            AND sq.resolved_at IS NULL AND sq.reason = 'api-uncorroborated')
      GROUP BY ar.teammate_id, (ar.ts_event AT TIME ZONE 'UTC')::date, ar.tool
    )
    INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, computed_at)
    SELECT api.teammate_id, t.region_id, t.org_unit_id, api.day, api.tool,
           GREATEST(0, api.api_usd - COALESCE(otel.otel_usd, 0))::numeric(14,6) AS cost_usd,
           GREATEST(0, api.api_tokens - COALESCE(otel.otel_tokens, 0))::bigint AS tokens,
           'api-reconciled', now()
    FROM api
    JOIN teammate t ON t.id = api.teammate_id
    LEFT JOIN otel ON otel.teammate_id = api.teammate_id AND otel.day = api.day AND otel.tool = api.tool
    ON CONFLICT (teammate_id, day, tool) DO UPDATE SET
      cost_usd = EXCLUDED.cost_usd,
      tokens = EXCLUDED.tokens,
      region_id = EXCLUDED.region_id,
      org_unit_id = EXCLUDED.org_unit_id,
      computed_at = now()
    RETURNING id::text AS id
  `)

  // Reconcile DOWN: an unaccounted row whose (teammate, day, tool) the view no longer backs. The
  // upsert above only ever raises/maintains keys the view CURRENTLY has; a key the view stopped
  // producing (the API source for that day went away, or a prior code version wrote a key this one
  // doesn't — e.g. copilot-cli rows once read from actual_spend before the §B bill was split out
  // of §A) would otherwise linger with a stale positive delta. §A must NEVER show MORE than the
  // provider truth, so an orphan is corrected. NOTE: bounded to the caller's window — the
  // usage-reconciliation worker runs a trailing window, so an orphan older than that window is not
  // reached here; that is acceptable because the developer-facing readers are month-scoped.
  const orphanScope = sql`
    u.day >= ${opts.startDate}::date AND u.day <= ${opts.endDate}::date
    ${opts.teammateId ? sql`AND u.teammate_id = ${opts.teammateId}::uuid` : sql``}
    AND NOT EXISTS (
      SELECT 1 FROM v_teammate_usage_daily v
      WHERE v.teammate_id = u.teammate_id AND v.day = u.day AND v.tool = u.tool
        -- Same display-only exclusion as the api CTE: the effective §A source is the
        -- FILTERED view, so a (bug-written) display-only key must read as an orphan
        -- and self-heal, not linger because the raw view still backs it.
        AND v.tool NOT IN (${laneListSql(GITHUB_INGEST_ONLY_USAGE_TOOLS)})
    )`
  // Untagged orphan: DELETE outright — no tag to keep, and a $0 row would be a permanent ghost in
  // "My projects" / needs-tagging. (If the view later re-produces the key, the upsert re-inserts.)
  await db.execute(sql`DELETE FROM unaccounted_usage u WHERE u.cost_usd > 0 AND u.project_id IS NULL AND ${orphanScope}`)
  // Tagged orphan: zero the amount but KEEP the row — the developer's tag (project/activity) is
  // preserved history; only its contribution drops to 0.
  await db.execute(sql`
    UPDATE unaccounted_usage u SET cost_usd = 0, tokens = 0, computed_at = now()
    WHERE u.cost_usd > 0 AND u.project_id IS NOT NULL AND ${orphanScope}`)

  // Summary over the freshly-reconciled window (the upserted set).
  const [agg] = await db.execute<{ n: string; usd: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE cost_usd > 0)::text AS n,
           COALESCE(SUM(cost_usd) FILTER (WHERE cost_usd > 0), 0)::text AS usd
    FROM unaccounted_usage
    WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date
      ${teammateFilter}
  `)

  return {
    rowsUpserted: rows.length,
    recordsWithDelta: Number(agg?.n ?? 0),
    totalUnaccountedUsd: Number(agg?.usd ?? 0),
  }
}
