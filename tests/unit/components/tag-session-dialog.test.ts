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
