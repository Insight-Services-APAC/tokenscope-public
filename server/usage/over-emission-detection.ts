/*
 * Over-emission detection — the integrity counterpart of §A's unaccounted reconciliation.
 * docs/design/provider-billing-attribution-model.md §A + ADR-0010 rule 2 / ADR-0008.
 *
 * The provider API is the truth. When OTel emits MORE than the API corroborates
 * (accidentally or maliciously — a forged/mis-tagged emission), the excess is flagged for
 * the developer to review. Per (teammate, day, tool):
 *
 *     over = max(0, Σ OTel(excl. already-quarantined) − API daily total)
 *
 * CRITICAL — basis (CLAUDE lane): actual_spend is the provider BILL; attribution_record is the
 * OTel rate-carded ESTIMATE (different money bases — that's why a cost-drift view exists). So
 * `OTel − bill` is NON-zero for honest usage whenever the rate card runs high, and a naive
 * flag would CRY FRAUD on honest heavy users. (The COPILOT lane is cleaner: both OTel cost and
 * the reconciliation usage are gross-credits × $0.01, the SAME basis, so honest Copilot usage
 * sits at ~1.0× — the guards below still apply uniformly.) Two guards keep this an integrity
 * signal, not an estimate-drift alarm:
 *   1. MATERIALITY — flag only when OTel EXCEEDS 2× the bill AND the excess clears a high
 *      absolute floor (over > GREATEST($25, 1.0 × api)). A forgery (API $50, OTel $500) is
 *      10×; honest rate-card drift lives in the 1.1–1.5× band and never trips this.
 *   2. SETTLED-BILL ONLY — the bill for recent days is still filling (the hourly poller)
 *      while OTel is real-time, so we never flag the trailing `settledLagDays` (default 3);
 *      a transiently-incomplete bill must not read as forgery.
 *
 * The OTel sum EXCLUDES conversations already in an open api-uncorroborated quarantine, so
 * once the dev quarantines the suspect session the over recomputes down (and the flag
 * clears). State + the suspect session are PRESERVED across recompute; a recompute whose
 * over MATERIALLY exceeds the watermark at resolution RE-OPENS the flag (a new forgery on
 * a day the dev already vouched for is not silently swallowed).
 *
 * Both providers: the per-(teammate, day, tool) API USAGE truth comes from the
 * `v_teammate_usage_daily` view (mig 0073) — claude-code from actual_spend, copilot-cli GROSS
 * from reconciliation_record (GitHub ai_credit/usage is per-(user, day)). Do NOT confuse this
 * per-user USAGE with Copilot's POOLED per-cost-centre BILL (§B) — different axis. A tool with
 * no API usage that day yields api_usd=0 and is never flagged (the materiality guard below).
 *
 * The display-only 'copilot-agent' lane (mig 0086, design D4) needs no exclusion here: the
 * computation starts FROM the OTel side and joins the API truth onto it, and no OTel emission
 * ever carries tool='copilot-agent' (the category is OTEL_INVISIBLE) — so its view rows are
 * structurally unreachable. Splitting the coding-agent credits OUT of the copilot-cli api_usd
 * (0086) also puts interactive OTel and interactive API on the SAME basis, tightening the
 * Copilot corroboration rather than loosening it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

/** Materiality: OTel must exceed 2× the bill (over > 1.0×api) AND clear a high absolute
 *  floor — so rate-card estimate drift (bill vs estimate basis) is never flagged. */
export const OVER_EMISSION_MIN_USD = 25.0
export const OVER_EMISSION_REL = 1.0
/** Days whose bill is still settling are never flagged (poller fills hourly; OTel is real-time). */
export const OVER_EMISSION_SETTLED_LAG_DAYS = 3
/** A resolved flag re-opens only when the new over exceeds the watermark by this factor. */
export const OVER_EMISSION_REFLAG_FACTOR = 1.5

export interface OverEmissionOptions {
  startDate: string
  endDate: string
  teammateId?: string
  /** Don't flag days newer than (endDate − this). Default OVER_EMISSION_SETTLED_LAG_DAYS. */
  settledLagDays?: number
}

export interface OverEmissionResult {
  flagged: number
  totalOverUsd: number
}

export async function detectOverEmission(db: Db, opts: OverEmissionOptions): Promise<OverEmissionResult> {
  const teammateFilterApi = opts.teammateId ? sql`AND teammate_id = ${opts.teammateId}::uuid` : sql``
  const teammateFilterOtel = opts.teammateId ? sql`AND ar.teammate_id = ${opts.teammateId}::uuid` : sql``

  // Settled-bill cutoff: never flag days whose bill is still filling.
  const lag = opts.settledLagDays ?? OVER_EMISSION_SETTLED_LAG_DAYS
  const cutoff = new Date(`${opts.endDate}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - lag)
  const settledBefore = cutoff.toISOString().slice(0, 10)

  // Shared computation: per (teammate, day, tool), the OTel total EXCLUDING open-quarantined
  // conversations, vs the API truth; the material over-emission.
  const computed = sql`
    WITH api AS (
      SELECT teammate_id, day, tool, usage_usd AS api_usd
      FROM v_teammate_usage_daily
      WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date ${teammateFilterApi}
    ),
    otel AS (
      SELECT ar.teammate_id, (ar.ts_event AT TIME ZONE 'UTC')::date AS day, ar.tool, SUM(ar.cost_usd) AS otel_usd
      FROM attribution_record ar
      WHERE ar.ts_event >= ${opts.startDate}::date::timestamptz
        AND ar.ts_event < (${opts.endDate}::date + 1)::timestamptz ${teammateFilterOtel}
        AND NOT EXISTS (
          -- Exclude conversations the dev has CONFIRMED as forgeries (over-emission resolve
          -- writes reason='api-uncorroborated'); the existing informational heartbeat badge
          -- ('no-covering-heartbeat') is NOT excluded — it never wipes spend (ADR-0008).
          SELECT 1 FROM session_quarantine sq
          WHERE sq.teammate_id = ar.teammate_id
            AND sq.conversation_id = ar.claude_session_id
            AND sq.resolved_at IS NULL
            AND sq.reason = 'api-uncorroborated'
        )
      GROUP BY ar.teammate_id, (ar.ts_event AT TIME ZONE 'UTC')::date, ar.tool
    ),
    recon AS (
      SELECT otel.teammate_id, otel.day, otel.tool,
             otel.otel_usd,
             COALESCE(api.api_usd, 0) AS api_usd,
             GREATEST(0, otel.otel_usd - COALESCE(api.api_usd, 0)) AS over_usd
      FROM otel
      LEFT JOIN api ON api.teammate_id = otel.teammate_id AND api.day = otel.day AND api.tool = otel.tool
    ),
    material AS (
      SELECT * FROM recon
      -- api_usd > 0: there must be an actual bill for that day to corroborate against.
      -- api=0 means the bill is MISSING (org not reconciled) OR genuinely $0 — we can't
      -- tell which, so we never read "no bill data" as "forgery". (Without this, every
      -- OTel day for a teammate whose org isn't reconciled false-flags as uncorroborated.)
      WHERE api_usd > 0
        AND over_usd > GREATEST(${OVER_EMISSION_MIN_USD}, ${OVER_EMISSION_REL} * api_usd)
        AND day <= ${settledBefore}::date   -- settled-bill only (don't flag a still-filling day)
    )`

  // 1. Upsert the material over-emissions (preserve the dev's state + suspect-session call).
  const flagged = await db.execute<{ id: string }>(sql`
    ${computed}
    INSERT INTO over_emission (teammate_id, region_id, org_unit_id, day, tool, otel_usd, api_usd, over_usd, computed_at)
    SELECT m.teammate_id, t.region_id, t.org_unit_id, m.day, m.tool,
           m.otel_usd::numeric(14,6), m.api_usd::numeric(14,6), m.over_usd::numeric(14,6), now()
    FROM material m JOIN teammate t ON t.id = m.teammate_id
    ON CONFLICT (teammate_id, day, tool) DO UPDATE SET
      otel_usd = EXCLUDED.otel_usd, api_usd = EXCLUDED.api_usd, over_usd = EXCLUDED.over_usd, computed_at = now(),
      -- Re-open a resolved flag when a NEW forgery pushes the over materially past what the
      -- dev vouched for (watermark); otherwise the dev's call stands.
      state = CASE
        WHEN over_emission.state <> 'open'
          AND over_emission.resolved_over_usd IS NOT NULL
          AND EXCLUDED.over_usd > over_emission.resolved_over_usd * ${OVER_EMISSION_REFLAG_FACTOR}
        THEN 'open' ELSE over_emission.state END,
      resolved_at = CASE
        WHEN over_emission.state <> 'open'
          AND over_emission.resolved_over_usd IS NOT NULL
          AND EXCLUDED.over_usd > over_emission.resolved_over_usd * ${OVER_EMISSION_REFLAG_FACTOR}
        THEN NULL ELSE over_emission.resolved_at END
    RETURNING id::text AS id
  `)

  // 2. Refresh any window row whose over is no longer material to 0 — covers an OPEN flag
  //    falling below threshold AND a row the dev already resolved (e.g. quarantined the
  //    suspect session → OTel dropped → over now 0). State is preserved either way; only
  //    the stored over_usd is corrected to current reality.
  await db.execute(sql`
    ${computed}
    UPDATE over_emission oe SET over_usd = 0, computed_at = now()
    WHERE oe.over_usd > 0
      AND oe.day >= ${opts.startDate}::date AND oe.day <= ${opts.endDate}::date
      ${opts.teammateId ? sql`AND oe.teammate_id = ${opts.teammateId}::uuid` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM material m
        WHERE m.teammate_id = oe.teammate_id AND m.day = oe.day AND m.tool = oe.tool
      )
  `)

  const [agg] = await db.execute<{ n: string; usd: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE state = 'open' AND over_usd > 0)::text AS n,
           COALESCE(SUM(over_usd) FILTER (WHERE state = 'open' AND over_usd > 0), 0)::text AS usd
    FROM over_emission
    WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date
      ${opts.teammateId ? sql`AND teammate_id = ${opts.teammateId}::uuid` : sql``}
  `)

  return { flagged: flagged.length, totalOverUsd: Number(agg?.usd ?? 0) }
}
