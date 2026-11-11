import { z } from 'zod'
import {
  INBOX_CATEGORY_GROUPS,
  KNOWN_INBOX_CATEGORIES,
  type KnownInboxCategory,
} from '../inbox/categories'

// Every category the server writes (shared/inbox/categories.ts is the one list,
// checked against server/notifications/dispatch.ts by its test, #546).
export const INBOX_CATEGORIES = KNOWN_INBOX_CATEGORIES as [KnownInboxCategory, ...KnownInboxCategory[]]

export const INBOX_SEVERITIES = ['info', 'attention', 'urgent'] as const

export const INBOX_ACK_STATES = ['unread', 'read', 'acknowledged', 'dismissed', 'resolved'] as const

export const InboxListQuery = z.object({
  ack_state: z
    .enum(['unread', 'read', 'acknowledged', 'dismissed', 'resolved', 'open', 'closed'])
    .optional(),
  category: z.enum(INBOX_CATEGORIES).optional(),
  /** One of the six filter groups; ANDed with `category` when both are given. */
  group: z.enum(INBOX_CATEGORY_GROUPS).optional(),
  severity: z.enum(INBOX_SEVERITIES).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  /** `next_cursor` from the previous page (#569); opaque to the client. */
  cursor: z.string().max(80).optional(),
})
export type InboxListQuery = z.infer<typeof InboxListQuery>

export const InboxPatchBody = z.object({
  ack_state: z.enum(INBOX_ACK_STATES),
})
export type InboxPatchBody = z.infer<typeof InboxPatchBody>

/*
 * POST /api/v1/me/inbox/bulk (#574). Two shapes:
 *   - `ids`: the rows ticked on the page, with the action bar's state.
 *   - `all_unread`: "Mark all read" — every UNREAD item matching the page's
 *     category/group/severity, including the ones past the loaded pages.
 * Only the caller's own items are ever touched; anything else is reported back
 * as not changed.
 */
export const INBOX_BULK_STATES = ['read', 'resolved', 'dismissed'] as const
export const INBOX_BULK_MAX_IDS = 200
export const InboxBulkIdsBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(INBOX_BULK_MAX_IDS),
  ack_state: z.enum(INBOX_BULK_STATES),
}).strict()
export const InboxBulkAllUnreadBody = z.object({
  all_unread: z.object({
    category: z.enum(INBOX_CATEGORIES).optional(),
    group: z.enum(INBOX_CATEGORY_GROUPS).optional(),
    severity: z.enum(INBOX_SEVERITIES).optional(),
  }).strict(),
  ack_state: z.literal('read'),
}).strict()
export const InboxBulkBody = z.union([InboxBulkIdsBody, InboxBulkAllUnreadBody])
export type InboxBulkBody = z.infer<typeof InboxBulkBody>

export const InboxRouteBody = z.object({
  recipient_teammate_id: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
})
export type InboxRouteBody = z.infer<typeof InboxRouteBody>
