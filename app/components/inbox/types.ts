/*
 * Shared types and the per-kind drawer-body routing function for the
 * inbox UI. Extracted out of InboxDrawer.vue so the routing logic is
 * unit-testable without mounting the component.
 */
import { coverageOrgGapSubject } from '#shared/inbox/coverage-states'
import { fmtUsd, fmtUtcDay } from '../../composables/useFormat'

export interface InboxItem {
  id: string
  category: string
  severity: 'info' | 'attention' | 'urgent'
  subject: string
  body: Record<string, unknown>
  related_entity_kind: string | null
  related_entity_id: string | null
  /*
   * Server-resolved navigation target for the "Open project" affordance.
   * When related_entity_kind='project', this is the id of the project's
   * currently-effective baseline allocation. Null if no such allocation
   * exists or the related entity is not a project.
   */
  target_allocation_id: string | null
  /*
   * Server-resolved target for "Open project →": the project's code, emitted
   * only when this recipient can open /projects/{code}. Null otherwise.
   */
  target_project_code: string | null
  /*
   * The name the recipient gave the alert's device (#576), read live by the
   * server; only for the recipient's own device. Null when unnamed.
   */
  target_device_name?: string | null
  ack_state: 'unread' | 'read' | 'acknowledged' | 'dismissed' | 'resolved'
  ack_at: string | null
  created_at: string
}

export type DrawerBodyVariant =
  | 'over-budget'
  | 'nearly-used'
  | 'velocity'
  | 'sync-conflict'
  | 'personal-subscription'
  | 'over-emission'
  | 'project-request'
  | 'budget-request'
  /* #573: what happened / what it means / what to do, from drawer-copy.ts. */
  | 'sections'
  /* A category this build does not know (a newer server mid-deploy). */
  | 'unknown'

/*
 * Every kind the server writes has a body (#573): a bespoke one below, or the
 * sections table in drawer-copy.ts. Only a category this build does not know
 * falls to 'unknown', which says so; the old placeholder fallback that described
 * no alert at all is gone. tests/unit/components/inbox-drawer-copy.test.ts holds the line.
 */
export function variantForCategory(category: string): DrawerBodyVariant {
  switch (category) {
    case 'over-budget':
      return 'over-budget'
    case 'budget-nearly-used':
      return 'nearly-used'
    case 'velocity-warning':
      return 'velocity'
    case 'sync-conflict':
    case 'structural-conflict':
      return 'sync-conflict'
    case 'personal-subscription-prompt':
      return 'personal-subscription'
    case 'over-emission-escalated':
      return 'over-emission'
    case 'project-request':
    case 'project-request-decided':
      return 'project-request'
    case 'quota-request':
    case 'quota-request-decided':
      return 'budget-request'
    case 'project-ending-soon':
    case 'project-ended-retag':
    case 'untagged-backlog':
    case 'reconciliation-gap':
    case 'went-silent':
    case 'over-attribution':
    case 'connector-health':
    case 'read-path-stale':
    case 'joiner-selection-cap':
    case 'attribution-gap':
    case 'ops-alert':
    case 'github-coverage-gap':
    case 'copilot-bill-unsettled':
    case 'copilot-bill-unclassified':
      return 'sections'
    default:
      return 'unknown'
  }
}

/**
 * The title a person reads for an item. Most items show the subject the server
 * stored; an organisation's GitHub coverage alert is rebuilt from its own facts
 * with the shared wording, so one stored before a wording change (#587) reads
 * the current words, not "cost-owning-unit home" (#591).
 */
export function itemSubject(item: Pick<InboxItem, 'category' | 'subject' | 'body'>): string {
  if (item.category === 'github-coverage-gap' && item.body?.kind === 'org-gap') {
    const { org, enterpriseExternalId, state } = item.body
    if (typeof org === 'string' && typeof enterpriseExternalId === 'string' && typeof state === 'string') {
      return coverageOrgGapSubject(org, enterpriseExternalId, state)
    }
  }
  return item.subject
}

/** The words a person reads for a category: shared/inbox/categories.ts (#546). */
export { inboxCategoryLabel as categoryLabel, inboxCategoryBadge as categoryBadge } from '#shared/inbox/categories'

/*
 * How an item the WORKER closed ended (#630, #631), in the words the drawer and
 * the Closed list show. Null for an item a person closed, or one still open.
 *
 *   - 'period-ended': the alert's month or ISO week is over (plus 7 days'
 *     grace, server/notifications/period-close.ts). The server stamps the
 *     period it was about; both are UTC provider periods, so they are
 *     formatted in UTC and never converted.
 *   - 'budget-raised': a top-up raised the budget past the one the alert was
 *     raised against and the project is inside it (server/workers/budget-alert.ts).
 *     No date: the worker reads the budget as a sum, not the top-up's start.
 */
export function closedNote(item: Pick<InboxItem, 'ack_state' | 'body'>): string | null {
  if (item.ack_state !== 'resolved') return null
  const b = item.body ?? {}
  if (b.closed_reason === 'period-ended') {
    if (typeof b.closed_week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.closed_week_start)) {
      return `Closed automatically: the week of ${fmtUtcDay(b.closed_week_start, { year: true })} is over.`
    }
    if (typeof b.closed_month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(b.closed_month)) {
      const month = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(Date.parse(`${b.closed_month}-01T00:00:00Z`))
      return `Closed automatically: ${month} is over.`
    }
    return 'Closed automatically: the period it was about is over.'
  }
  if (b.closed_reason === 'budget-raised') {
    const cap = typeof b.closed_cap_usd === 'number' ? b.closed_cap_usd : Number(b.closed_cap_usd)
    return Number.isFinite(cap)
      ? `Closed automatically: the budget was raised to ${fmtUsd(cap, { whole: true })} and the project is inside it.`
      : 'Closed automatically: the budget was raised and the project is inside it.'
  }
  return null
}
