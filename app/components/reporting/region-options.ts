/*
 * The Region scope's selector, built from one response's own grant fields.
 *
 * §6's rule is that the selector's options ARE the grant, so the option list is a
 * pure function of what the endpoint reported it would serve: `regionOptions` (the
 * regions this caller may pick) and `allRegionsAvailable` (whether the whole-company
 * width is one of them). Nothing here consults a role, a mode, or a session — if it
 * did, the control could offer a width the endpoint 403s.
 *
 * Both widths render the selector from THIS function, which is what keeps them a
 * single control rather than two that happen to look alike: the reader moves between
 * "All regions" and one region without the list changing shape underneath them.
 */
import { ALL_REGIONS } from '#shared/reports/types'
import type { RegionOption } from '../ui/RegionSelector.vue'

/** The label the whole-company width carries everywhere it is offered or shown. */
export const ALL_REGIONS_LABEL = 'All regions'

export interface RegionSelectorGrantFields {
  regionOptions: RegionOption[]
  allRegionsAvailable: boolean
}

/*
 * Both fields read DEFENSIVELY, though the type requires them.
 *
 * A payload that reached the view without them is a contract break, and the type
 * makes that a compile error at every real call site. But the runtime consequence of
 * reading `.length` off an absent list is a thrown render — the whole report
 * disappears because a dropdown could not be built. Absent is read as "no options
 * reported", which renders no selector: the report still answers the question the
 * reader opened it for, and the missing control is the visible symptom.
 */
function optionsOf(g: RegionSelectorGrantFields): RegionOption[] {
  return Array.isArray(g?.regionOptions) ? g.regionOptions : []
}

/**
 * The full option list, "All regions" FIRST when granted (§6: "a selector whose
 * first option is All regions").
 *
 * The sentinel is carried as a NORMAL option with `id = ALL_REGIONS`, never as an
 * empty-string "none" value. An empty string in `?region=` is indistinguishable from
 * "no region named", which is the caller's DEFAULT width — so "I chose the whole
 * company" and "I chose nothing" would be the same URL, and a region-bound caller's
 * default would read as an all-regions request. Carrying it as an option is also
 * what lets the control render as one pill row: "All regions" is a width like any
 * other, not a special case the control has to know about.
 */
export function regionSelectorOptions(g: RegionSelectorGrantFields): RegionOption[] {
  const all: RegionOption = { id: ALL_REGIONS, code: ALL_REGIONS, displayName: ALL_REGIONS_LABEL }
  return g?.allRegionsAvailable ? [all, ...optionsOf(g)] : optionsOf(g)
}

/**
 * Whether to render the control at all: only when there is a genuine CHOICE.
 *
 * One option is not a selector, it is a label — and §6 says a caller granted only
 * their own region gets "nothing rendered". Counting the options rather than testing
 * the grant flags directly means this can never disagree with the list above.
 */
export function regionSelectorVisible(g: RegionSelectorGrantFields): boolean {
  return regionSelectorOptions(g).length > 1
}
