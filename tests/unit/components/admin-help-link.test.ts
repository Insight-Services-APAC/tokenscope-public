// @vitest-environment happy-dom
/*
 * AdminHelpLink — the inline "?" glossary deep-link. It must be a real,
 * anchored, labelled link (touch-friendly + AT-exposed), not a hover-only
 * tooltip — that was the design-review requirement behind un-burying the
 * owner-vs-leader distinction.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AdminHelpLink from '../../../app/components/admin/AdminHelpLink.vue'

const NuxtLinkStub = {
  props: ['to'],
  inheritAttrs: true,
  template: '<a :href="to"><slot /></a>',
}

function mountLink(anchor: string, label: string) {
  return mount(AdminHelpLink, {
    props: { anchor, label },
    global: { stubs: { NuxtLink: NuxtLinkStub } },
  })
}

describe('AdminHelpLink', () => {
  it('deep-links to the glossary anchor', () => {
    const w = mountLink('region-leader', 'a Region leader')
    expect(w.find('a').attributes('href')).toBe('/admin/help#region-leader')
  })

  it('carries an AT label naming the term (not a hover-only tooltip)', () => {
    const w = mountLink('cost-centre-owner', 'a cost-centre owner')
    const a = w.find('a')
    expect(a.attributes('aria-label')).toContain('cost-centre owner')
    expect(a.attributes('data-testid')).toBe('help-cost-centre-owner')
  })

  it('renders a visible "?" affordance', () => {
    const w = mountLink('manager-role', 'the Manager role')
    expect(w.text()).toBe('?')
  })
})
