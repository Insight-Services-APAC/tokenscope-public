/*
 * surface — the single definition of how an Anthropic Enterprise Analytics
 * `product` value maps to a TokenScope `tool` lane (#142: per-surface
 * cost-centre chargeback for non-Code surfaces).
 *
 * The product enum below is the DOCUMENTED set on the Enterprise Analytics
 * user_usage_report / user_cost_report (platform.claude.com/docs/en/api/admin/
 * analytics, verified live 2026-07-14). There is NO `api`/console value on this
 * lane — Console API spend arrives via the separate Admin Usage & Cost API, not
 * the Enterprise Analytics poll. The enum is treated as OPEN: any value we
 * don't recognise (including the API's own `other` and `null` on rows it
 * cannot attribute to a surface) lands in the labelled `claude-other` bucket —
 * logged by the poller, NEVER silently dropped or re-collapsed into
 * `claude-code`.
 *
 * Non-Code surfaces are §B (chargeback) ONLY — they are excluded from the §A
 * needs-tagging reconciliation (migration 0084 derives its exclusion list from
 * NON_CODE_CLAUDE_TOOLS; a unit test pins the two together, since SQL views
 * cannot import TS).
 *
 * Pure TS with no runtime imports (the lanes import is type-only), so it sits
 * in `shared/` and is reachable from the server poller, the rollup SQL
 * builders, and the UI lane renderers alike.
 */
import type { ProviderSurfaceAdapter } from './lanes'
import { COPILOT_AGENT_TOOL } from './github-surface'

export const CLAUDE_CODE_TOOL = 'claude-code'

/** The labelled fallback lane for unknown / unattributable products. */
export const CLAUDE_OTHER_TOOL = 'claude-other'

/*
 * Documented `product` → tool. `claude_in_slack` (underscores) is the retiring
 * v1 Slack bot; `claude-in-slack` (hyphens) is Claude Tag — both are the Slack
 * surface, one lane.
 */
const PRODUCT_TO_TOOL: Readonly<Record<string, string>> = {
  claude_code: CLAUDE_CODE_TOOL,
  chat: 'claude-ai',
  cowork: 'claude-cowork',
  office_agent: 'claude-office',
  claude_in_chrome: 'claude-chrome',
  claude_design: 'claude-design',
  'claude-in-slack': 'claude-slack',
  claude_in_slack: 'claude-slack',
}

/**
 * Map an Enterprise Analytics `product` to its tool lane. Unknown values
 * (including the API's own `other`) and null/undefined → {@link CLAUDE_OTHER_TOOL}.
 * Callers that care about drift (the poller) should report unmapped values —
 * this function stays pure and total.
 */
export function mapProductToTool(product: string | null | undefined): string {
  if (!product) return CLAUDE_OTHER_TOOL
  return PRODUCT_TO_TOOL[product] ?? CLAUDE_OTHER_TOOL
}

/** True when `product` maps to a named lane (i.e. NOT the claude-other fallback). */
export function isKnownProduct(product: string | null | undefined): boolean {
  return Boolean(product && PRODUCT_TO_TOOL[product])
}

/*
 * The non-Code Claude surface lanes — chargeback-only (§B). These are excluded
 * from the §A needs-tagging reconciliation (v_teammate_usage_daily, mig 0084)
 * and rendered read-only (no Tag affordance) on the developer my-usage page.
 * Order here is the canonical display order for UI lane rendering.
 */
export const NON_CODE_CLAUDE_TOOLS = [
  'claude-ai',
  'claude-cowork',
  'claude-office',
  'claude-chrome',
  'claude-design',
  'claude-slack',
  CLAUDE_OTHER_TOOL,
] as const

export type NonCodeClaudeTool = (typeof NON_CODE_CLAUDE_TOOLS)[number]

/*
 * Every tool lane the Anthropic Enterprise Analytics poll can write — the
 * poller's stale-row cleanup (analytics-poller.ts) scopes its DELETE to exactly
 * this set so no other source's rows are ever touched.
 */
export const CLAUDE_FAMILY_TOOLS: readonly string[] = [CLAUDE_CODE_TOOL, ...NON_CODE_CLAUDE_TOOLS]

/*
 * INGEST_ONLY_USAGE_TOOLS (Workstream A, migration 0101) — the provider-neutral
 * generalisation of what was `GITHUB_INGEST_ONLY_USAGE_TOOLS`
 * (shared/usage/github-surface.ts, now superseded and removed): every tool
 * whose usage truth is genuine §A provider usage but which can NEVER become a
 * taggable `unaccounted_usage` worklist item, because no session/OTel
 * emission exists for it to tag.
 *
 * `reconcileUnaccountedUsage` (server/usage/unaccounted-reconciliation.ts)
 * excludes exactly this set from the needs-tagging reconciliation — the
 * non-Code Claude surfaces (#142, no sessions, no OTel — restored to
 * `v_teammate_usage_daily` by migration 0101's A1) and `copilot-agent` (D4,
 * OTel-invisible coding-agent lane, migration 0086). `v_complete_usage`'s
 * third, non-taggable union arm (migration 0101, A3) reads exactly this set
 * FROM `v_teammate_usage_daily`, so ingest-only usage is §A-visible
 * (showback/velocity) while staying permanently absent from the worklist.
 *
 * `copilot-cli` is deliberately NOT a member: it remains ordinarily taggable
 * (an enrolled container's un-reconciled gap is genuine developer-taggable
 * usage), just as it always has been.
 */
export const INGEST_ONLY_USAGE_TOOLS: readonly string[] = [COPILOT_AGENT_TOOL, ...NON_CODE_CLAUDE_TOOLS]

/** True when `tool` is a non-Code Claude surface lane (chargeback-only, untaggable). */
export function isNonCodeClaudeTool(tool: string | null | undefined): tool is NonCodeClaudeTool {
  return Boolean(tool && (NON_CODE_CLAUDE_TOOLS as readonly string[]).includes(tool))
}

/** Human-readable lane names for UI rendering (finance, practice, my-usage). */
export const CLAUDE_TOOL_LABELS: Readonly<Record<string, string>> = {
  [CLAUDE_CODE_TOOL]: 'Claude Code',
  'claude-ai': 'Claude Chat',
  'claude-cowork': 'Claude Cowork',
  'claude-office': 'Claude Office Agents',
  'claude-chrome': 'Claude in Chrome',
  'claude-design': 'Claude Design',
  'claude-slack': 'Claude in Slack',
  [CLAUDE_OTHER_TOOL]: 'Claude (other)',
}

/** Display label for any tool lane; falls back to the raw tool string. */
export function toolLabel(tool: string): string {
  return CLAUDE_TOOL_LABELS[tool] ?? tool
}

/*
 * The Anthropic provider adapter for the shared/usage/lanes.ts registry — a
 * thin wrapper over the constants above, which all KEEP their names and
 * exports (the migration-0084 pin test and the #142 consumers import them
 * directly). The 'claude' lane is Claude CODE; every non-Code surface is its
 * own lane with lane id == tool id (#142 owner decision), in the canonical
 * NON_CODE_CLAUDE_TOOLS display order.
 */
export const claudeSurfaceAdapter = {
  provider: 'anthropic',
  lanes: [
    { id: 'claude', label: 'Claude Code', tools: [CLAUDE_CODE_TOOL] },
    ...NON_CODE_CLAUDE_TOOLS.map((t) => ({ id: t, label: CLAUDE_TOOL_LABELS[t] ?? t, tools: [t] as const })),
  ],
} as const satisfies ProviderSurfaceAdapter
