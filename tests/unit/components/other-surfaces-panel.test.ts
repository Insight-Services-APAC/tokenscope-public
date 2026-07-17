// @vitest-environment happy-dom
/*
 * HomeOtherSurfacesPanel — the read-only "Other Claude surfaces" panel (#142),
 * now with the lane-visuals V5 multi-lane mode (r1-F8): ONE compact stacked
 * per-day bar + per-surface share-of-total ONLY when ≥ 2 lanes each hold ≥ 5%
 * of the period total; below the threshold the existing per-surface rows render
 * UNCHANGED. Read-only affordances unchanged in both modes (no Tag button).
 * The no-hysteresis residual is accepted + named in the component (r2-4).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import OtherSurfacesPanel, { type SurfaceRow } from '../../../app/components/home/OtherSurfacesPanel.vue'

const global = {
  stubs: {
    UiCard: { template: '<div><slot /></div>' },
  },
}

function surface(tool: string, label: string, mtd: number, days: Array<[string, number]>): SurfaceRow {
  return { tool, label, mtd_usd: String(mtd), days: days.map(([day, usd]) => ({ day, usd: String(usd) })) }
}

// A CLOSED month so the padded day axis is deterministic (31 May days).
const MONTH = '2026-05'

describe('HomeOtherSurfacesPanel — the r1-F8 multi-lane threshold', () => {
  it('BELOW threshold (one dominant lane): per-surface rows UNCHANGED — sparklines, no stack, no shares', () => {
    const w = mount(OtherSurfacesPanel, {
      props: {
        monthToDate: MONTH,
        surfaces: [
          surface('claude-ai', 'Claude Chat', 96, [['2026-05-02', 96]]),
          surface('claude-slack', 'Claude in Slack', 4, [['2026-05-03', 4]]),
        ],
      },
      global,
    })
    expect(w.find('[data-testid="other-surfaces-stack"]').exists()).toBe(false)
    expect(w.find('[data-testid="surface-claude-ai-share"]').exists()).toBe(false)
    // The existing per-row mini-bar idiom (own-scale spark) still renders.
    expect(w.find('[data-testid="surface-claude-ai"] [role="img"]').exists()).toBe(true)
    expect(w.find('[data-testid="other-surfaces-total"]').text()).toContain('$100.00')
  })

  it('AT/ABOVE threshold (≥2 lanes ≥5%): ONE stacked per-day bar + per-row share-of-total, sparklines retired', () => {
    const w = mount(OtherSurfacesPanel, {
      props: {
        monthToDate: MONTH,
        surfaces: [
          // 95 / 5 — the second lane sits EXACTLY on the 5% boundary (inclusive).
          surface('claude-ai', 'Claude Chat', 95, [['2026-05-02', 60], ['2026-05-03', 35]]),
          surface('claude-slack', 'Claude in Slack', 5, [['2026-05-02', 5]]),
        ],
      },
      global,
    })
    const stack = w.find('[data-testid="other-surfaces-stack"]')
    expect(stack.exists()).toBe(true)
    // Shared padded axis: one column per May day (31), tooltips itemise per surface.
    const cols = stack.findAll('[title]')
    expect(cols.length).toBe(31)
    const may2 = cols.find((c) => c.attributes('title')!.startsWith('2026-05-02'))!
    expect(may2.attributes('title')).toContain('Claude Chat $60.00')
    expect(may2.attributes('title')).toContain('Claude in Slack $5.00')
    // Rows carry share-of-total instead of a second own-scale spark.
    expect(w.find('[data-testid="surface-claude-ai-share"]').text()).toContain('95%')
    expect(w.find('[data-testid="surface-claude-slack-share"]').text()).toContain('5%')
    expect(w.find('[data-testid="surface-claude-ai"] [role="img"]').exists()).toBe(false)
    // Exact $ stays on every row (identity never colour-alone).
    expect(w.find('[data-testid="surface-claude-ai-mtd"]').text()).toContain('$95.00')
  })

  it('stays read-only in BOTH modes — no Tag affordance anywhere', () => {
    for (const surfaces of [
      [surface('claude-ai', 'Claude Chat', 100, [['2026-05-02', 100] as [string, number]])],
      [
        surface('claude-ai', 'Claude Chat', 50, [['2026-05-02', 50]]),
        surface('claude-slack', 'Claude in Slack', 50, [['2026-05-03', 50]]),
      ],
    ]) {
      const w = mount(OtherSurfacesPanel, { props: { monthToDate: MONTH, surfaces }, global })
      // No interactive affordance at all (the copy legitimately SAYS "nothing to
      // tag" — the read-only guarantee is the absence of buttons/links).
      expect(w.findAll('button').length).toBe(0)
      expect(w.findAll('a').length).toBe(0)
    }
  })
})
