/*
 * Per-teammate weekly velocity-watch worker.
 *
 * Per docs/build/mvp-final-epic.md §Producer-layer convergence: the
 * `velocity-warning` inbox category was hard-coded in `drizzle/seed.ts`
 * before MVP-Final. This worker is the live producer that replaces the
 * seed-driven dispatch — it reads `attribution_record`, buckets cost by
 * ISO-week per teammate, and fires when this week's spend is more than
 * 25% above the 4-week trailing mean.
 *
 * Body field shape mirrors `app/components/inbox/DrawerBodyVelocity.vue`
 * exactly: { weeklySeries, meanUsd, currentUsd, deltaPct }. The server
 * threshold is now a configurable governance dial ('velocity.spike_threshold',
 * mig 0049 — region override wins over platform, resolved per teammate's
 * region). The drawer keys the stroke color off `deltaPct >= 0.25`
 * INTENTIONALLY as a static display constant — a dispatched alert always
 * carries a noteworthy delta, so the colour bar need not track the dial.
 *
 * ISO-week handling uses `date_trunc('week', ts_event AT TIME ZONE 'UTC')`
 * — PG's week truncation is ISO-week aligned (Monday start) and the
 * Monday timestamp is unambiguous across year boundaries (vs the
 * EXTRACT(week)+EXTRACT(year) approach which can disagree on week 53 / 1).
 *
 * Idempotency: skip dispatch when an open velocity-warning inbox_item
 * already exists for this teammate, created on or after the start of the
 * current week. The check mirrors the reconciliation worker's pattern
 * (one item per teammate per detection window).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
} from '../utils/governance-settings'

export interface VelocityWatchResult {
  teammatesScanned: number
  alertsDispatched: number
  skippedExisting: number
}

const TRAILING_WEEKS = 4
// Window length = trailing + current = 5 weeks
const WINDOW_WEEKS = TRAILING_WEEKS + 1

interface WeeklyRow extends Record<string, unknown> {
  teammate_id: string
  email: string
  display_name: string | null
  region_id: string | null
  week_start: string
  week_usd: string
}

export async function runVelocityWatch(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<VelocityWatchResult> {
  const now = opts?.now ?? new Date()
  // Compute the Monday-start of the current ISO week in UTC. Postgres'
  // date_trunc('week', ...) returns a Monday; do the same in JS so the
  // app-side comparisons line up.
  const currentWeekStart = isoWeekStartUtc(now)
  // Lower bound of the scan window — start of week W-4 (i.e. 4 weeks
  // before the current week starts). At the SQL level we use an absolute
  // timestamp rather than NOW()-INTERVAL so the worker is testable with
  // an injected `now`.
  const windowStart = addWeeksUtc(currentWeekStart, -TRAILING_WEEKS)

  // Spike-threshold dial (mig 0049): one snapshot per run — platform value +
  // every region override — then resolved per teammate's region below. The
  // worker scans all regions, so per-teammate resolution keeps a region's
  // override scoped to its own teammates without a query per row.
  const thresholdFor = await loadGovernanceSettingResolver(db, GOV_VELOCITY_SPIKE_THRESHOLD)

  const rows = await db.execute<WeeklyRow>(sql`
    SELECT t.id::text AS teammate_id,
           t.email,
           t.display_name,
           t.region_id::text AS region_id,
           to_char(date_trunc('week', ar.ts_event AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week_start,
           SUM(ar.cost_usd)::float8::text AS week_usd
    -- §A COMPLETE spend, not raw attribution_record. Copilot per-user usage lands
    -- in unaccounted_usage (native OTLP is default-off), so reading
    -- attribution_record alone made this worker blind to Copilot: a Copilot-only
    -- teammate had zero rows here and could never trip a spike, and a
    -- claude→copilot switch read as a spurious velocity DROP. v_complete_usage
    -- unions both lanes (no double-count) and drops dev-confirmed forgeries.
    -- The canonical statement of this seam lives in server/usage/complete-spend.ts.
    FROM teammate t
    JOIN v_complete_usage ar ON ar.teammate_id = t.id
    WHERE ar.ts_event >= ${windowStart.toISOString()}::timestamptz
      AND ar.ts_event <  ${addWeeksUtc(currentWeekStart, 1).toISOString()}::timestamptz
      -- Provisional (emit-on-install, pre-confirmation) usage must never feed this
      -- manager-facing velocity signal. NULL = legacy = treated as confirmed.
      -- (identity_state was added to v_complete_usage by mig 0089 precisely so this
      -- exclusion survives the move off raw attribution_record.)
      AND ar.identity_state IS DISTINCT FROM 'provisional'
    GROUP BY t.id, t.email, t.display_name, t.region_id, date_trunc('week', ar.ts_event AT TIME ZONE 'UTC')
    ORDER BY t.id, week_start
  `)

  // Group rows by teammate.
  const byTeammate = new Map<
    string,
    {
      email: string
      displayName: string | null
      regionId: string | null
      weeks: Map<string, number>
    }
  >()
  for (const r of rows) {
    let entry = byTeammate.get(r.teammate_id)
    if (!entry) {
      entry = {
        email: r.email,
        displayName: r.display_name,
        regionId: r.region_id,
        weeks: new Map(),
      }
      byTeammate.set(r.teammate_id, entry)
    }
    // week_start comes back as YYYY-MM-DD from to_char(...). Use the
    // string directly as the map key — bypasses JS Date timezone
    // ambiguity around midnight.
    entry.weeks.set(r.week_start, Number(r.week_usd))
  }

  let alertsDispatched = 0
  let skippedExisting = 0
  const currentWeekKey = currentWeekStart.toISOString().slice(0, 10)

  for (const [teammateId, info] of byTeammate) {
    // Build the 5-slot weeklySeries in chronological order so the drawer
    // sparkline reads left-to-right oldest→current.
    const series: number[] = []
    for (let i = WINDOW_WEEKS - 1; i >= 0; i--) {
      const wk = addWeeksUtc(currentWeekStart, -i)
      const key = wk.toISOString().slice(0, 10)
      series.push(info.weeks.get(key) ?? 0)
    }
    const currentUsd = info.weeks.get(currentWeekKey) ?? 0
    const priorWeeks = series.slice(0, TRAILING_WEEKS)
    // Need every prior week populated — a teammate with only 2 weeks
    // of history shouldn't be flagged on a single big day.
    const priorPopulated = priorWeeks.filter((w) => w > 0)
    if (priorPopulated.length < TRAILING_WEEKS) continue
    const meanUsd = priorWeeks.reduce((a, b) => a + b, 0) / TRAILING_WEEKS
    if (meanUsd <= 0) continue
    if (currentUsd <= meanUsd * (1 + thresholdFor(info.regionId))) continue

    // Idempotency check: skip if there's already an open velocity-warning
    // for this teammate created this week.
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
        AND ack_state IN ('unread', 'read', 'acknowledged')
        AND created_at >= ${currentWeekStart.toISOString()}::timestamptz
      LIMIT 1
    `)
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const deltaPct = currentUsd / meanUsd - 1
    const who = info.displayName?.trim() || info.email
    const pctRounded = Math.round(deltaPct * 100)

    await dispatchInbox(db, {
      category: 'velocity-warning',
      severity: 'attention',
      subject: `${who} weekly token velocity is +${pctRounded}% above typical`,
      body: {
        weeklySeries: series.map((n) => roundTo(n, 2)),
        meanUsd: roundTo(meanUsd, 2),
        currentUsd: roundTo(currentUsd, 2),
        deltaPct,
      },
      relatedEntityKind: 'teammate',
      relatedEntityId: teammateId,
      recipientTeammateIdHint: teammateId,
    })
    alertsDispatched += 1
  }

  return {
    teammatesScanned: byTeammate.size,
    alertsDispatched,
    skippedExisting,
  }
}

/**
 * Truncate a `Date` to the start (Monday 00:00 UTC) of its ISO week.
 *
 * `Date#getUTCDay()` returns 0 for Sunday — for ISO weeks Monday is day
 * 1 and Sunday is day 7. The expression `(day + 6) % 7` maps Mon→0,
 * Tue→1, ..., Sun→6, which is the offset we need to subtract.
 */
function isoWeekStartUtc(d: Date): Date {
  const day = d.getUTCDay()
  const offset = (day + 6) % 7
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset, 0, 0, 0, 0),
  )
}

function addWeeksUtc(d: Date, weeks: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7 * weeks, 0, 0, 0, 0),
  )
}

function roundTo(n: number, places: number): number {
  const m = 10 ** places
  return Math.round(n * m) / m
}
