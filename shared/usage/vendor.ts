/*
 * vendor — the single definition of how an emit `tool` maps to a billing VENDOR
 * lane and the SQL that splits a cost column over those lanes. Both the JS
 * mapper and the SQL FILTER fragments had been copied inline across the rollups
 * (practice/[ouId], org-tree); a drift in the `NOT IN (...) OR IS NULL` "other"
 * predicate silently drops spend from the vendor total, so it lives here once.
 *
 * The lane DATA is composed from the per-provider adapters through the
 * shared/usage/lanes.ts registry — shared/usage/surface.ts (Anthropic: Claude
 * Code + every #142 non-Code surface as its OWN lane, ids == tool ids) and
 * shared/usage/github-surface.ts (GitHub: Copilot). The public surface here is
 * UNCHANGED from #142: 'claude' stays the Claude Code lane, 'copilot' the
 * Copilot lane, and 'other' remains the catch-all (unknown tools, NULL from
 * reconciliation deltas) so NOTHING ever vanishes from a vendor total.
 *
 * Pure TS (only drizzle's `sql` tag — not a server-only import), so it sits in
 * `shared/` and is reachable from both the server rollups and any client code.
 */
import { sql, type SQL } from 'drizzle-orm'
import { buildLaneRegistry, type AdapterLaneId } from './lanes'
import { claudeSurfaceAdapter, CLAUDE_CODE_TOOL } from './surface'
import { githubSurfaceAdapter, COPILOT_CLI_TOOL, COPILOT_AGENT_TOOL } from './github-surface'

/*
 * The composed registry: Anthropic first (Claude Code, then the non-Code
 * surfaces in their surface.ts display order), then GitHub (Copilot). The
 * 'other' catch-all belongs to no provider and is appended below.
 */
const REGISTRY = buildLaneRegistry([claudeSurfaceAdapter, githubSurfaceAdapter])

/* Closed literal union — composed from the adapters' as-const lane ids. */
export type Vendor =
  | AdapterLaneId<typeof claudeSurfaceAdapter>
  | AdapterLaneId<typeof githubSurfaceAdapter>
  | 'other'

/*
 * Canonical lane order for UI rendering: Claude Code first (the primary
 * engineering lane), then the non-Code Claude surfaces in their surface.ts
 * display order, then Copilot (the §A usage lane), then the three §B Copilot
 * chargeback lanes (billing-fed, no OTel tool — github-surface.ts), then the
 * catch-all.
 */
export const VENDOR_LANES: readonly Vendor[] = [...REGISTRY.laneIds, 'other']

/**
 * Lane id → the PROVIDER whose adapter declared it. The 'other' catch-all
 * belongs to NO provider (it absorbs unknown tools and NULLs), so it maps to
 * null rather than being quietly attributed to one.
 *
 * Consumed by the teammate drill's staleness refusal (developer pages D36),
 * which must decide WHICH provider clocks are relevant to a subject's rows.
 */
export function vendorProvider(lane: Vendor): string | null {
  return lane === 'other' ? null : (REGISTRY.laneProvider[lane] ?? null)
}

/** Human-readable lane names (UI). The 'claude' lane means Claude CODE. */
export const VENDOR_LABELS: Readonly<Record<Vendor, string>> = {
  ...REGISTRY.labels,
  other: 'Other',
}

/*
 * The THREE named §A usage-lane tool literals (the "three-lane §A ceiling",
 * lane-visuals design V1): every §A split/trend builder — SQL FILTERs and JS
 * series alike — binds its named buckets on exactly this trio, with the live
 * 'other' catch-all (`NOT IN (...) OR IS NULL`) absorbing everything else so
 * nothing ever vanishes from a §A total. Composed from the adapters' canonical
 * constants — never hand literals (copilot-surface-lanes checklist).
 */
export const SECTION_A_USAGE_TOOLS = [
  CLAUDE_CODE_TOOL,
  COPILOT_CLI_TOOL,
  COPILOT_AGENT_TOOL,
] as const

/* Tools with a DEDICATED lane — everything else falls to 'other'. An explicit map
 * (not string surgery) so the SQL catch-all and the JS mapper cannot disagree. */
const TOOL_TO_LANE: Readonly<Record<string, Vendor>> = REGISTRY.toolToLane
const LANED_TOOLS: readonly string[] = REGISTRY.lanedTools

/**
 * Map an emit `tool` to its vendor lane: `claude-code` → claude, `copilot-cli`
 * → copilot, a non-Code Claude surface (#142) → its own lane, anything else
 * (incl. NULL from a reconciliation delta) → other. Mirrors the SQL bucketing
 * in {@link vendorCostSql} exactly.
 */
export function toolToVendor(tool: string | null): Vendor {
  return (tool && TOOL_TO_LANE[tool]) || 'other'
}

/* Lane id → itself. The §B chargeback views (mig 0085) emit LANE IDS in `tool` for
 * the billing-fed lanes, while the Anthropic arm emits raw tool ids. */
const LANE_SELF: Readonly<Record<string, Vendor>> = Object.fromEntries(
  VENDOR_LANES.map((lane) => [lane, lane]),
)

/**
 * Map a chargeback-view `tool` value to its vendor lane: a lane id (the
 * billing-fed §B lanes) passes through; anything else resolves like
 * {@link toolToVendor} (raw tools → their lane, unknown/NULL → 'other').
 * Use THIS — not toolToVendor — over `v_finance_chargeback_month` rows, or
 * the Copilot chargeback lanes silently land in 'other'.
 */
export function chargeToVendor(value: string | null): Vendor {
  return (value && (LANE_SELF[value] ?? TOOL_TO_LANE[value])) || 'other'
}

/**
 * SQL list fragment (`'a', 'b', …` as bound params) over lane/tool ids — the
 * building block for registry-driven `tool IN (...)` / `NOT IN (...)`
 * predicates in the §B reporting SQL (never hand literals; copilot-surface-lanes
 * checklist).
 */
export function laneListSql(lanes: readonly string[]): SQL {
  return sql.join(
    lanes.map((l) => sql`${l}`),
    sql.raw(', '),
  )
}

/**
 * Per-vendor cost-split expressions over `costCol` — one
 * `COALESCE(SUM(...) FILTER (WHERE tool = ...), 0)` per lane, keyed by lane id.
 * `costCol` and the derived `tool` column reference are code constants (never
 * user input) — `costCol` defaults to `ar.cost_usd` and the tool column is
 * taken from its table qualifier (e.g. `es.cost_usd` → `es.tool`). The `other`
 * lane uses `NOT IN (every laned tool) OR IS NULL` so NOTHING vanishes from
 * the vendor total.
 */
export function vendorCostSql(costCol = 'ar.cost_usd'): Record<Vendor, SQL> {
  // Derive the sibling `tool` column from the cost column's table qualifier so a
  // caller passing `es.cost_usd` filters on `es.tool`, not a hard-coded `ar.tool`.
  const qualifier = costCol.includes('.') ? costCol.slice(0, costCol.lastIndexOf('.') + 1) : ''
  const cost = sql.raw(costCol)
  const tool = sql.raw(`${qualifier}tool`)
  // Group by lane FIRST: keying off TOOL_TO_LANE let the last tool of a multi-tool
  // lane overwrite the rest, which then vanished from the split while still footing.
  const toolsByLane = new Map<Vendor, string[]>()
  for (const [toolId, lane] of Object.entries(TOOL_TO_LANE)) {
    const bucket = toolsByLane.get(lane)
    if (bucket) bucket.push(toolId)
    else toolsByLane.set(lane, [toolId])
  }
  const lanes = Object.fromEntries(
    [...toolsByLane].map(([lane, tools]) => [
      lane,
      sql`COALESCE(SUM(${cost}) FILTER (WHERE ${
        tools.length === 1
          ? sql`${tool} = ${tools[0]!}`
          : sql`${tool} IN (${sql.join(
              tools.map((t) => sql`${t}`),
              sql.raw(', '),
            )})`
      }), 0)`,
    ]),
  ) as Record<Vendor, SQL>
  const lanedList = sql.join(
    LANED_TOOLS.map((t) => sql`${t}`),
    sql.raw(', '),
  )
  lanes.other = sql`COALESCE(SUM(${cost}) FILTER (WHERE ${tool} NOT IN (${lanedList}) OR ${tool} IS NULL), 0)`
  // Billing-fed lanes (the §B Copilot chargeback lanes) own no tool, so a
  // tool-keyed cost split over them is structurally $0 — a constant keeps the
  // Record complete for every VENDOR_LANES key without touching the catch-all
  // (their lane ids never appear in a `tool` column outside the chargeback
  // views, so nothing can vanish into or out of 'other' here).
  for (const lane of VENDOR_LANES) {
    if (!(lane in lanes)) lanes[lane] = sql`0`
  }
  return lanes
}
