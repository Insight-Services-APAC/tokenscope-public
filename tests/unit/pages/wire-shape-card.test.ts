/*
 * The "Provider wire shape" CARD invariants (app/pages/admin/diagnostics.vue).
 *
 * SOURCE-LEVEL, for the same reason as tests/unit/pages/unhomed-causes-panel.test.ts:
 * what is protected here is not what one fixture renders but properties of the
 * card that must hold on code paths no fixture reaches. Every baseline checked in
 * today is 'schema-derived', so a mount test literally cannot exercise the
 * live-capture wording — and that branch is exactly the one that was wrong.
 *
 * The class of defect these guard against is this codebase's most common: copy
 * that asserts something the data does not support.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const SRC = readFileSync(resolve(ROOT, 'app/pages/admin/diagnostics.vue'), 'utf8')
const TEMPLATE = SRC.slice(SRC.indexOf('<template>'))
const SCRIPT = SRC.slice(0, SRC.indexOf('<template>'))

/** The wire-shape card only, so a match elsewhere on this large page cannot stand in for one here. */
const CARD_START = TEMPLATE.indexOf('data-testid="admin-diag-wire-shape"')
const CARD = TEMPLATE.slice(CARD_START, TEMPLATE.indexOf('</UiCard>', CARD_START))

/** The body of `wireDriftBadge`. */
const BADGE_FN = (() => {
  const start = SCRIPT.indexOf('function wireDriftBadge')
  expect(start).toBeGreaterThan(-1)
  return SCRIPT.slice(start, SCRIPT.indexOf('\n}', start))
})()

describe('wireDriftBadge names what was actually compared against', () => {
  it('derives the wording from the baseline provenance', () => {
    // A baseline is 'schema-derived' (what our Zod assumes) OR 'live-capture'
    // (what a previous run observed). "differs from schema" is simply false for
    // the second, and the type has always allowed it.
    expect(BADGE_FN).toContain('provenance')
    expect(BADGE_FN).toContain('live-capture')
  })

  it('never hardcodes the comparison target in a label', () => {
    // The mutation this exists to catch: a literal 'matches schema' /
    // 'differs from schema' string, which cannot be right for both provenances.
    expect(BADGE_FN).not.toMatch(/'(matches|differs from) schema'/)
    expect(BADGE_FN).not.toMatch(/"(matches|differs from) schema"/)
  })
})

describe('the card states what it cannot see', () => {
  it('renders the unobservable-subtree note', () => {
    // The stored scan reads PARSED payloads. Where the schema strips, an empty
    // "undeclared" list is evidence about our parser and nothing else — so the
    // card has to say so rather than let silence read as absence.
    expect(CARD).toContain('s.unobservable')
    expect(CARD).toContain('Not observable in this mode')
  })

  it('renders absent-but-optional paths separately from drift', () => {
    expect(CARD).toContain('s.drift?.absentOptional')
    expect(CARD).toContain('Optional in our schema and absent here')
  })

  it('shows which rows a stored scan actually read', () => {
    expect(CARD).toContain('s.scan.filter')
  })

  it('renders the unfiltered counts, so a zero-row scan is readable', () => {
    // rowsScanned: 0 is at least three different facts — nothing written, a
    // different enterprise_ref, or the other credential mode's payload shape —
    // and they need opposite responses. Reporting the counts on the server and
    // not rendering them would leave the operator exactly where they were.
    // The BINDING, not merely a mention: the field names appear in the block body
    // too, so asserting those alone stays green when the block is switched off.
    expect(CARD).toContain('v-if="s.scan?.unfiltered"')
    expect(CARD).toContain('rowsForProvider')
    expect(CARD).toContain('rowsForEnterprise')
  })

  it('renders the two-step read bound the same way it renders the stored row cap', () => {
    // The GitHub App surface reads ONE of N links and caps the lines it parses.
    // A silent cap reads as "we looked at everything".
    expect(CARD).toContain('v-if="s.fetchBound"')
    expect(CARD).toContain('linksAvailable')
    expect(CARD).toContain('linesCapped')
  })
})
