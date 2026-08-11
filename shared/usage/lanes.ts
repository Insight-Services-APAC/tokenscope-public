/*
 * lanes — the provider-agnostic vendor-lane registry.
 *
 * Each provider ships a surface ADAPTER declaring its lanes — an id, a display
 * label, and the emit `tool` values that resolve to that lane:
 *   - `shared/usage/surface.ts`        → the Anthropic adapter (Claude Code +
 *     the #142 non-Code Claude surfaces);
 *   - `shared/usage/github-surface.ts` → the GitHub adapter (Copilot).
 * The registry composes an ORDERED adapter list into the canonical lane order,
 * the tool→lane resolution, and the label map. `shared/usage/vendor.ts` derives
 * its unchanged #142 public surface (Vendor / VENDOR_LANES / VENDOR_LABELS /
 * toolToVendor / vendorCostSql) from this composition.
 *
 * The 'other' catch-all is deliberately NOT a lane here — it belongs to no
 * provider. vendor.ts appends it, keeping the Σ-conservation semantics
 * (nothing ever vanishes from a vendor total) owned by the JS/SQL mappers that
 * implement them.
 *
 * Pure TS with no imports, so it sits in `shared/` and is reachable from the
 * server rollups, the pollers, and the UI lane renderers alike.
 */

/** One vendor lane: its id, display label, and the emit `tool`s it owns. */
export interface LaneDef {
  readonly id: string
  readonly label: string
  /**
   * Emit `tool` values resolving to this lane. May be empty — a lane fed by
   * billing data rather than OTel emission (e.g. the pooled Copilot §B
   * chargeback lanes arriving with the D2 lane split) has no tool of its own.
   */
  readonly tools: readonly string[]
}

/** A provider's surface adapter — declare `as const satisfies` so lane ids stay literal. */
export interface ProviderSurfaceAdapter {
  /** Stable provider key ('anthropic' | 'github' today); diagnostics only. */
  readonly provider: string
  /** This provider's lanes, in canonical display order. */
  readonly lanes: readonly LaneDef[]
}

/**
 * The closed union of an adapter's lane ids. Adapters are declared as-const,
 * so this resolves to string LITERALS — vendor.ts composes its closed `Vendor`
 * union from it.
 */
export type AdapterLaneId<A extends ProviderSurfaceAdapter> = A['lanes'][number]['id']

/** The composition of an ordered adapter list (see {@link buildLaneRegistry}). */
export interface LaneRegistry<L extends string = string> {
  /** Full lane order: adapters in list order, each adapter's lanes in declared order. */
  readonly laneIds: readonly L[]
  /** Lane id → human-readable display label. */
  readonly labels: Readonly<Record<L, string>>
  /** Emit `tool` → owning lane id. Tools without an entry are no provider's. */
  readonly toolToLane: Readonly<Record<string, L>>
  /**
   * Lane id → the PROVIDER whose adapter declared it ('anthropic' | 'github').
   *
   * The composition already computes this to enforce lane-id uniqueness; it is
   * returned rather than discarded because "which provider's clock governs this
   * lane" is a real question (the teammate drill's staleness refusal asks it —
   * developer pages D36), and the alternative is every caller hand-coding
   * "copilot* means GitHub, everything else means Anthropic" — the drift the
   * registry exists to prevent.
   */
  readonly laneProvider: Readonly<Record<L, string>>
  /** Every tool with a dedicated lane, in lane order — feeds SQL `NOT IN` catch-alls. */
  readonly lanedTools: readonly string[]
}

/** Composition-time invariant violation — a misdeclared adapter, caught at import. */
const registryError = (message: string): Error =>
  Object.assign(new Error(`lane registry: ${message}`), { code: 'LANE_REGISTRY_INVALID' })

/**
 * Compose an ordered adapter list into a {@link LaneRegistry}.
 *
 * Invariants (throw at composition, i.e. module-import, time):
 *   - lane ids are unique across ALL adapters (a duplicate would merge two
 *     providers' money into one lane);
 *   - every emit `tool` is claimed by at most ONE lane (a tool claimed twice
 *     would double-count its spend in per-lane SQL splits).
 */
export function buildLaneRegistry<const A extends readonly ProviderSurfaceAdapter[]>(
  adapters: A,
): LaneRegistry<AdapterLaneId<A[number]>> {
  type L = AdapterLaneId<A[number]>
  const laneIds: L[] = []
  const labels: Record<string, string> = {}
  const toolToLane: Record<string, L> = {}
  const laneProvider: Record<string, string> = {}
  const toolLane: Record<string, string> = {}
  for (const adapter of adapters) {
    for (const lane of adapter.lanes) {
      // The interface widens ids to string; the generic recovers the literal union.
      const id = lane.id as L
      if (laneProvider[id] !== undefined) {
        throw registryError(
          `lane id '${id}' declared by both '${laneProvider[id]}' and '${adapter.provider}'`,
        )
      }
      laneProvider[id] = adapter.provider
      laneIds.push(id)
      labels[id] = lane.label
      for (const tool of lane.tools) {
        if (toolLane[tool] !== undefined) {
          throw registryError(`tool '${tool}' claimed by both lane '${toolLane[tool]}' and lane '${id}'`)
        }
        toolLane[tool] = id
        toolToLane[tool] = id
      }
    }
  }
  return {
    laneIds,
    labels: labels as Record<L, string>,
    toolToLane,
    laneProvider: laneProvider as Record<L, string>,
    lanedTools: Object.keys(toolToLane),
  }
}
