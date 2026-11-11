/*
 * Every inbox category, its words and its filter group (#546).
 *
 * The inbox used to filter on 7 of the categories the server writes and print
 * the rest as raw keys ("read-path-stale"). Every category the server can
 * write is listed here once: tests/unit/shared/inbox-categories.test.ts reads
 * server/notifications/dispatch.ts (the InboxCategory union, plus any
 * `'x' as InboxCategory` cast) and fails if one has no label or no group.
 *
 * Six groups people recognise; the list route filters on them (`group=`).
 */

export const INBOX_CATEGORY_GROUPS = [
  'budgets',
  'requests',
  'projects',
  'data-health',
  'copilot-billing',
  'other',
] as const
export type InboxCategoryGroup = (typeof INBOX_CATEGORY_GROUPS)[number]

export const INBOX_GROUP_LABELS: Record<InboxCategoryGroup, string> = {
  budgets: 'Budgets',
  requests: 'Requests',
  projects: 'Projects',
  'data-health': 'Data health',
  'copilot-billing': 'Copilot billing',
  other: 'Other',
}

/** Category key → what a person reads, and the group it filters under. */
export const INBOX_CATEGORY_INFO = {
  'over-budget': { label: 'Over budget', group: 'budgets' },
  'budget-nearly-used': { label: 'Budget nearly used', group: 'budgets' },
  'velocity-warning': { label: 'Spending fast', group: 'budgets' },
  'project-request': { label: 'Project request', group: 'requests' },
  'project-request-decided': { label: 'Project decision', group: 'requests' },
  'quota-request': { label: 'Budget request', group: 'requests' },
  'quota-request-decided': { label: 'Budget decision', group: 'requests' },
  'project-ending-soon': { label: 'Project ending soon', group: 'projects' },
  'project-ended-retag': { label: 'Project ended', group: 'projects' },
  'untagged-backlog': { label: 'Usage not recorded', group: 'data-health' },
  'sync-conflict': { label: 'Sync conflict', group: 'data-health' },
  'structural-conflict': { label: 'Structure conflict', group: 'data-health' },
  'over-attribution': { label: 'More usage than Anthropic reports', group: 'data-health' },
  'reconciliation-gap': { label: "Usage and Anthropic's figures disagree", group: 'data-health' },
  'connector-health': { label: 'Bill not placed', group: 'data-health' },
  'read-path-stale': { label: 'Usage reading stalled', group: 'data-health' },
  'joiner-selection-cap': { label: 'Too many devices to read', group: 'data-health' },
  'attribution-gap': { label: 'Device behind', group: 'data-health' },
  'went-silent': { label: 'Device cannot send usage', group: 'data-health' },
  'github-coverage-gap': { label: 'GitHub coverage lost', group: 'data-health' },
  'ops-alert': { label: 'Service alert', group: 'data-health' },
  'copilot-bill-unsettled': { label: 'Copilot bill not settled', group: 'copilot-billing' },
  'copilot-bill-unclassified': { label: 'Copilot spend unclassified', group: 'copilot-billing' },
  'personal-subscription-prompt': { label: 'Personal subscription', group: 'other' },
  'over-emission-escalated': { label: 'Usage not confirmed by provider', group: 'other' },
} as const satisfies Record<string, { label: string; group: InboxCategoryGroup }>

export type KnownInboxCategory = keyof typeof INBOX_CATEGORY_INFO
export const KNOWN_INBOX_CATEGORIES = Object.keys(INBOX_CATEGORY_INFO) as KnownInboxCategory[]

export function categoriesInGroup(group: InboxCategoryGroup): KnownInboxCategory[] {
  return KNOWN_INBOX_CATEGORIES.filter((c) => INBOX_CATEGORY_INFO[c].group === group)
}

function info(category: string): { label: string; group: InboxCategoryGroup } | null {
  return (INBOX_CATEGORY_INFO as Record<string, { label: string; group: InboxCategoryGroup }>)[category] ?? null
}

/** The kind, in words. An unknown category never prints its key. */
export function inboxCategoryLabel(category: string): string {
  return info(category)?.label ?? 'Notice'
}

/** The group a category filters under; anything unknown is Other. */
export function inboxCategoryGroup(category: string): InboxCategoryGroup {
  return info(category)?.group ?? 'other'
}

/** The badge: "Requests · Budget request". */
export function inboxCategoryBadge(category: string): string {
  return `${INBOX_GROUP_LABELS[inboxCategoryGroup(category)]} · ${inboxCategoryLabel(category)}`
}

/** What an item is about, in words; null for a kind with no plain name (an ops condition key). */
const ENTITY_LABELS: Record<string, string> = {
  project: 'Project',
  project_request: 'Project request',
  instance: 'Device',
  teammate: 'Teammate',
  'provider-org': 'Provider organisation',
  'provider-enterprise': 'Provider enterprise',
  'over-emission': 'Usage check',
  'read-path': 'Usage reading',
}
export function inboxEntityLabel(kind: string | null | undefined): string | null {
  return kind ? (ENTITY_LABELS[kind] ?? null) : null
}

/** An item's state, in words. */
export const INBOX_ACK_STATE_LABELS: Record<string, string> = {
  unread: 'Unread',
  read: 'Read',
  acknowledged: 'Acknowledged',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
}
export function inboxAckStateLabel(state: string): string {
  return INBOX_ACK_STATE_LABELS[state] ?? 'Open'
}
