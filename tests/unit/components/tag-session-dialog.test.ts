// @vitest-environment happy-dom
/*
 * TagSessionDialog — the one tag/re-tag editor for a session, a §A day, and a
 * BULK selection. Contract: the save target follows the subject (per-session
 * assign / per-day assign / worklist bulk), and bulk refuses to save with both
 * axes empty (every queue item is already untagged, so that would be a no-op
 * reporting success).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TagSessionDialog, { type TagTarget } from '../../../app/components/home/TagSessionDialog.vue'

const PROJECTS = [{ id: 'p-1', code: 'ACME-1', display_name: 'Acme', type: 'billable' }]
const ACTIVITY_TYPES = [{ label: 'Research', is_mine: true }]

const global = {
  stubs: {
    UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
    UsageModelBadge: { props: ['byModel'], template: '<span />' },
    Icon: { props: ['name'], template: '<i />' },
  },
}

const sessionTarget: TagTarget = {
  session_id: 'conv-1',
  instance_id: 'inst-1',
  tool: 'claude-code',
  cost_usd: '0.42',
  tokens: 1000,
  last_event: '2026-07-20T10:00:00.000Z',
  project_id: null,
  activity: null,
}

const bulkTarget: TagTarget = {
  session_id: '',
  instance_id: null,
  tool: 'claude-code',
  cost_usd: 39.94,
  tokens: 0,
  last_event: '',
  project_id: null,
  activity: null,
  subject_kind: 'bulk',
  bulk: { sessions: ['conv-1', 'conv-2'], unaccounted: ['day-1'] },
}

const mountDialog = (target: TagTarget) =>
  mount(TagSessionDialog, { props: { target, projects: PROJECTS, activityTypes: ACTIVITY_TYPES }, global })

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('TagSessionDialog — single item', () => {
  it('spend names its unit: "$… · … tokens" (#591)', () => {
    const w = mountDialog(sessionTarget)
    expect(w.get('[data-testid="tag-session-spend"]').text()).toMatch(/ · .+ tokens$/)
  })

  it('saves a session through the per-session assign endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountDialog(sessionTarget)
    await w.find('[data-testid="tag-project"]').setValue('p-1')
    await w.find('[data-testid="tag-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/sessions/conv-1/assign', {
      method: 'POST',
      body: { project_id: 'p-1', activity: null },
    })
    expect(w.emitted('saved')).toHaveLength(1)
  })

  it('still allows the clear-everything correction on a single item', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountDialog({ ...sessionTarget, project_id: 'p-1', activity: 'Research' })
    await w.find('[data-testid="tag-project"]').setValue('')
    await w.find('[data-testid="tag-activity"]').setValue('')
    await w.find('[data-testid="tag-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/sessions/conv-1/assign', {
      method: 'POST',
      body: { project_id: null, activity: null },
    })
  })
})

describe('TagSessionDialog — bulk', () => {
  it('names both item kinds in the subject', () => {
    const w = mountDialog(bulkTarget)
    expect(w.text()).toContain('3 items')
    expect(w.find('[data-testid="tag-bulk-items"]').text()).toBe('2 sessions · 1 provider-recorded day')
    expect(w.text()).toContain('$39.94')
  })

  it('refuses to save with both axes empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountDialog(bulkTarget)
    const submit = w.find('[data-testid="tag-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    await submit.trigger('click')
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts one bulk tag for the whole selection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ action: 'tag', total: 3 })
    vi.stubGlobal('$fetch', fetchMock)
    const w = mountDialog(bulkTarget)
    await w.find('[data-testid="tag-activity"]').setValue('Research')
    await w.find('[data-testid="tag-submit"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/worklist/bulk', {
      method: 'POST',
      body: {
        action: 'tag',
        sessions: ['conv-1', 'conv-2'],
        unaccounted: ['day-1'],
        project_id: null,
        activity: 'Research',
      },
    })
    expect(w.emitted('saved')).toHaveLength(1)
  })

  it('surfaces a rejected bulk save instead of closing', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { detail: 'Not a member of this budget' } }))
    const w = mountDialog(bulkTarget)
    await w.find('[data-testid="tag-project"]').setValue('p-1')
    await w.find('[data-testid="tag-submit"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="tag-error"]').text()).toContain('Not a member')
    expect(w.emitted('saved')).toBeUndefined()
  })
})

/*
 * #577: the dialog says when the session ran and on which device; the session
 * id stays, demoted below them. Bulk mode is unchanged.
 */
describe('TagSessionDialog — when and where (#577)', () => {
  function inZone(zone: string) {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: zone }
    })
  }

  it('shows the span, its length and the device name', async () => {
    inZone('Australia/Brisbane')
    const w = mountDialog({
      ...sessionTarget,
      instance_id: '9a1e0000-0000-4000-8000-000000000001',
      device_name: 'Work laptop',
      first_event: '2026-11-09T04:05:00.000Z',
      last_event: '2026-11-09T06:40:00.000Z',
    })
    await flushPromises()
    expect(w.find('[data-testid="tag-session-when"]').text()).toBe('Mon 9 Nov, 14:05 to 16:40 · 2 h 35 min')
    expect(w.find('[data-testid="tag-session-device"]').text()).toBe('Work laptop')
    expect(w.text()).toContain('conv-1')
  })

  it('an unnamed device reads as tool and short id, never blank', async () => {
    const w = mountDialog({ ...sessionTarget, instance_id: '9e8d7c6b-0000-4000-8000-000000000002' })
    await flushPromises()
    expect(w.find('[data-testid="tag-session-device"]').text()).toBe('Claude Code · 9e8d7c6b')
  })

  it('without a start time it says how long ago it last ran instead of inventing a span', async () => {
    const w = mountDialog(sessionTarget)
    await flushPromises()
    expect(w.find('[data-testid="tag-session-when"]').text()).toContain('last activity')
  })

  it('bulk mode is unchanged: no When or Device rows', async () => {
    const w = mountDialog(bulkTarget)
    await flushPromises()
    expect(w.find('[data-testid="tag-bulk-items"]').exists()).toBe(true)
    expect(w.find('[data-testid="tag-session-when"]').exists()).toBe(false)
    expect(w.find('[data-testid="tag-session-device"]').exists()).toBe(false)
  })
})
