// @vitest-environment happy-dom
/*
 * RegionalSignals — THE DRILL CONTRACT on the velocity signals strip (D29/D34).
 *
 * ── THE DEFECT THESE PIN (r5-H1) ────────────────────────────────────────────
 * This strip names people. It carried `isActive` and NOTHING ELSE, so
 * `isProvisional` fell back to the client helper's permissive default and every
 * conjunct passed for a PROVISIONAL SHADOW — an ACTIVE teammate minted by the
 * unauthenticated enrol path, whose email is a claim nobody has verified (mig
 * 0057). The strip therefore published a victim's email as a live link, on a
 * manager-facing governance surface, onto a page that 403s.
 *
 * MUTATION (either half of the fix): drop `isProvisional` from `targetFor` in
 * `app/components/reporting/regional/RegionalSignals.vue`, or drop
 * `${TEAMMATE_DRILL_FACTS}` from `fetchRegionalExceptions` — the shadow row goes
 * back to `drill-link` and the first test below fails.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RegionalSignals from '../../../app/components/reporting/regional/RegionalSignals.vue'
import type { DrillGrants } from '../../../app/components/reporting/drill-contract'

const GRANTED: DrillGrants = { teammate: 'people-scope', project: 'member-in-scope' }
const FRAME = { src: 'region:r1', month: '2026-07' }

const stubs = {
  UiCard: { template: '<section><slot /></section>' },
  UiBadge: { template: '<span><slot /></span>' },
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
}

interface Ex {
  teammateId: string
  name: string
  currentWeekUsd: number
  baselineMeanUsd: number
  deltaPct: number
  isActive?: boolean
  isProvisional?: boolean
}

const ex = (o: Partial<Ex> & { teammateId: string; name: string }): Ex => ({
  currentWeekUsd: 400,
  baselineMeanUsd: 100,
  deltaPct: 3,
  isActive: true,
  isProvisional: false,
  ...o,
})

const mountStrip = (exceptions: Ex[]) =>
  mount(RegionalSignals, {
    props: { exceptions, velocityThreshold: 0.25, drillGrants: GRANTED, drillFrame: FRAME },
    global: { stubs },
  })

/** The rendered state of one row's name: a door, or a name. */
const stateOf = (w: ReturnType<typeof mountStrip>, name: string): 'link' | 'plain' => {
  const row = w
    .findAll('[data-testid="regional-signal-row"]')
    .find((r) => r.text().includes(name))!
  expect(row, `no signal row for ${name}`).toBeTruthy()
  return row.find('[data-testid="drill-link"]').exists() ? 'link' : 'plain'
}

describe('RegionalSignals — link or plain text BY GRANT, never a dead name', () => {
  it('a PROVISIONAL shadow is named but is NOT a door (r5-H1)', () => {
    const w = mountStrip([
      ex({ teammateId: 't-real', name: 'Real Person' }),
      ex({ teammateId: 't-shadow', name: 'victim@corp.example', isProvisional: true }),
    ])
    // The signal itself survives — this strip is a callout, not a decomposition,
    // so suppressing the row would unreport a real spike.
    expect(w.text()).toContain('victim@corp.example')
    // ...but the unconfirmed identity opens nothing.
    expect(stateOf(w, 'victim@corp.example')).toBe('plain')
    // The confirmed one still does, so this is not a blanket close.
    expect(stateOf(w, 'Real Person')).toBe('link')
  })

  it('a DEACTIVATED subject is not a door either — the other conjunct still holds', () => {
    const w = mountStrip([ex({ teammateId: 't-gone', name: 'Left Last Month', isActive: false })])
    expect(stateOf(w, 'Left Last Month')).toBe('plain')
  })

  it('an OLD payload with neither fact fails CLOSED, not open', () => {
    /*
     * A cached body or a stale client predates the wire fields. `undefined`
     * must read as "not proven active", never as "not provisional" — the
     * asymmetry is the whole reason both reads are `=== true`.
     */
    const w = mountStrip([
      { teammateId: 't-old', name: 'Legacy Row', currentWeekUsd: 400, baselineMeanUsd: 100, deltaPct: 3 },
    ])
    expect(stateOf(w, 'Legacy Row')).toBe('plain')
  })

  it('with NO frame, nothing is a door — a link with no `src` is a bare teammate id', () => {
    const w = mount(RegionalSignals, {
      props: {
        exceptions: [ex({ teammateId: 't-real', name: 'Real Person' })],
        velocityThreshold: 0.25,
        drillGrants: GRANTED,
        drillFrame: { src: null },
      },
      global: { stubs },
    })
    expect(stateOf(w, 'Real Person')).toBe('plain')
  })
})
