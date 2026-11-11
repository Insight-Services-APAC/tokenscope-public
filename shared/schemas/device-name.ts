/*
 * Device names (#576): the rule for a name, and how a device reads with or
 * without one. One file, so the route, the rename field and every place a
 * device is shown agree.
 *
 * A name is DISPLAY ONLY and PERSONAL (see drizzle/migrations/0171): it is
 * never matched or attributed on, never on the telemetry wire, never in a
 * report or export. The 12-month soft purge clears it with the device's other
 * personal fields, and like them only once the device has ENDED (a device in
 * use keeps its identity columns). The owner can clear it at any time.
 */
import { z } from 'zod'
import { toolLabel } from '../usage/surface'
import { githubSurfaceAdapter } from '../usage/github-surface'

/** Characters, counted as Postgres counts them (code points), as in the 0171 CHECK. */
export const DEVICE_NAME_MAX = 40

/*
 * An allowlist of Unicode categories: letters, combining marks (a decomposed
 * "é", Indic vowel signs), numbers, punctuation, spaces and symbols from any
 * script. Control and format characters (where bidi overrides and zero-width
 * tricks live) are refused, so a name cannot disguise itself as another
 * device in a list.
 */
const SAFE = /^[\p{L}\p{M}\p{N}\p{P}\p{Zs}\p{S}]*$/u

export function codePointLength(s: string): number {
  return [...s].length
}

/**
 * The PATCH body. `name` is trimmed; an empty or all-space name, or null,
 * CLEARS the name (the device reads as its tool and short id again).
 */
export const DeviceRenameBody = z.object({
  name: z
    .string()
    .nullable()
    .transform((v) => {
      const t = (v ?? '').trim()
      return t === '' ? null : t
    })
    .refine((v) => v === null || codePointLength(v) <= DEVICE_NAME_MAX, {
      message: `A device name is at most ${DEVICE_NAME_MAX} characters`,
    })
    .refine((v) => v === null || SAFE.test(v), {
      message: 'A device name cannot contain control or formatting characters',
    }),
})
export type DeviceRenameBody = z.infer<typeof DeviceRenameBody>

const GITHUB_TOOL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  githubSurfaceAdapter.lanes.flatMap((l) => l.tools.map((t) => [t, l.label])),
)

/** The client's product name, as app/composables/useFormat.ts clientMeta names it. */
export function deviceToolName(tool: string): string {
  return GITHUB_TOOL_LABELS[tool] ?? toolLabel(tool)
}

/** The tool and the first eight characters of the id: how an unnamed device reads. */
export function deviceFallbackLabel(tool: string | null | undefined, instanceId: string): string {
  const id = instanceId.slice(0, 8)
  return tool ? `${deviceToolName(tool)} · ${id}` : id
}

/**
 * How a device reads to its owner: its name when it has one, else the tool and
 * short id. Never blank.
 */
export function deviceLabel(d: {
  instance_id: string
  tool?: string | null
  display_name?: string | null
}): string {
  const name = d.display_name?.trim()
  return name ? name : deviceFallbackLabel(d.tool, d.instance_id)
}

/**
 * The five device states (#592), decided on the server in
 * server/utils/instance-projection.ts. Their words live here so My account,
 * Home and Admin Devices say the same thing.
 */
export const INSTANCE_STATES = ['sending', 'idle', 'not-in-use', 'cannot-send', 'revoked'] as const
export type InstanceState = (typeof INSTANCE_STATES)[number]

export const INSTANCE_STATE_LABEL: Record<InstanceState, string> = {
  sending: 'Sending',
  idle: 'Idle',
  'not-in-use': 'Not in use',
  'cannot-send': 'Cannot send',
  revoked: 'Revoked',
}

/** The badge colour per state. Only Cannot send is amber: only it is a fault. */
export const INSTANCE_STATE_BADGE: Record<InstanceState, 'rag-green' | 'neutral' | 'rag-amber' | 'hunger'> = {
  sending: 'rag-green',
  idle: 'neutral',
  'not-in-use': 'neutral',
  'cannot-send': 'rag-amber',
  revoked: 'hunger',
}
