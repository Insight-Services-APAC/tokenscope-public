// @vitest-environment happy-dom
/*
 * Admin result messages are announced (#544): both live regions are in the
 * page before any message lands (a region inserted with its text is often not
 * read out); success goes to role="status", a refusal to role="alert". A
 * success clears itself; a refusal stays until it is dismissed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import AdminResultToast from '../../../app/components/admin/AdminResultToast.vue'
import { OK_MS, useResultToast } from '../../../app/composables/useResultToast'

function harness() {
  let api!: ReturnType<typeof useResultToast>
  const Host = defineComponent({
    setup() {
      api = useResultToast()
      return () => h(AdminResultToast, { toast: api.toast.value, testid: 't', onDismiss: api.dismissToast })
    },
  })
  const w = mount(Host)
  return { w, api: () => api }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AdminResultToast', () => {
  it('keeps both live regions in the page while empty', () => {
    const { w } = harness()
    expect(w.find('[role="status"]').exists()).toBe(true)
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.text()).toBe('')
  })

  it('puts a success in role=status and a refusal in role=alert', async () => {
    const { w, api } = harness()
    api().flashToast('ok', 'Saved.')
    await w.vm.$nextTick()
    expect(w.find('[role="status"] [data-testid="t-ok"]').text()).toBe('Saved.')
    api().flashToast('err', 'Refused.')
    await w.vm.$nextTick()
    expect(w.find('[role="alert"] [data-testid="t-err"]').text()).toContain('Refused.')
    expect(w.find('[data-testid="t-ok"]').exists()).toBe(false)
  })

  it('the same message twice is a new node, so it is announced again', async () => {
    const { w, api } = harness()
    api().flashToast('ok', 'Rule removed.')
    await w.vm.$nextTick()
    const first = w.find('[data-testid="t-ok"]').element
    api().flashToast('ok', 'Rule removed.')
    await w.vm.$nextTick()
    const second = w.find('[data-testid="t-ok"]').element
    expect(second.textContent?.trim()).toBe('Rule removed.')
    expect(second).not.toBe(first)
  })

  it('a success clears itself; a refusal stays until dismissed', async () => {
    vi.useFakeTimers()
    const { w, api } = harness()
    api().flashToast('ok', 'Saved.')
    vi.advanceTimersByTime(OK_MS + 1)
    await w.vm.$nextTick()
    expect(w.find('[data-testid="t-ok"]').exists()).toBe(false)

    api().flashToast('err', 'Refused.')
    vi.advanceTimersByTime(OK_MS * 10)
    await w.vm.$nextTick()
    expect(w.find('[data-testid="t-err"]').exists()).toBe(true)
    await w.find('[data-testid="t-dismiss"]').trigger('click')
    expect(w.find('[data-testid="t-err"]').exists()).toBe(false)
  })
})
