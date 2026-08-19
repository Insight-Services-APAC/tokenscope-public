/*
 * shared/usage/vendor — the tool→vendor-lane mapping and the per-lane SQL
 * cost-split, extended by #142 so every non-Code Claude surface is its OWN lane.
 *
 * The money invariant under test: the JS mapper (toolToVendor), the lane list
 * (VENDOR_LANES), and the SQL bucketing (vendorCostSql) can never disagree —
 * in particular the 'other' catch-all's NOT IN predicate must name EVERY laned
 * tool, so no tool's spend can vanish from (or double into) a vendor total.
 *
 * SQL fragments are rendered through drizzle's PgDialect (no DB needed): the
 * assertions read the parameterised text + bound params, not drizzle internals.
 */
import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  toolToVendor,
  chargeToVendor,
  vendorCostSql,
  VENDOR_LANES,
  VENDOR_LABELS,
  type Vendor,
} from '../../../shared/usage/vendor'
import { NON_CODE_CLAUDE_TOOLS, CLAUDE_CODE_TOOL } from '../../../shared/usage/surface'
import { GITHUB_ALL_CHARGEBACK_LANES } from '../../../shared/usage/github-surface'

const render = (q: SQL): { sql: string; params: unknown[] } => new PgDialect().sqlToQuery(q)

/* Every tool with a dedicated lane, and the lane it belongs to. */
const LANED: Array<[tool: string, lane: Vendor]> = [
  [CLAUDE_CODE_TOOL, 'claude'],
  ['copilot-cli', 'copilot'],
  // The Copilot App harness shares the 'copilot' lane — provider_usage_fact only,
  // so the lane sums two tools (see COPILOT_APP_TOOL).
  ['copilot-app', 'copilot'],
  // D4 usage-lane split: the coding-agent DISPLAY lane (lane id == the
  // view-emitted tool literal, mig 0086 — never an OTel emission).
  ['copilot-agent', 'copilot-agent'],
  ...NON_CODE_CLAUDE_TOOLS.map((t): [string, Vendor] => [t, t]),
]

describe('toolToVendor', () => {
  it.each(LANED)('%s → its %s lane', (tool, lane) => {
    expect(toolToVendor(tool)).toBe(lane)
  })

  it('every non-Code Claude surface maps to ITSELF (lane id == tool id)', () => {
    for (const tool of NON_CODE_CLAUDE_TOOLS) expect(toolToVendor(tool)).toBe(tool)
  })

  it('unknown tools and NULL (reconciliation deltas) → the other catch-all', () => {
    expect(toolToVendor('some-future-tool')).toBe('other')
    expect(toolToVendor('')).toBe('other')
    expect(toolToVendor(null)).toBe('other')
  })
})

describe('VENDOR_LANES / VENDOR_LABELS', () => {
  it('covers every toolToVendor target + the billing-fed §B chargeback lanes + the other catch-all, no dupes', () => {
    const targets = new Set<Vendor>(LANED.map(([, lane]) => lane))
    // The §B Copilot chargeback lanes are billing-fed (no OTel tool → never a
    // toolToVendor target) yet are first-class vendor lanes (D2 lane split).
    for (const lane of GITHUB_ALL_CHARGEBACK_LANES) targets.add(lane)
    targets.add('other')
    expect(new Set(VENDOR_LANES)).toEqual(targets)
    expect(new Set(VENDOR_LANES).size).toBe(VENDOR_LANES.length)
  })

  it('orders claude (Code) first and other last (canonical UI order)', () => {
    expect(VENDOR_LANES[0]).toBe('claude')
    expect(VENDOR_LANES[VENDOR_LANES.length - 1]).toBe('other')
  })

  it('every lane has a human-readable label', () => {
    for (const lane of VENDOR_LANES) {
      expect(VENDOR_LABELS[lane], `missing label for lane ${lane}`).toBeTruthy()
    }
    expect(VENDOR_LABELS.claude).toBe('Claude Code') // 'claude' means Claude CODE
  })
})

describe('vendorCostSql', () => {
  it('returns one expression per lane — every VENDOR_LANES key present', () => {
    const lanes = vendorCostSql()
    expect(new Set(Object.keys(lanes))).toEqual(new Set(VENDOR_LANES))
  })

  it.each(LANED)('the %s filter sums its lane over exactly that lane\'s tools', (tool, lane) => {
    const q = render(vendorCostSql()[lane])
    const laneTools = LANED.filter(([, l]) => l === lane).map(([t]) => t)
    // A one-tool lane keeps the `=` form; a multi-tool lane must widen to IN, or
    // all but one of its tools vanish from the split while still footing.
    expect(q.sql).toContain(
      laneTools.length === 1
        ? 'COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.tool ='
        : 'COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.tool IN (',
    )
    expect(new Set(q.params)).toEqual(new Set(laneTools))
    expect(q.params).toContain(tool)
  })

  it("the 'other' catch-all is NOT IN (EVERY laned tool) OR IS NULL — nothing can vanish", () => {
    const q = render(vendorCostSql().other)
    expect(q.sql).toContain('NOT IN')
    expect(q.sql).toContain('IS NULL')
    // Every tool with a dedicated lane must be bound into the NOT IN list; a
    // missing one would DOUBLE-count that tool (own lane + other).
    expect(new Set(q.params)).toEqual(new Set(LANED.map(([tool]) => tool)))
    expect(q.params).toHaveLength(LANED.length)
  })

  it('derives the tool column from the cost column qualifier (es.cost_usd → es.tool)', () => {
    const lanes = vendorCostSql('es.cost_usd')
    const claude = render(lanes.claude)
    expect(claude.sql).toContain('SUM(es.cost_usd)')
    expect(claude.sql).toContain('es.tool')
    const other = render(lanes.other)
    expect(other.sql).toContain('es.tool NOT IN')
  })

  it('an unqualified cost column filters on a bare tool column', () => {
    const claude = render(vendorCostSql('cost_usd').claude)
    expect(claude.sql).toContain('SUM(cost_usd)')
    expect(claude.sql).toContain('(WHERE tool =')
  })

  it('billing-fed §B lanes (no tool) are a constant 0 — and stay OUT of the other catch-all list', () => {
    const lanes = vendorCostSql()
    for (const lane of GITHUB_ALL_CHARGEBACK_LANES) {
      expect(render(lanes[lane]).sql.trim()).toBe('0')
    }
    // Their lane ids never enter the NOT IN list (they are not tools) — the
    // catch-all still names exactly the laned tools.
    const other = render(lanes.other)
    expect(new Set(other.params)).toEqual(new Set(LANED.map(([tool]) => tool)))
  })
})

describe('chargeToVendor (v_finance_chargeback_month rows)', () => {
  it('passes the §B chargeback lane ids straight through (the copilot arm emits lane ids)', () => {
    for (const lane of GITHUB_ALL_CHARGEBACK_LANES) expect(chargeToVendor(lane)).toBe(lane)
  })

  it.each(LANED)('resolves the raw tool %s like toolToVendor (%s)', (tool, lane) => {
    expect(chargeToVendor(tool)).toBe(lane)
  })

  it('unknown values and NULL fall to the other catch-all', () => {
    expect(chargeToVendor('some-future-tool')).toBe('other')
    expect(chargeToVendor('')).toBe('other')
    expect(chargeToVendor(null)).toBe('other')
  })
})
