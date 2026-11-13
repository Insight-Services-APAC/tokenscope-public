/*
 * closeEndedPeriodAlerts (#630): alerts about a month or a week close once that
 * period is over.
 *
 * Six worker-owned categories describe one period each and dedupe on
 * `created_at >= period start`, so next period a fresh item is raised and the
 * old one was never touched: inboxes filled with overruns of months long gone,
 * none of which anyone could act on. This sweep resolves them.
 *
 * WHAT IT CLOSES, and nothing else (the trap the issue names): only the six
 * categories below, only while open, only when the item is older than the
 * start of the CURRENT period AND older than the grace. Requests, device
 * faults, sync conflicts, Copilot billing and every other category have their
 * own endings and are never matched here.
 *
 * The grace (7 days, the PO's number) keeps an alert raised on the 30th from
 * closing unread on the 1st: it closes on the 7th instead.
 *
 * Month and week are UTC and come from the caller's `now`, never SQL's clock
 * (docs/design/clock-and-day-boundary.md), so tests inject the instant.
 *
 * "This month" in an untagged-backlog or reconciliation-gap subject means the
 * month it was raised in. Closing it at month end is right: the worker that
 * raised it evaluates the new month on its next run and raises a new item if
 * the gap is still there (reconciliation.ts / reconciliation-gap.ts dedupe on
 * the current month only).
 *
 * The body gains `closed_reason: 'period-ended'` and the period it was about
 * (`closed_month` 'YYYY-MM', or `closed_week_start` 'YYYY-MM-DD' for the weekly
 * velocity alert), so the inbox can say how it ended without re-deriving it.
 * The month is the body's own `month` when it has one, else the UTC month of
 * `created_at`: the workers stamp both from the same run.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { isoWeekStartUtc, monthStartIso } from '../utils/period'

/** Days an alert stays open after its period ends, so it is not closed unread overnight. */
export const PERIOD_CLOSE_GRACE_DAYS = 7

/** Categories about one UTC month. */
export const MONTHLY_ALERT_CATEGORIES = [
  'over-budget',
  'budget-nearly-used',
  'untagged-backlog',
  'over-attribution',
  'reconciliation-gap',
] as const

/** Categories about one ISO week. */
export const WEEKLY_ALERT_CATEGORIES = ['velocity-warning'] as const

export const PERIOD_ENDED = 'period-ended'

export async function closeEndedPeriodAlerts(
  db: PostgresJsDatabase<typeof schema>,
  now: Date,
): Promise<number> {
  const nowIso = now.toISOString()
  const monthStart = monthStartIso(now)
  const weekStart = isoWeekStartUtc(now).toISOString()
  const graceCutoff = new Date(now.getTime() - PERIOD_CLOSE_GRACE_DAYS * 86_400_000).toISOString()
  const monthly = sql.join(
    MONTHLY_ALERT_CATEGORIES.map((c) => sql`${c}`),
    sql`, `,
  )
  const weekly = sql.join(
    WEEKLY_ALERT_CATEGORIES.map((c) => sql`${c}`),
    sql`, `,
  )

  const closed = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved',
           ack_at = ${nowIso}::timestamptz,
           -- The system closed it: no person is its actor, even when a reader
           -- had marked it read or acknowledged before (Copilot, PR 639).
           ack_by = NULL,
           body = body || CASE
             WHEN category IN (${weekly}) THEN jsonb_build_object(
               'closed_reason', ${PERIOD_ENDED}::text,
               'closed_week_start',
               to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'))
             ELSE jsonb_build_object(
               'closed_reason', ${PERIOD_ENDED}::text,
               'closed_month',
               COALESCE(
                 CASE WHEN body->>'month' ~ '^\\d{4}-\\d{2}$' THEN body->>'month' END,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM')))
           END
     WHERE ack_state IN ('unread', 'read', 'acknowledged')
       AND created_at < ${graceCutoff}::timestamptz
       AND (
         (category IN (${monthly}) AND created_at < ${monthStart}::timestamptz)
         OR (category IN (${weekly}) AND created_at < ${weekStart}::timestamptz)
       )
    RETURNING id::text AS id
  `)
  return [...closed].length
}
