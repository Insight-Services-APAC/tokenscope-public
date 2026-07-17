/*
 * shared/usage/surface — the single product→tool mapping for the #142
 * per-surface chargeback split.
 *
 * Pins:
 *   - every DOCUMENTED Enterprise Analytics `product` maps to its named lane
 *     (incl. BOTH Slack spellings — hyphenated Claude Tag and the retiring
 *     underscore v1 bot — onto ONE claude-slack lane);
 *   - the enum is OPEN: unknown values, the API's own 'other', and null /
 *     undefined all land in the labelled claude-other lane (never dropped,
 *     never re-collapsed into claude-code);
 *   - every lane the poller can write has a human-readable label;
 *   - THE DRIFT GUARD: migration 0084's NOT IN exclusion list (a SQL view
 *     cannot import TS) is parsed from disk and pinned to equal
 *     ['copilot-cli', ...NON_CODE_CLAUDE_TOOLS] exactly. If either side moves
 *     without the other, this test fails CI.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  mapProductToTool,
  isKnownProduct,
  isNonCodeClaudeTool,
  toolLabel,
  CLAUDE_CODE_TOOL,
  CLAUDE_OTHER_TOOL,
  NON_CODE_CLAUDE_TOOLS,
  CLAUDE_FAMILY_TOOLS,
  CLAUDE_TOOL_LABELS,
} from '../../../shared/usage/surface'
import { GITHUB_USAGE_TOOLS } from '../../../shared/usage/github-surface'

/* The documented product enum (platform.claude.com/docs/en/api/admin/analytics,
 * verified 2026-07-14) and the lane each maps to. */
const DOCUMENTED: Array<[product: string, tool: string]> = [
  ['claude_code', 'claude-code'],
  ['chat', 'claude-ai'],
  ['cowork', 'claude-cowork'],
  ['office_agent', 'claude-office'],
  ['claude_in_chrome', 'claude-chrome'],
  ['claude_design', 'claude-design'],
  ['claude-in-slack', 'claude-slack'], // Claude Tag (hyphens)
  ['claude_in_slack', 'claude-slack'], // legacy v1 Slack bot (underscores)
]

describe('mapProductToTool', () => {
  it.each(DOCUMENTED)('documented product %s → %s', (product, tool) => {
    expect(mapProductToTool(product)).toBe(tool)
  })

  it('BOTH Slack spellings collapse onto the ONE claude-slack lane', () => {
    expect(mapProductToTool('claude-in-slack')).toBe('claude-slack')
    expect(mapProductToTool('claude_in_slack')).toBe('claude-slack')
  })

  it("the API's own 'other' bucket → claude-other (a labelled lane, not a drop)", () => {
    expect(mapProductToTool('other')).toBe(CLAUDE_OTHER_TOOL)
  })

  it('an unknown / future product → claude-other (open enum, never re-collapsed)', () => {
    expect(mapProductToTool('weird_new_surface')).toBe(CLAUDE_OTHER_TOOL)
    // Made-up fixture values from older tests fall through by design too.
    expect(mapProductToTool('claude_api')).toBe(CLAUDE_OTHER_TOOL)
    expect(mapProductToTool('copilot')).toBe(CLAUDE_OTHER_TOOL)
  })

  it('null / undefined / empty product → claude-other (total function, no throw)', () => {
    expect(mapProductToTool(null)).toBe(CLAUDE_OTHER_TOOL)
    expect(mapProductToTool(undefined)).toBe(CLAUDE_OTHER_TOOL)
    expect(mapProductToTool('')).toBe(CLAUDE_OTHER_TOOL)
  })

  it('is case-sensitive — the wire enum is lowercase, a cased variant is UNKNOWN', () => {
    expect(mapProductToTool('Chat')).toBe(CLAUDE_OTHER_TOOL)
    expect(mapProductToTool('CLAUDE_CODE')).toBe(CLAUDE_OTHER_TOOL)
  })
})

describe('isKnownProduct', () => {
  it.each(DOCUMENTED.map(([p]) => p))('%s is known', (product) => {
    expect(isKnownProduct(product)).toBe(true)
  })

  it("'other', unknown, null and undefined are NOT known (the poller reports them)", () => {
    expect(isKnownProduct('other')).toBe(false)
    expect(isKnownProduct('weird_new_surface')).toBe(false)
    expect(isKnownProduct(null)).toBe(false)
    expect(isKnownProduct(undefined)).toBe(false)
    expect(isKnownProduct('')).toBe(false)
  })
})

describe('lane sets', () => {
  it('CLAUDE_FAMILY_TOOLS = claude-code + every non-Code lane (the prune scope)', () => {
    expect(CLAUDE_FAMILY_TOOLS).toEqual([CLAUDE_CODE_TOOL, ...NON_CODE_CLAUDE_TOOLS])
  })

  it('NON_CODE_CLAUDE_TOOLS covers every non-Code mapping target + the fallback, no dupes', () => {
    const targets = new Set(DOCUMENTED.map(([, t]) => t).filter((t) => t !== CLAUDE_CODE_TOOL))
    targets.add(CLAUDE_OTHER_TOOL)
    expect(new Set(NON_CODE_CLAUDE_TOOLS)).toEqual(targets)
    expect(new Set(NON_CODE_CLAUDE_TOOLS).size).toBe(NON_CODE_CLAUDE_TOOLS.length)
  })

  it('every product maps INTO the claude family (nothing can escape the prune scope)', () => {
    for (const [product] of DOCUMENTED) {
      expect(CLAUDE_FAMILY_TOOLS).toContain(mapProductToTool(product))
    }
    expect(CLAUDE_FAMILY_TOOLS).toContain(mapProductToTool('anything-else'))
  })

  it('isNonCodeClaudeTool: true for every non-Code lane, false for claude-code / copilot-cli / null', () => {
    for (const tool of NON_CODE_CLAUDE_TOOLS) expect(isNonCodeClaudeTool(tool)).toBe(true)
    expect(isNonCodeClaudeTool(CLAUDE_CODE_TOOL)).toBe(false)
    expect(isNonCodeClaudeTool('copilot-cli')).toBe(false)
    expect(isNonCodeClaudeTool(null)).toBe(false)
    expect(isNonCodeClaudeTool(undefined)).toBe(false)
  })
})

describe('labels', () => {
  it('every claude-family lane has a human-readable label', () => {
    for (const tool of CLAUDE_FAMILY_TOOLS) {
      const label = CLAUDE_TOOL_LABELS[tool]
      expect(label, `missing label for lane ${tool}`).toBeTruthy()
      expect(label).not.toBe(tool) // a real display name, not the raw id
    }
  })

  it('toolLabel falls back to the raw tool string for unlabelled lanes', () => {
    expect(toolLabel(CLAUDE_CODE_TOOL)).toBe('Claude Code')
    expect(toolLabel('claude-ai')).toBe('Claude Chat')
    expect(toolLabel('copilot-cli')).toBe('copilot-cli')
  })
})

describe('migration 0084 pin (the TS↔SQL drift guard)', () => {
  const MIGRATION = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'drizzle',
    'migrations',
    '0084_teammate_usage_daily_exclude_noncode_surfaces.sql',
  )

  it("the view's a.tool NOT IN list == ['copilot-cli', ...NON_CODE_CLAUDE_TOOLS] EXACTLY", () => {
    const raw = readFileSync(MIGRATION, 'utf8')
    // Strip SQL line comments FIRST — the list is annotated inline and a comment
    // may contain parens/quotes that would confuse the extraction below.
    const stripped = raw.replace(/--[^\n]*/g, '')
    const clause = stripped.match(/a\.tool\s+NOT\s+IN\s*\(([^)]*)\)/)
    expect(clause, 'migration 0084 must carry an `a.tool NOT IN (...)` exclusion').not.toBeNull()
    const literals = [...clause![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    // Exact list AND order: copilot-cli (the pre-existing exclusion) first, then
    // the non-Code Claude lanes in their canonical surface.ts order.
    expect(literals).toEqual(['copilot-cli', ...NON_CODE_CLAUDE_TOOLS])
  })

  it('the exclusion appears in the actual_spend branch of v_teammate_usage_daily', () => {
    const raw = readFileSync(MIGRATION, 'utf8')
    expect(raw).toContain('CREATE VIEW v_teammate_usage_daily')
    expect(raw).toContain('FROM actual_spend a')
  })
})

/*
 * Migration 0086 supersedes 0084's view definition (D4 copilot usage-lane
 * split) — pin the DEPLOYED definition's exclusion list too. The Claude list
 * is unchanged; the delta is 'copilot-agent' joining 'copilot-cli' (both
 * copilot usage tools source from reconciliation_record — GITHUB_USAGE_TOOLS
 * in shared/usage/github-surface.ts — so neither may ever double-count from
 * actual_spend).
 */
describe('migration 0086 pin (the TS↔SQL drift guard, deployed view)', () => {
  const MIGRATION = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'drizzle',
    'migrations',
    '0086_teammate_usage_daily_copilot_agent_lane.sql',
  )

  it("the view's a.tool NOT IN list == [...GITHUB_USAGE_TOOLS, ...NON_CODE_CLAUDE_TOOLS] EXACTLY", () => {
    const raw = readFileSync(MIGRATION, 'utf8')
    const stripped = raw.replace(/--[^\n]*/g, '')
    const clause = stripped.match(/a\.tool\s+NOT\s+IN\s*\(([^)]*)\)/)
    expect(clause, 'migration 0086 must carry an `a.tool NOT IN (...)` exclusion').not.toBeNull()
    const literals = [...clause![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(literals).toEqual([...GITHUB_USAGE_TOOLS, ...NON_CODE_CLAUDE_TOOLS])
  })

  it('the copilot branch lanes by category: coding agent → copilot-agent, default → copilot-cli', () => {
    const raw = readFileSync(MIGRATION, 'utf8')
    expect(raw).toContain('CREATE OR REPLACE VIEW v_teammate_usage_daily')
    expect(raw).toMatch(
      /CASE WHEN r\.category = 'copilot_coding_agent' THEN 'copilot-agent' ELSE 'copilot-cli' END/,
    )
  })
})
