// @vitest-environment happy-dom
/*
 * Removing a directory exclusion asks first (#543): Remove opens a dialog
 * naming the pattern; Cancel sends nothing; Confirm sends the DELETE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DirectoryExclusionsSection from '../../../app/components/admin/DirectoryExclusionsSection.vue'

const ROW = { id: '9a1e0000-0000-4000-8000-0000000000e1', pattern: '*-cld@example.com', note: null, created_at: '2026-10-01T00:00:00Z' }

function mountSection() {
  const fetch = vi.fn(async () => ({}))
  vi.stubGlobal('$fetch', fetch)
  const w = mount(DirectoryExclusionsSection, { props: { rows: [ROW], orgWide: true }, attachTo: document.body })
  return { w, fetch }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('directory exclusion removal', () => {
  it('Remove asks first; Cancel sends nothing', async () => {
    const { w, fetch } = mountSection()
    await w.find(`[data-testid="exclusion-remove-${ROW.id}"]`).trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="exclusion-remove-dialog"]').text()).toContain('Remove the exclusion *-cld@example.com?')
    expect(fetch).not.toHaveBeenCalled()
    await w.find('[data-testid="exclusion-remove-cancel"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="exclusion-remove-dialog"]').exists()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('Confirm sends the DELETE and says what was removed', async () => {
    const { w, fetch } = mountSection()
    await w.find(`[data-testid="exclusion-remove-${ROW.id}"]`).trigger('click')
    await w.find('[data-testid="exclusion-remove-confirm"]').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(`/api/v1/admin/directory-exclusions/${ROW.id}`, { method: 'DELETE' })
    expect(w.find('[data-testid="settings-exclusions-toast-ok"]').text()).toContain('Removed "*-cld@example.com"')
  })
})
