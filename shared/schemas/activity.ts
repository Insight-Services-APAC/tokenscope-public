/*
 * Activity — ONE list of what the caller actually did, holding BOTH kinds of
 * record this platform can hold about them (owner ruling, 2026-08-05; design
 * docs/design/developer-pages-consolidation/04-fix-sprint-design.md §F4).
 *
 * WHY IT IS NOT CALLED "SESSIONS". A session is one `claude` run, one
 * conversation (AGENTS.md §Domain model). A provider-recorded day is not one —
 * it is a (teammate, day, tool) bucket the provider's API counted. A list named
 * for a thing it does not only contain rebuilds the vocabulary problem, so
 * sessions are ONE KIND OF ROW within Activity.
 *
 * WHAT IT FIXES. `/me/sessions/recent` read `attribution_record` (OTel only, by
 * design), and the only other surface that ever listed a provider-recorded day
 * was the needs-tagging worklist, which filters `project_id IS NULL`. Tagging a
 * provider day therefore REMOVED it from the only list that showed it. Activity
 * is the record of what happened; the worklist stays as the task list of what
 * still awaits a decision. Two different questions, two surfaces.
 *
 * GRAIN, WHICH IS WHERE THIS GOES WRONG IF UNATTENDED. A session is an instant
 * (`attribution_record.ts_event`, timestamptz). A provider-recorded day is a
 * bucket with NO time in it. Both SORT on the UTC day — one sort key, which
 * keyset pagination needs anyway — and each row RENDERS its own grain: a
 * session carries `ts_last` and shows a local time; a provider-day row carries
 * NO timestamp field at all and shows a date. A synthesised `00:00` would be the
 * NULL-as-0 defect in a new costume, so the type makes it unrepresentable.
 *
 * WHAT THIS LIST CLAIMS, AND WHAT IT DOES NOT (D19). It claims NON-DUPLICATION:
 * no record appears twice, across the union and across pages. It does NOT claim
 * conservation, and deliberately carries no total — the two row kinds are
 * different quantities (a session's ledger cost vs. a day's reconciled residual,
 * `max(0, API day total − Σ OTel captured)`), so a sum over the list would be an
 * arithmetic that means nothing. The month's authoritative totals live on
 * /me/usage.
 */
import { z } from 'zod'

/** The two kinds of record Activity holds. Rows are a discriminated union. */
export const ACTIVITY_KINDS = ['session', 'provider-day'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** Default page size for `GET /me/activity`. */
export const ACTIVITY_PAGE_DEFAULT = 25
/**
 * Per-page ceiling. Also the PER-BRANCH read cap inside the union: each side of
 * the union is bounded independently (D18). That bounds the WORK, not the mix —
 * the page is still the global top-n of one descending-day order, so a teammate
 * whose newest n records are all sessions gets a page of all sessions and their
 * provider-recorded days follow on later pages, in their days' place. Nothing is
 * dropped; no per-kind share is promised. See server/usage/activity-list.ts.
 */
export const ACTIVITY_PAGE_MAX = 100
/**
 * Row ceiling on the CSV export. The export applies the reader's filters
 * VERBATIM (see `ActivityFilterQuery`) but it is NOT unbounded: a filtered set
 * larger than the requested `limit` is TRUNCATED to the newest `limit` rows,
 * silently on the wire. "The CSV matches what you are looking at" is a claim
 * about the FILTERS, not about completeness — do not read it as the latter.
 */
export const ACTIVITY_EXPORT_MAX = 5000
/**
 * Default row count on the CSV export when the caller names no `limit`. A
 * teammate with more than this many matching rows gets the newest 1000 and no
 * indication that anything was cut; raise `limit` (up to `ACTIVITY_EXPORT_MAX`)
 * to widen it.
 */
export const ACTIVITY_EXPORT_DEFAULT = 1000

/**
 * A `YYYY-MM-DD` that is a REAL calendar day.
 *
 * The shape regex alone admits `2026-02-31` and `2026-02-29`, which then travel
 * all the way to Postgres's `::date` cast in the branch predicates and abort the
 * query — a 500 on what is plainly a caller error. Validation belongs at the
 * boundary, where it is a 400.
 *
 * The check is a UTC round-trip, not a month-length table: `Date.parse` of an
 * ISO instant ROLLS OVER (`2026-02-31` → `2026-03-03`), so a day that survives
 * re-serialisation unchanged is exactly a day that exists. Leap years come out
 * of the calendar rather than out of a rule someone has to keep correct. This
 * parses a caller-supplied literal — it reads no clock (see
 * docs/design/clock-and-day-boundary.md).
 *
 * THE ROUND-TRIP ALONE IS NOT ENOUGH: JAVASCRIPT HAS A YEAR ZERO AND POSTGRES
 * DOES NOT (external review r2). `0000-01-01` is a real ISO-8601 instant, so it
 * round-trips here unchanged — and `'0000-01-01'::date` then aborts the query
 * with `date/time field value out of range`, which is the exact 500 this
 * validator exists to turn into a 400. Postgres's text form is AD/BC and has no
 * year 0: `0001-01-01` is the first day it will cast, and the shape regex
 * already caps the other end at `9999`. So the accepted range is `[0001, 9999]`
 * — the range Postgres can represent through this literal, not a business rule.
 */
const MIN_YEAR = 1

export function isRealUtcDay(day: string): boolean {
  if (Number(day.slice(0, 4)) < MIN_YEAR) return false
  const t = Date.parse(`${day}T00:00:00.000Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day
}

const UtcDayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealUtcDay, { message: 'not a real calendar day' })

/**
 * The filters, shared VERBATIM by the list and the CSV (D20) — one schema, so
 * an export can never quietly widen or narrow what the reader was looking at.
 * (It can still be SHORTER than the list: see `ACTIVITY_EXPORT_DEFAULT`.)
 *
 * `tagged` is deliberately separate from `project`: "is this on a budget at
 * all" is a different question from "is it on THIS budget", and folding the
 * first into a sentinel value of the second ('none') would make a project whose
 * code happened to be that sentinel unaddressable.
 */
export const ActivityFilterQuery = z.object({
  kind: z.enum(['all', ...ACTIVITY_KINDS]).default('all'),
  /** Emitting client, e.g. `claude-code` / `copilot-cli`. */
  tool: z.string().min(1).max(64).optional(),
  /** Project CODE. A session that touched several projects matches any of them. */
  project: z.string().min(1).max(64).optional(),
  /** On a budget, off a budget, or both. */
  tagged: z.enum(['all', 'tagged', 'untagged']).default('all'),
  /** Inclusive UTC-day bounds. The day is UTC everywhere — see docs/design/clock-and-day-boundary.md. */
  from: UtcDayString.optional(),
  to: UtcDayString.optional(),
})
export type ActivityFilters = z.infer<typeof ActivityFilterQuery>

export const ActivityListQuery = ActivityFilterQuery.extend({
  /** Opaque keyset cursor from a previous page's `next_cursor`. */
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().positive().max(ACTIVITY_PAGE_MAX).default(ACTIVITY_PAGE_DEFAULT),
})
export type ActivityListQuery = z.infer<typeof ActivityListQuery>

export const ActivityExportQuery = ActivityFilterQuery.extend({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(ACTIVITY_EXPORT_MAX)
    .default(ACTIVITY_EXPORT_DEFAULT),
})
export type ActivityExportQuery = z.infer<typeof ActivityExportQuery>

/** What every Activity row carries, whatever its kind. */
export interface ActivityRowBase {
  /** Conversation key for a session; `unaccounted_usage.id` for a provider day. */
  id: string
  /** The UTC day this row sorts on, `YYYY-MM-DD`. Never converted for display. */
  day: string
  tool: string
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  activity: string | null
  /**
   * NULL = THE PROVIDER REPORTED NO TOKEN QUANTITY, which is not zero. Only a
   * provider-day row can carry it (a session's tokens are OTel-observed, always
   * a measurement — `ActivitySessionRow` narrows this back to `number`).
   *
   * GitHub's `ai_credit/usage` meters Copilot in ai-credits and reports no
   * tokens at all, so EVERY Copilot day is this case. The store cannot say so —
   * `unaccounted_usage.tokens` is NOT NULL DEFAULT 0 — so the read re-derives it
   * from the provider view the residual was computed from
   * (server/usage/activity-list.ts). Renderers must show absence ("—", "not
   * reported"), never `0`, and must never sum a null into a total.
   */
  tokens: number | null
  cost_usd: string
  /** false = no project on it (yet). */
  attributed: boolean
  /** This row's keyset position — pass the last row's cursor back as `cursor`. */
  cursor: string
}

/**
 * An OTel-observed conversation. `ts_last` is a REAL INSTANT (the conversation's
 * most recent event) and renders in the viewer's zone.
 */
export interface ActivitySessionRow extends ActivityRowBase {
  kind: 'session'
  /** OTel counted these events; a session's token quantity is never unknown. */
  tokens: number
  ts_last: string
  instance_id: string | null
  /** D2a: the conversation spans a project-end boundary. */
  partly_ended: boolean
  ended_project_code: string | null
  models?: string[]
  by_model?: { model: string; tokens: number; cost_usd: string }[]
}

/**
 * A day the provider's API counted. THERE IS NO TIMESTAMP FIELD ON THIS TYPE and
 * there must never be one: no instant exists at this grain, and inventing one
 * would be a fabricated measurement. `day` is the whole of what is known.
 */
export interface ActivityProviderDayRow extends ActivityRowBase {
  kind: 'provider-day'
  /** Decided-and-left-unallocated on the worklist. Still a record of what happened. */
  dismissed: boolean
}

export type ActivityRow = ActivitySessionRow | ActivityProviderDayRow

/**
 * The page. NO TOTAL — see the non-duplication note at the top of this file.
 *
 * It also carries NO echo of the applied filters. One was shipped on the theory
 * that the table and the CSV link could be "proven to be looking at the same
 * thing" by comparing it; nothing ever read it, and it could not have proven
 * that anyway — the CSV is a separate request whose filters come from the same
 * client state, so an echo on THIS response says nothing about THAT one. The
 * guarantee that matters is structural (one `ActivityFilterQuery`, D20).
 */
export interface ActivityListResponse {
  rows: ActivityRow[]
  next_cursor: string | null
  has_more: boolean
}

/** CSV column order, single-sourced so the header and the rows cannot drift. */
export const ACTIVITY_CSV_COLUMNS = [
  'kind',
  'id',
  'day',
  'when',
  'tool',
  'project_code',
  'project_display_name',
  'activity',
  'tokens',
  'cost_usd',
] as const
