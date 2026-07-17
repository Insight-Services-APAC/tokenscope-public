// @vitest-environment happy-dom
/*
 * ReportVisibilitySection — render + save contract for the org-wide
 * report-visibility policy editor (mig 0087).
 *
 * Contract under test:
 *  - renders one preset card per mode with its label, description and the
 *    WHO-SEES-WHAT matrix from the payload; the current mode is badged;
 *  - org-wide admin: selecting a different preset enables Save, which PUTs
 *    { mode } and emits `saved`;
 *  - region admin (orgWide=false): radios disabled, no Save button — read-only;
 *  - a served RFC-9457 error surfaces via the err toast (no `saved` emit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReportVisibilitySection from '../../../app/components/admin/ReportVisibilitySection.vue'
import type { ReportVisibilityData } from '../../../app/components/admin/ReportVisibilitySection.vue'

function fixture(mode = 'standard'): ReportVisibilityData {
  return {
    mode,
    updated_by: mode === 'standard' ? null : 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    updated_by_name: mode === 'standard' ? null : 'Mara Holloway',
    updated_at: mode === 'standard' ? null : '2026-06-10 00:00:00+00',
    modes: [
      {
        mode: 'standard',
        label: 'Standard',
        description: "Today's behaviour — reports scoped by role exactly as now.",
        matrix: [
          { persona: 'Region admin', scopes: ['Regional (own region)'] },
          { persona: 'Global finops', scopes: ['Across', 'Regional', 'Cost centres', 'Finance'] },
        ],
      },
      {
        mode: 'region-admins-see-all',
        label: 'Region admins see all',
        description: 'Region admins additionally see the org-wide reports.',
        matrix: [
          { persona: 'Region admin', scopes: ['Across', 'Regional', 'Cost centres', 'Finance'] },
          { persona: 'Global finops', scopes: ['Across', 'Regional', 'Cost centres', 'Finance'] },
        ],
      },
      {
        mode: 'all-admins-see-all',
        label: 'All admins see all',
        description: 'Region admins and cost-centre owners see the org-wide reports.',
        matrix: [
          { persona: 'Cost-centre owner', scopes: ['Across', 'Regional', 'Cost centres', 'Finance'] },
          { persona: 'Global finops', scopes: ['Across', 'Regional', 'Cost centres', 'Finance'] },
        ],
      },
    ],
  }
}

function mountOrgWide(data: ReportVisibilityData = fixture()) {
  return mount(ReportVisibilitySection, { props: { data, orgWide: true } })
}
function mountRegionAdmin(data: ReportVisibilityData = fixture()) {
  return mount(ReportVisibilitySection, { props: { data, orgWide: false } })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('ReportVisibilitySection', () => {
  it('renders a preset card per mode with label, description and matrix; current is badged', () => {
    const wrapper = mountOrgWide()
    expect(wrapper.find('[data-testid="settings-report-visibility"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="report-visibility-card-standard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="report-visibility-card-region-admins-see-all"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="report-visibility-card-all-admins-see-all"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Region admins see all')
    expect(wrapper.text()).toContain('Region admins additionally see the org-wide reports.')
    // Matrix rendered from the payload.
    expect(
      wrapper.find('[data-testid="report-visibility-matrix-standard-Region admin"]').text(),
    ).toContain('Regional (own region)')
    // Current mode ('standard') is badged; the others are not.
    expect(wrapper.find('[data-testid="report-visibility-current-standard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="report-visibility-current-all-admins-see-all"]').exists()).toBe(false)
  })

  it('org-wide: selecting another preset PUTs { mode } and emits saved', async () => {
    const put = vi.fn().mockResolvedValue({ mode: 'region-admins-see-all' })
    vi.stubGlobal('$fetch', put)
    const wrapper = mountOrgWide()
    // Save is disabled until a different mode is chosen.
    expect(wrapper.find('[data-testid="report-visibility-save"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="report-visibility-radio-region-admins-see-all"]').trigger('change')
    await wrapper.find('[data-testid="report-visibility-save"]').trigger('click')
    await flushPromises()
    expect(put).toHaveBeenCalledWith('/api/v1/admin/report-visibility', {
      method: 'PUT',
      body: { mode: 'region-admins-see-all' },
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.find('[data-testid="settings-report-visibility-toast-ok"]').exists()).toBe(true)
  })

  it('region admin (orgWide=false): radios disabled, no Save — read-only', () => {
    const wrapper = mountRegionAdmin(fixture('region-admins-see-all'))
    expect(wrapper.find('[data-testid="report-visibility-save"]').exists()).toBe(false)
    expect(
      wrapper.find('[data-testid="report-visibility-radio-standard"]').attributes('disabled'),
    ).toBeDefined()
    // The "set by" footer surfaces who changed it.
    expect(wrapper.find('[data-testid="report-visibility-setby"]').text()).toContain('Mara Holloway')
  })

  it('surfaces a served RFC-9457 error via the err toast (no saved emit)', async () => {
    const put = vi.fn().mockRejectedValue({
      data: { data: { detail: 'The report-visibility policy is org-wide config.' } },
    })
    vi.stubGlobal('$fetch', put)
    const wrapper = mountOrgWide()
    await wrapper.find('[data-testid="report-visibility-radio-all-admins-see-all"]').trigger('change')
    await wrapper.find('[data-testid="report-visibility-save"]').trigger('click')
    await flushPromises()
    const toast = wrapper.find('[data-testid="settings-report-visibility-toast-err"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('org-wide config')
    expect(wrapper.emitted('saved')).toBeUndefined()
  })
})
