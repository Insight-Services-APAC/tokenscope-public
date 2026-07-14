// @vitest-environment happy-dom
/*
 * FetchErrorBanner (FE-2) — the shared "the fetch behind this failed" surface.
 * Hidden while error is null; visible with the extracted detail + a Retry
 * button that emits `retry` so the page can re-run the failed useFetch.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FetchErrorBanner from '../../../app/components/ui/FetchErrorBanner.vue'

describe('FetchErrorBanner', () => {
  it('renders nothing while the error is null', () => {
    const wrapper = mount(FetchErrorBanner, { props: { error: null } })
    expect(wrapper.find('[data-testid="fetch-error-banner"]').exists()).toBe(false)
  })

  it('renders the label + RFC-9457 detail when an error is present', () => {
    const wrapper = mount(FetchErrorBanner, {
      props: {
        error: { data: { data: { detail: 'Upstream timed out.' } } },
        label: 'your usage summary',
      },
    })
    const banner = wrapper.find('[data-testid="fetch-error-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.attributes('role')).toBe('alert')
    expect(banner.text()).toContain("Couldn't load your usage summary")
    expect(banner.text()).toContain('Upstream timed out.')
  })

  it('emits retry when the Retry button is clicked', async () => {
    const wrapper = mount(FetchErrorBanner, {
      props: { error: { message: 'boom' } },
    })
    await wrapper.find('[data-testid="fetch-error-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
