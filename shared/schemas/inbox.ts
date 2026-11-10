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
})
export type InboxListQuery = z.infer<typeof InboxListQuery>

export const InboxPatchBody = z.object({
  ack_state: z.enum(INBOX_ACK_STATES),
})
export type InboxPatchBody = z.infer<typeof InboxPatchBody>

export const InboxRouteBody = z.object({
  recipient_teammate_id: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
})
export type InboxRouteBody = z.infer<typeof InboxRouteBody>
