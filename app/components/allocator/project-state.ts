/*
 * The budget editor's project facts (#640), from real data rather than a
 * hardcoded "Onboarded" badge and a lowercase region code.
 *
 * State follows the project page: a project has ENDED when its end date is
 * set and past (the server decides, `endedProjectExpr`), ENDS on a date when
 * one is set in the future, and is otherwise active with no end. The end date
 * is shown as the UTC day the project page shows.
 */
import { fmtUtcDay } from '../../composables/useFormat'

export interface ProjectStateInput {
  project_id: string | null
  project_end_date?: string | null
  project_ended?: boolean
}

export interface ProjectState {
  /** The header badge, or null when there is nothing worth flagging (an open-ended project). */
  badge: { kind: 'neutral' | 'rag-amber'; label: string } | null
  /** The metadata row's words. */
  status: string
}

export function projectState(f: ProjectStateInput): ProjectState {
  if (!f.project_id) return { badge: null, status: '—' }
  if (f.project_ended) return { badge: { kind: 'neutral', label: 'Ended' }, status: 'Ended' }
  if (f.project_end_date) {
    const words = `Ends ${fmtUtcDay(f.project_end_date, { year: true })}`
    return { badge: { kind: 'rag-amber', label: words }, status: words }
  }
  return { badge: null, status: 'Active, no end date' }
}

/** The region as people know it: its display name, else its code in capitals (as the Business Units picker does, #635). */
export function regionWords(f: { region_name?: string | null; region_code: string | null }): string {
  return f.region_name ?? f.region_code?.toUpperCase() ?? '—'
}
