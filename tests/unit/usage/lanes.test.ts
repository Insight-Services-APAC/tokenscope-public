/*
 * shared/usage/lanes — the provider-agnostic lane registry (commit 1 of the
 * copilot-surface-lanes design: a strictly BEHAVIOR-PRESERVING inversion of
 * vendor.ts into per-provider adapters).
 *
 * Pins:
 *   - registry composition ORDER: adapters in list order, each adapter's lanes
 *     in declared order — the canonical UI lane order derives from it;
 *   - registry invariants: a lane id declared by two adapters throws, and a
 *     tool claimed by two lanes throws (a double-claimed tool would
 *     DOUBLE-COUNT its spend in the per-lane SQL splits);
 *   - THE REFACTOR GUARD: VENDOR_LANES / VENDOR_LABELS / toolToVendor are
 *     pinned to the LITERAL pre-refactor #142 values (not re-derived from the
 *     adapters — hardcoded, so any drift introduced by the registry inversion
 *     fails here even if vendor.test.ts's derived expectations drift with it).
 */
import { describe, it, expect } from 'vitest'
import { buildLaneRegistry, type ProviderSurfaceAdapter } from '../../../shared/usage/lanes'
import { claudeSurfaceAdapter, NON_CODE_CLAUDE_TOOLS } from '../../../shared/usage/surface'
import {
  githubSurfaceAdapter,
  GITHUB_LANES,
  GITHUB_USAGE_TOOLS,
  GITHUB_FIREWALL_EXCLUSIONS,
} from '../../../shared/usage/github-surface'
import { toolToVendor, VENDOR_LANES, VENDOR_LABELS } from '../../../shared/usage/vendor'

describe('buildLaneRegistry composition', () => {
  const a: ProviderSurfaceAdapter = {
    provider: 'alpha',
    lanes: [
      { id: 'a1', label: 'A one', tools: ['tool-a1'] },
      { id: 'a2', label: 'A two', tools: ['tool-a2', 'tool-a2-alias'] },
    ],
  }
  const b: ProviderSurfaceAdapter = {
    provider: 'beta',
    lanes: [{ id: 'b1', label: 'B one', tools: ['tool-b1'] }],
  }

  it('preserves adapter list order, then per-adapter lane declaration order', () => {
    expect(buildLaneRegistry([a, b]).laneIds).toEqual(['a1', 'a2', 'b1'])
    expect(buildLaneRegistry([b, a]).laneIds).toEqual(['b1', 'a1', 'a2'])
  })

  it('collects labels and tool→lane resolution across adapters', () => {
    const reg = buildLaneRegistry([a, b])
    expect(reg.labels).toEqual({ a1: 'A one', a2: 'A two', b1: 'B one' })
    expect(reg.toolToLane).toEqual({
      'tool-a1': 'a1',
      'tool-a2': 'a2',
      'tool-a2-alias': 'a2',
      'tool-b1': 'b1',
    })
    expect(reg.lanedTools).toEqual(['tool-a1', 'tool-a2', 'tool-a2-alias', 'tool-b1'])
  })

  it('THROWS when two adapters declare the same lane id', () => {
    const clash: ProviderSurfaceAdapter = {
      provider: 'gamma',
      lanes: [{ id: 'a1', label: 'impostor', tools: [] }],
    }
    expect(() => buildLaneRegistry([a, clash])).toThrowError(/lane id 'a1'.*'alpha'.*'gamma'/)
  })

  it('THROWS when a tool is claimed by two lanes — across providers', () => {
    const clash: ProviderSurfaceAdapter = {
      provider: 'gamma',
      lanes: [{ id: 'g1', label: 'G one', tools: ['tool-a2'] }],
    }
    expect(() => buildLaneRegistry([a, clash])).toThrowError(/tool 'tool-a2'.*'a2'.*'g1'/)
  })

  it('THROWS when a tool is claimed by two lanes — within one adapter', () => {
    const selfClash: ProviderSurfaceAdapter = {
      provider: 'gamma',
      lanes: [
        { id: 'g1', label: 'G one', tools: ['dup'] },
        { id: 'g2', label: 'G two', tools: ['dup'] },
      ],
    }
    expect(() => buildLaneRegistry([selfClash])).toThrowError(/tool 'dup'/)
  })

  it('registry errors carry a stable .code', () => {
    const clash: ProviderSurfaceAdapter = {
      provider: 'gamma',
      lanes: [{ id: 'a1', label: 'impostor', tools: [] }],
    }
    try {
      buildLaneRegistry([a, clash])
      expect.unreachable('must throw')
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('LANE_REGISTRY_INVALID')
    }
  })
})

describe('the real adapters', () => {
  it('no tool is claimed twice across the shipped providers (registry invariant holds)', () => {
    // Composition throws on a double-claim, so merely building it is the assertion.
    const reg = buildLaneRegistry([claudeSurfaceAdapter, githubSurfaceAdapter])
    expect(reg.lanedTools).toHaveLength(new Set(reg.lanedTools).size)
  })

  it("claude adapter: 'claude' lane wraps claude-code; each non-Code surface is its own lane", () => {
    expect(claudeSurfaceAdapter.provider).toBe('anthropic')
    expect(claudeSurfaceAdapter.lanes[0]).toEqual({ id: 'claude', label: 'Claude Code', tools: ['claude-code'] })
    expect(claudeSurfaceAdapter.lanes.slice(1).map((l) => l.id)).toEqual([...NON_CODE_CLAUDE_TOOLS])
    for (const lane of claudeSurfaceAdapter.lanes.slice(1)) expect(lane.tools).toEqual([lane.id])
  })

  it("github adapter: the 'copilot' + 'copilot-agent' usage lanes own their tools; the three §B chargeback lanes are billing-fed (no tools)", () => {
    expect(githubSurfaceAdapter.provider).toBe('github')
    expect(githubSurfaceAdapter.lanes).toEqual([
      { id: 'copilot', label: 'Copilot', tools: ['copilot-cli'] },
      // D4 §A usage-lane split: the coding-agent DISPLAY lane, right after the
      // interactive usage lane and before the §B chargeback lanes.
      { id: 'copilot-agent', label: 'Copilot Coding Agent', tools: ['copilot-agent'] },
      { id: 'copilot-license', label: 'Copilot License', tools: [] },
      { id: 'copilot-usage', label: 'Copilot Usage', tools: [] },
      { id: 'copilot-unclassified', label: 'Copilot (unclassified)', tools: [] },
    ])
  })

  it('GITHUB_FIREWALL_EXCLUSIONS = every lane id ∪ every §A usage tool, deduped — the ONE §B Anthropic-arm exclusion set (r1 finding 1)', () => {
    // Exact contents, pinned: the five lane ids + the copilot-cli tool literal
    // ('copilot-agent' is both a lane id and its tool literal — deduped once).
    expect(GITHUB_FIREWALL_EXCLUSIONS).toEqual([
      'copilot',
      'copilot-agent',
      'copilot-license',
      'copilot-usage',
      'copilot-unclassified',
      'copilot-cli',
    ])
    // Derivation invariants: covers BOTH source sets, nothing else, no dupes.
    const set = new Set(GITHUB_FIREWALL_EXCLUSIONS)
    expect(set.size).toBe(GITHUB_FIREWALL_EXCLUSIONS.length)
    for (const id of [...GITHUB_LANES, ...GITHUB_USAGE_TOOLS]) expect(set.has(id)).toBe(true)
    expect(set.size).toBe(new Set([...GITHUB_LANES, ...GITHUB_USAGE_TOOLS]).size)
  })
})

/*
 * The commit-1 refactor guard, extended by the D2 lane split (commit 2) and the
 * D4 usage-lane split (commit 3): the ONLY intentional deltas from the
 * pre-registry #142 surface are the three §B Copilot chargeback lanes plus the
 * 'copilot-agent' §A usage lane, inserted after 'copilot' and before 'other'.
 * Everything else stays byte-identical — still hardcoded literals, so drift
 * fails here even if vendor.test.ts's derived expectations drift with it.
 */
describe('lane-surface guard — #142 values + the three §B chargeback lanes + the D4 copilot-agent usage lane', () => {
  it('VENDOR_LANES: the exact canonical array, in order', () => {
    expect(VENDOR_LANES).toEqual([
      'claude',
      'claude-ai',
      'claude-cowork',
      'claude-office',
      'claude-chrome',
      'claude-design',
      'claude-slack',
      'claude-other',
      'copilot',
      'copilot-agent',
      'copilot-license',
      'copilot-usage',
      'copilot-unclassified',
      'other',
    ])
  })

  it('VENDOR_LABELS: the exact canonical labels', () => {
    expect(VENDOR_LABELS).toEqual({
      claude: 'Claude Code',
      'claude-ai': 'Claude Chat',
      'claude-cowork': 'Claude Cowork',
      'claude-office': 'Claude Office Agents',
      'claude-chrome': 'Claude in Chrome',
      'claude-design': 'Claude Design',
      'claude-slack': 'Claude in Slack',
      'claude-other': 'Claude (other)',
      copilot: 'Copilot',
      'copilot-agent': 'Copilot Coding Agent',
      'copilot-license': 'Copilot License',
      'copilot-usage': 'Copilot Usage',
      'copilot-unclassified': 'Copilot (unclassified)',
      other: 'Other',
    })
  })

  it('toolToVendor: the exact pre-refactor mapping, incl. the catch-all', () => {
    expect(toolToVendor('claude-code')).toBe('claude')
    expect(toolToVendor('copilot-cli')).toBe('copilot')
    // D4: the coding-agent lane id == its view-emitted tool literal.
    expect(toolToVendor('copilot-agent')).toBe('copilot-agent')
    expect(toolToVendor('claude-ai')).toBe('claude-ai')
    expect(toolToVendor('claude-cowork')).toBe('claude-cowork')
    expect(toolToVendor('claude-office')).toBe('claude-office')
    expect(toolToVendor('claude-chrome')).toBe('claude-chrome')
    expect(toolToVendor('claude-design')).toBe('claude-design')
    expect(toolToVendor('claude-slack')).toBe('claude-slack')
    expect(toolToVendor('claude-other')).toBe('claude-other')
    expect(toolToVendor('some-future-tool')).toBe('other')
    expect(toolToVendor('')).toBe('other')
    expect(toolToVendor(null)).toBe('other')
  })
})
