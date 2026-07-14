/*
 * Reconciliation-gap alert worker (ADR-0005 decision 4 — the first-class
 * safety net the detection-based P2 defense leans on).
 *
 * The disaster: emission silently dropped for ~12h and nothing noticed until a
 * human eyeballed the numbers a day later. The went-silent detector catches an
 * instance that STOPS emitting; this catches the COMPLEMENTARY failure — spend
 * that Anthropic's authoritative actuals show but OTel never attributed (emit
 * gap, mis-config, a window the backfill didn't cover, or — the P2 angle —
 * volume that should be there but isn't). It is the ADR-0004 §5 volume guardrail
 * made first-class.
 *
 * Relationship to reconciliation.ts: that worker emits an INFO `untagged-backlog`
 * nudge at a 10% UNDER-attribution gap ("tag your sessions"). This is a louder,
 * higher-bar, attention-severity `reconciliation-gap` alert — a real
 * reconciliation safety net, not a tagging nudge — fired only when the gap is
 * material by BOTH a percentage AND an absolute-dollar floor (so a $3 gap on a
 * tiny month doesn't page anyone, and a large absolute gap on a big month does).
 *
 * Gap = (anthropic_actual - otel_attributed) / anthropic_actual, on the
 * RECONCILABLE lane only (cost_basis <> 'telemetry-only'): telemetry-only
 * attribution lives in a provider org our Anthropic API can't see, so comparing
 * it against actual_spend manufactures false gaps. Backfilled records are
 * telemetry-only by construction, so they neither close nor widen this gap —
 * correct, since backfill is advisory, not reconciled truth.
 *
 * Threshold (configurable via env, with safe defaults):
 *   NUXT_RECONCILIATION_GAP_PCT   — fractional gap bar (default 0.20 = 20%).
 *   NUXT_RECONCILIATION_GAP_USD   — absolute dollar floor (default 50).
 * BOTH must be exceeded to alert.
 *
 * Dedup: one open reconciliation-gap item per (teammate, month). Re-runs don't
 * re-alert until the recipient acks/resolves; a new month raises a fresh one.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox, type InboxCategory } from '../notifications/dispatch'
import { recordAuditEvent } from '../db/audit'

export interface ReconciliationGapResult {
  teammatesScanned: number
  gapsAlerted: number
  skippedExisting: number
}

const RECONCILIATION_GAP_CATEGORY = 'reconciliation-gap' as InboxCategory

function gapPctThreshold(): number {
  const raw = Number(process.env.NUXT_RECONCILIATION_GAP_PCT)
  return Number.isFinite(raw) && raw > 0 ? raw : 0.2
}
function gapUsdThreshold(): number {
  const raw = Number(process.env.NUXT_RECONCILIATION_GAP_USD)
  return Number.isFinite(raw) && raw >= 0 ? raw : 50
}

export async function runReconciliationGap(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date; gapPct?: number; gapUsd?: number },
): Promise<ReconciliationGapResult> {
  const now = opts?.now ?? new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const pctBar = opts?.gapPct ?? gapPctThreshold()
  const usdBar = opts?.gapUsd ?? gapUsdThreshold()

  // Same lane discipline as reconciliation.ts: Anthropic actuals (authoritative)
  // vs the reconcilable OTel lane (telemetry-only excluded). actual rows drive
  // the join, so a teammate with no actual_spend (poller not yet run) yields no
  // rows → no false "everything is missing" storm.
  const rows = await db.execute<{
    teammate_id: string
    actual_cost: string
    otel_cost: string
  }>(
    sql`
      WITH anthropic AS (
        SELECT teammate_id, COALESCE(SUM(cost_usd), 0)::text AS cost
        FROM actual_spend
        WHERE date >= ${monthStart.toISOString().slice(0, 10)}::date
          AND (source = 'anthropic-analytics-api' OR source LIKE 'anthropic-analytics-api:%')
        GROUP BY teammate_id
      ),
      otel AS (
        SELECT teammate_id, COALESCE(SUM(cost_usd), 0)::text AS cost
        FROM attribution_record
        WHERE ts_event >= ${monthStart.toISOString()}::timestamptz
          AND cost_basis <> 'telemetry-only'
          -- Provisional (emit-on-install, pre-confirmation) usage must never page a
          -- human or feed a manager/comp signal (design §Safety properties). NULL =
          -- legacy rows that predate the provisional path = treated as confirmed.
          AND identity_state IS DISTINCT FROM 'provisional'
        GROUP BY teammate_id
      )
      SELECT
        a.teammate_id::text AS teammate_id,
        a.cost AS actual_cost,
        COALESCE(o.cost, '0') AS otel_cost
      FROM anthropic a
      LEFT JOIN otel o ON o.teammate_id = a.teammate_id
    `,
  )

  let alerted = 0
  let skippedExisting = 0
  for (const r of rows) {
    const actual = Number(r.actual_cost)
    const otel = Number(r.otel_cost)
    if (actual <= 0) continue
    const gapUsd = actual - otel
    const gapPct = gapUsd / actual
    // UNDER-attribution only (actuals exceed what OTel attributed). Over-
    // attribution is reconciliation.ts's lane. Require BOTH bars.
    if (gapPct < pctBar || gapUsd < usdBar) continue

    if (await hasOpenItem(db, r.teammate_id, monthStart)) {
      skippedExisting += 1
      continue
    }

    const dispatched = await dispatchInbox(db, {
      category: RECONCILIATION_GAP_CATEGORY,
      severity: 'attention',
      subject: `Reconciliation gap: $${gapUsd.toFixed(2)} (${(gapPct * 100).toFixed(0)}%) of your actual Claude spend isn't attributed`,
      body: {
        anthropic_actual_usd: actual,
        otel_attributed_usd: otel,
        gap_usd: gapUsd,
        gap_pct: gapPct,
        month: monthStart.toISOString().slice(0, 7),
        note: 'Anthropic actuals show materially more spend than TokenScope attributed this month — emission may have dropped for a window. If you know the gap window, /tokenscope:backfill can re-emit recent local transcripts (advisory). Otherwise check /tokenscope:status.',
      },
      recipientTeammateIdHint: r.teammate_id,
    })
    if (dispatched.length > 0) {
      alerted += 1
      await recordAuditEvent(db, {
        eventType: 'reconciliation-gap-flagged',
        actorSystem: 'reconciliation-gap',
        subjectKind: 'teammate',
        subjectId: r.teammate_id,
        payload: {
          anthropic_actual_usd: actual,
          otel_attributed_usd: otel,
          gap_usd: gapUsd,
          gap_pct: gapPct,
          month: monthStart.toISOString().slice(0, 7),
        },
      })
    }
  }

  return { teammatesScanned: rows.length, gapsAlerted: alerted, skippedExisting }
}

/** Dedup: an unresolved reconciliation-gap item for this teammate this month. */
async function hasOpenItem(
  db: PostgresJsDatabase<typeof schema>,
  teammateId: string,
  monthStart: Date,
): Promise<boolean> {
  const existing = await db.execute<{ id: string }>(
    sql`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'reconciliation-gap'
        AND ack_state IN ('unread', 'read', 'acknowledged')
        AND created_at >= ${monthStart.toISOString()}::timestamptz
      LIMIT 1
    `,
  )
  return existing.length > 0
}
