/*
 * Connect-flow shared types and the per-deployment connection config (#415).
 *
 * The connect dialog used to bake one deployment's marketplace and plugin names
 * into the component. They now come from `GET /api/v1/connect/config`, which reads
 * the admin "Client connection" policy (mig 0151) and falls back to
 * DEFAULT_CLIENT_CONNECTION when no row exists. The defaults are today's values, so
 * a deployment with no row renders exactly what it rendered before.
 *
 * Validation lives here so the admin PUT and the page agree on what is accepted.
 * Every value except the support link ends up inside a command the user pastes
 * into a terminal or a Claude session, so those formats are deliberately narrow:
 * no whitespace and no shell metacharacters, `%` included (cmd.exe expands
 * %NAME% even inside quotes). The support link is only ever an https link.
 */
import { z } from 'zod'

/** The CLI clients TokenScope can be connected to. */
export const CONNECT_CLIENTS = ['claude-code', 'copilot-cli'] as const
export type ConnectClient = (typeof CONNECT_CLIENTS)[number]

/**
 * The server each DEFAULT plugin build ships with. The dialog compares this
 * deployment's origin with it to decide whether the user must point the plugin
 * at this server. `scripts/check-copilot-plugin-sync.mjs` fails if either
 * drifts from what the plugins package.
 *
 * Claude: the `server_url` option's default in `plugin/.claude-plugin/plugin.json`
 * (its `.mcp.json` is the `${user_config.server_url}` template, #415). EMPTY in
 * the public snapshot (tools/publish/substitutions.txt): that build ships
 * without a server, so every user sets one.
 *
 * Copilot: the literal host in `copilot-plugin/.mcp.json`. The public snapshot
 * rewrites it to a placeholder host, which is still the host that build names.
 */
export const CLAUDE_PLUGIN_DEFAULT_ORIGIN = ''
export const COPILOT_PLUGIN_BUNDLED_ORIGIN = 'https://tokenscope.example.com'

export interface ClientConnectionPolicy {
  /** `owner/repo` on GitHub, or an `https://` git clone URL. */
  marketplaceSource: string
  /** Optional branch or tag to pin (Claude Code `#ref`). */
  marketplaceRef: string | null
  /** The `name` in the marketplace's `.claude-plugin/marketplace.json`. */
  marketplaceName: string
  claudePlugin: string
  copilotPlugin: string
  enabledClients: ConnectClient[]
  /** Where a stuck user goes for help; https only. */
  supportUrl: string | null
}

export const DEFAULT_CLIENT_CONNECTION: ClientConnectionPolicy = {
  marketplaceSource: 'Insight-Services-APAC/tokenscope-public',
  marketplaceRef: null,
  marketplaceName: 'tokenscope',
  claudePlugin: 'tokenscope',
  copilotPlugin: 'tokenscope-copilot',
  enabledClients: ['claude-code', 'copilot-cli'],
  supportUrl: null,
}

/** `originMissingReason` when the deployment cannot vouch for its origin. Shown to users as-is. */
export const ORIGIN_NOT_PINNED_REASON =
  "This TokenScope site doesn't know its own web address yet, so it can't show where to connect. Ask your administrator to set appPublicOrigin on the deployment."

/** What `GET /api/v1/connect/config` returns. */
export interface ConnectConfig extends ClientConnectionPolicy {
  /** This deployment's public origin, or null when it cannot vouch for one. */
  origin: string | null
  /** Why `origin` is null; null when it is set. */
  originMissingReason: string | null
  /** `${origin}/api/v1/mcp`, or null with origin. */
  mcpUrl: string | null
  /** CLAUDE_PLUGIN_DEFAULT_ORIGIN; '' when the Claude plugin ships without a server. */
  claudeBundledOrigin: string
  /** COPILOT_PLUGIN_BUNDLED_ORIGIN, shipped so the client never hardcodes it. */
  copilotBundledOrigin: string
}

// ── Formats ─────────────────────────────────────────────────────────────────

/** GitHub `owner/repo`. Owner per GitHub's rules; repo excludes `.` and `..`. */
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
/**
 * An https git URL with a plain path: no userinfo, query, fragment or any
 * character a shell would interpret, so no percent-encoding either. A fragment
 * would also collide with the `#ref` suffix Claude Code uses for pinning.
 * Mirrored by the marketplace_source CHECK (mig 0153).
 */
const HTTPS_GIT_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)+\/?$/
/** A git ref without `..`, a leading `-` or `/`, or a trailing `/` or `.lock`. */
const GIT_REF = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,128}$/
export const PLUGIN_NAME = /^[a-z0-9-]{1,64}$/

export function isValidMarketplaceSource(s: string): boolean {
  return s.length <= 512 && (OWNER_REPO.test(s) || HTTPS_GIT_URL.test(s))
}

const SupportUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s"'`$\\<>]+$/, 'support link must be an https:// URL')
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:'
    } catch {
      return false
    }
  }, 'support link must be an https:// URL')

/** Admin PUT body. snake_case on the wire, like the other admin policy routes. */
export const ClientConnectionBody = z
  .object({
    marketplace_source: z
      .string()
      .trim()
      .refine(isValidMarketplaceSource, 'marketplace source must be owner/repo or an https:// git URL'),
    marketplace_ref: z
      .union([z.string().regex(GIT_REF, 'ref must be a branch or tag name'), z.literal(''), z.null()])
      .optional()
      .transform((v) => v || null),
    marketplace_name: z.string().regex(PLUGIN_NAME, 'marketplace name must match [a-z0-9-]{1,64}'),
    claude_plugin: z.string().regex(PLUGIN_NAME, 'plugin name must match [a-z0-9-]{1,64}'),
    copilot_plugin: z.string().regex(PLUGIN_NAME, 'plugin name must match [a-z0-9-]{1,64}'),
    enabled_clients: z
      .array(z.enum(CONNECT_CLIENTS))
      .min(1, 'enable at least one client')
      .transform((v) => CONNECT_CLIENTS.filter((c) => v.includes(c))),
    support_url: z
      .union([SupportUrl, z.literal(''), z.null()])
      .optional()
      .transform((v) => v || null),
  })
  .strict()

export type ClientConnectionBodyInput = z.input<typeof ClientConnectionBody>

// ── Commands the dialog shows ─────────────────────────────────────────────────

/** The `marketplace add` argument for Claude Code, with `#ref` when pinned. */
export function claudeMarketplaceArg(p: Pick<ClientConnectionPolicy, 'marketplaceSource' | 'marketplaceRef'>): string {
  return p.marketplaceRef ? `${p.marketplaceSource}#${p.marketplaceRef}` : p.marketplaceSource
}

/** The server the default build of `client`'s plugin ships with; '' for none. */
export function bundledOriginFor(
  c: Pick<ConnectConfig, 'claudeBundledOrigin' | 'copilotBundledOrigin'>,
  client: ConnectClient,
): string {
  return client === 'claude-code' ? c.claudeBundledOrigin : c.copilotBundledOrigin
}

/**
 * Does the user have to point `client`'s plugin at this server themselves?
 * Always when the plugin ships without a server (the public Claude build).
 * Otherwise only when this deployment's origin is known and differs from the
 * plugin's; a null origin is reported separately, since guessing one is worse.
 */
export function needsMcpRegistration(
  c: Pick<ConnectConfig, 'origin' | 'claudeBundledOrigin' | 'copilotBundledOrigin'>,
  client: ConnectClient,
): boolean {
  const bundled = bundledOriginFor(c, client)
  return bundled === '' || (c.origin !== null && c.origin !== bundled)
}
