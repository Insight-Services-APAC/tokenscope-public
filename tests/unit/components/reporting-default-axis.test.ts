// @vitest-environment node
/*
 * THE DEFAULT DRILL AXIS IS THE PROJECT, ON EVERY SCOPE.
 *
 * `docs/design/reporting-stakeholder-visibility/00-decisions.md` D1: reporting is
 * organised around projects and budgets, and person-level detail is a spot-check —
 * reachable, audited, never a default view. The default axis is what decides which
 * of those a role sees FIRST, and it is a one-line ref in each Scope container, so
 * it is also the single easiest thing in the reporting area to revert by accident.
 *
 * Asserted at SOURCE level because the containers are the Nuxt-runtime half of
 * each scope (useFetch, auto-imported composables) and cannot be mounted without
 * one — the same reason `reports-lane-firewall` and `project-spend-one-lane` are
 * source-level. What is checked is the value the axis initialises to and the value
 * any drill-entry reset restores it to: a reset that still says 'teammate' would
 * put the person view back the moment a user drilled, which is precisely the
 * behaviour being removed.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * The three Scope CONTAINERS that own a drivers-table axis.
 *
 * `resets` is part of the contract, not an observation: a container that resets
 * the axis on drill entry/exit must have EXACTLY ONE reset, and it must restore
 * project. Iterating whatever resets happen to exist made "no reset at all" a
 * pass — deleting the very behaviour the test guards would have made it greener.
 */
const CONTAINERS = [
  { file: 'app/components/reporting/ScopeRegional.vue', role: 'the region owner', resets: 1 },
  {
    // Whole-company has no drill of its own to enter or leave, so it has nothing
    // to reset — pinned at 0 so ADDING one silently is visible too.
    file: 'app/components/reporting/ScopeAcrossRegions.vue',
    role: 'whole-company FinOps',
    resets: 0,
  },
]

/**
 * The axis-option lists a user picks from.
 *
 * The COST-CENTRE scope is deliberately absent from BOTH lists above: it no
 * longer pivots at all. Its owner sees the Budgets and People lists side by side
 * (04-prototype-delta.md §5b), so there is no axis ref to default and no
 * selector to order. "Budgets first" is asserted for that scope in its own
 * describe block below, on the RENDERED DOM — a structural fact rather than a
 * default that could quietly flip.
 */
const AXIS_LISTS = [
  'app/components/reporting/ScopeRegionalView.vue',
  'app/components/reporting/across/TopDriversCard.vue',
]

describe('the reporting scopes open on PROJECTS, not on people', () => {
  it.each(CONTAINERS)('$file defaults its drivers axis to project (for $role)', ({ file }) => {
    const src = read(file)
    const inits = [...src.matchAll(/const axis = ref\('([a-z-]+)'\)/g)].map((m) => m[1])
    expect(inits, `${file} must initialise exactly one drivers axis`).toHaveLength(1)
    expect(inits[0]).toBe('project')
  })

  it.each(CONTAINERS)('$file’s drill reset restores project, not teammate', ({ file, resets }) => {
    const src = read(file)
    const found = [...src.matchAll(/axis\.value = '([a-z-]+)'/g)].map((m) => m[1])
    // The COUNT first: iterating the matches made zero matches a pass, so
    // deleting the reset this test exists to guard would have made it greener.
    expect(found, `${file} must contain exactly ${resets} axis reset(s)`).toHaveLength(resets)
    for (const value of found) {
      expect(value, `${file} resets the axis to '${value}' — a person view via the back door`).toBe(
        'project',
      )
    }
  })

  it.each(AXIS_LISTS)('%s offers project as a selectable axis, listed first', (file) => {
    const src = read(file)
    // The label may be a literal OR the shared BUDGET_LABEL constant (story 4 —
    // the product says "Budget" for the object the wire keys as 'project'). The
    // KEY is what this test is about and it never moved; matching only literals
    // would make the rename look like a DELETED project axis.
    const options = [
      ...src.matchAll(/\{\s*value:\s*'([a-z-]+)',\s*label:\s*(?:'[^']+'|[A-Z][A-Z0-9_]*)\s*\}/g),
    ].map((m) => m[1])
    expect(options, `${file} must offer a project axis`).toContain('project')
    expect(options[0], `${file}'s first axis option`).toBe('project')
  })
})

describe('the cost-centre scope does not pivot at all — budgets simply lead', () => {
  const CC_DRILL = 'app/components/reporting/cost-centre/CcDrill.vue'

  it('CcDrill renders the BUDGETS hero before the PEOPLE hero', () => {
    // With no axis default left to carry "budgets first", ORDER carries it. A
    // reordering that put people first is the same regression the axis-ref
    // guards above prevent for the other two scopes.
    const src = read(CC_DRILL)
    const budgets = src.indexOf('data-testid="cc-hero-budgets"')
    const people = src.indexOf('data-testid="cc-hero-people"')
    expect(budgets, `${CC_DRILL} must render a budgets hero`).toBeGreaterThan(-1)
    expect(people, `${CC_DRILL} must render a people hero`).toBeGreaterThan(-1)
    expect(budgets, 'budgets must come first — the unit of account is the budget (D1)').toBeLessThan(
      people,
    )
  })

  it('CcDrill offers NO axis selector — a pivot creeping back is a design regression', () => {
    const src = read(CC_DRILL)
    expect(src).not.toMatch(/AxisOption/)
    expect(src).not.toMatch(/axis-options=/)
  })

  it('ScopeCostCentre owns no drivers-axis state to default or reset', () => {
    // The counterpart of the CONTAINERS rows above: this scope passes the check
    // by having nothing to check, so assert the absence rather than leave the
    // scope silently unguarded.
    const src = read('app/components/reporting/ScopeCostCentre.vue')
    expect(src).not.toMatch(/const axis = ref\(/)
    expect(src).not.toMatch(/axis\.value = /)
  })

  /*
   * The SERVER half of this rule is NOT asserted here any more, and deliberately.
   * It used to read the enums and check they ADMITTED 'project' — which every one
   * of the four wrong API defaults passed, because admitting an axis and
   * defaulting to it are different facts. Source text cannot tell them apart.
   * `tests/integration/reports/default-axis.test.ts` calls each handler with NO
   * axis and asserts what comes back.
   */
})
