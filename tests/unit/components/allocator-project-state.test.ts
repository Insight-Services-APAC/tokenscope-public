// @vitest-environment node
/*
 * #640: the budget editor shows the project's real state and the region's
 * name, not a hardcoded "Onboarded" badge and a lowercase region code.
 */
import { describe, it, expect } from 'vitest'
import { projectState, regionWords } from '../../../app/components/allocator/project-state'

const PID = '9a1e0000-0000-4000-8000-000000000640'

describe('projectState (#640)', () => {
  it('an ended project reads Ended, as on the admin projects list', () => {
    expect(projectState({ project_id: PID, project_end_date: '2026-10-01T00:00:00Z', project_ended: true })).toEqual({
      badge: { kind: 'neutral', label: 'Ended' },
      status: 'Ended',
    })
  })
  it('a project with a future end reads the UTC day it ends', () => {
    expect(projectState({ project_id: PID, project_end_date: '2026-12-14T00:00:00Z', project_ended: false })).toEqual({
      badge: { kind: 'rag-amber', label: 'Ends 14 Dec 2026' },
      status: 'Ends 14 Dec 2026',
    })
  })
  it('an end instant off midnight still names its UTC day, in any viewer zone', () => {
    expect(projectState({ project_id: PID, project_end_date: '2099-06-30T23:30:00Z', project_ended: false }).status).toBe(
      'Ends 30 Jun 2099',
    )
  })
  it('an open-ended project has no badge', () => {
    expect(projectState({ project_id: PID, project_end_date: null, project_ended: false })).toEqual({
      badge: null,
      status: 'Active, no end date',
    })
  })
  it('never says Onboarded', () => {
    for (const s of [
      projectState({ project_id: PID }),
      projectState({ project_id: PID, project_ended: true }),
      projectState({ project_id: null }),
    ]) {
      expect(JSON.stringify(s)).not.toContain('Onboarded')
    }
  })
  it('a budget that is not a project budget has no project state', () => {
    expect(projectState({ project_id: null })).toEqual({ badge: null, status: '—' })
  })
})

describe('regionWords (#640)', () => {
  it('reads the region name', () => {
    expect(regionWords({ region_name: 'Asia Pacific', region_code: 'apac' })).toBe('Asia Pacific')
  })
  it('falls back to the code in capitals, as the Business Units picker does', () => {
    expect(regionWords({ region_name: null, region_code: 'apac' })).toBe('APAC')
    expect(regionWords({ region_code: null })).toBe('—')
  })
})
