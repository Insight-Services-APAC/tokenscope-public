// @vitest-environment happy-dom
/*
 * OrgTree — depth-render correctness + collapse-on-click.
 *
 * Pins the LTREE-shape rendering: depth comes from server-side
 * nlevel(path); the component indents per depth and shows expand
 * carets only for nodes with children. Roots start expanded;
 * deeper levels start collapsed.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import OrgTree, { type OrgNode } from '../../../app/components/admin/OrgTree.vue'

function node(over: Partial<OrgNode>): OrgNode {
  return {
    id: 'id',
    parent_id: null,
    path: 'emea',
    depth: 1,
    code: 'code',
    display_name: 'Node',
    unit_type: 'bu',
    is_cost_owning_unit: false,
    teammate_count: 0,
    project_count: 0,
    ...over,
  }
}

describe('OrgTree', () => {
  it('renders root nodes expanded and child nodes only when parent is expanded', () => {
    const nodes: OrgNode[] = [
      node({ id: 'r1', code: 'bcm', display_name: 'BCM', path: 'emea.bcm', depth: 2 }),
      node({
        id: 'c1',
        parent_id: 'r1',
        code: 'sigma',
        display_name: 'Sigma',
        path: 'emea.bcm.sigma',
        depth: 3,
      }),
      node({
        id: 'c2',
        parent_id: 'r1',
        code: 'tau',
        display_name: 'Tau',
        path: 'emea.bcm.tau',
        depth: 3,
      }),
      node({
        id: 'r2',
        code: 'ins',
        display_name: 'Insurance',
        path: 'emea.ins',
        depth: 2,
      }),
      node({
        id: 'c3',
        parent_id: 'r2',
        code: 'kappa',
        display_name: 'Kappa',
        path: 'emea.ins.kappa',
        depth: 3,
      }),
    ]
    const wrapper = mount(OrgTree, { props: { nodes } })
    // Both roots render expanded → all 5 nodes visible.
    expect(wrapper.find('[data-testid="org-node-bcm"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="org-node-sigma"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="org-node-tau"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="org-node-ins"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="org-node-kappa"]').exists()).toBe(true)
  })

  it('collapses a parent when its caret is clicked, hiding the descendant subtree', async () => {
    const nodes: OrgNode[] = [
      node({ id: 'r1', code: 'bcm', display_name: 'BCM', path: 'emea.bcm', depth: 2 }),
      node({
        id: 'c1',
        parent_id: 'r1',
        code: 'sigma',
        display_name: 'Sigma',
        path: 'emea.bcm.sigma',
        depth: 3,
      }),
    ]
    const wrapper = mount(OrgTree, { props: { nodes } })
    expect(wrapper.find('[data-testid="org-node-sigma"]').exists()).toBe(true)
    await wrapper.find('[data-testid="toggle-bcm"]').trigger('click')
    expect(wrapper.find('[data-testid="org-node-sigma"]').exists()).toBe(false)
    // Re-expand restores.
    await wrapper.find('[data-testid="toggle-bcm"]').trigger('click')
    expect(wrapper.find('[data-testid="org-node-sigma"]').exists()).toBe(true)
  })

  it('indents per depth (paddingLeft proportional to depth)', () => {
    const nodes: OrgNode[] = [
      node({ id: 'r1', code: 'bcm', display_name: 'BCM', path: 'emea.bcm', depth: 2 }),
      node({
        id: 'c1',
        parent_id: 'r1',
        code: 'sigma',
        display_name: 'Sigma',
        path: 'emea.bcm.sigma',
        depth: 3,
      }),
    ]
    const wrapper = mount(OrgTree, { props: { nodes } })
    const bcm = wrapper.find('[data-testid="org-node-bcm"]')
    const sigma = wrapper.find('[data-testid="org-node-sigma"]')
    expect(bcm.attributes('style')).toContain('padding-left: 40px')
    expect(sigma.attributes('style')).toContain('padding-left: 60px')
  })
})
