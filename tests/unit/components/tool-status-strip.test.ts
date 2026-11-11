// @vitest-environment happy-dom
/*
 * #580: Home says whether each enabled tool is sending, silent or not
 * connected, from the server's verdicts; Connect only where it is needed; a
 * failed check never claims "not connected".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import ToolStatusStrip from '../../../app/components/home/ToolStatusStrip.vue'

interface Inst {
  instance_id: string
  tool: string
  display_name: string | null
  last_emission: string | null
  revoked: boolean
  state: string
}

const BOTH = [
  { tool: 'claude-code' as const, enabled: true },
  { tool: 'copilot-cli' as const, enabled: true },
]

function mountStrip(read: { instances?: Inst[]; error?: unknown }, clients = BOTH) {
  const refresh = vi.fn()
  vi.stubGlobal('useLazyFetch', () => ({
    data: ref(read.instances ? { instances: read.instances } : null),
    pending: ref(false),
    error: ref(read.error ?? null),
    refresh,
  }))
  const w = mount(ToolStatusStrip, {
    props: { clients },
    global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to" v-bind="$attrs"><slot /></a>' } } },
  })
  return { w, refresh }
}

const recent = new Date(Date.now() - 12 * 60_000).toISOString()

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('HomeToolStatusStrip', () => {
  it('a connected client shows its state and last usage, not a Connect button', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '9a1e0000-0000-4000-8000-000000000001', tool: 'claude-code', display_name: 'Work laptop', last_emission: recent, revoked: false, state: 'sending' },
      ],
    })
    await flushPromises()
    const line = w.find('[data-testid="home-tool-claude-code"]')
    expect(line.attributes('data-state')).toBe('sending')
    expect(line.text()).toContain('Work laptop · last usage 12m ago')
    // It knows when usage was last recorded, not that the device is sending now.
    expect(line.text()).not.toContain('sending')
    expect(w.find('[data-testid="home-tool-connect-claude-cli"]').exists()).toBe(false)
  })

  it('an unnamed device reads "device <id>", without naming the tool a second time (#591)', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '77d7c923-0000-4000-8000-000000000001', tool: 'claude-code', display_name: null, last_emission: recent, revoked: false, state: 'sending' },
      ],
    })
    await flushPromises()
    const line = w.find('[data-testid="home-tool-claude-code"]')
    expect(line.text()).toContain('device 77d7c923 · last usage 12m ago')
    expect(line.text().match(/Claude Code/g)).toHaveLength(1)
  })

  it('a client with no live device shows "Not connected", and Connect opens the same guide', async () => {
    const { w } = mountStrip({
      instances: [
        // A revoked device is not a connection.
        { instance_id: '9a1e0000-0000-4000-8000-000000000003', tool: 'copilot-cli', display_name: null, last_emission: recent, revoked: true, state: 'revoked' },
      ],
    })
    await flushPromises()
    expect(w.find('[data-testid="home-tool-copilot-cli"]').text()).toContain('Not connected')
    await w.find('[data-testid="home-tool-connect-copilot-cli"]').trigger('click')
    expect(w.emitted('connect')![0]).toEqual(['copilot-cli'])
    // Claude Code: one line, both installs offered (#454 not landed).
    expect(w.find('[data-testid="home-tool-connect-claude-desktop"]').exists()).toBe(true)
    expect(w.find('[data-testid="home-tool-connect-claude-cli"]').exists()).toBe(true)
  })

  it('a device the server cannot sign in is amber and links to My account devices', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '9a1e0000-0000-4000-8000-000000000004', tool: 'copilot-cli', display_name: null, last_emission: '2026-11-06T03:00:00Z', revoked: false, state: 'cannot-send' },
      ],
    })
    await flushPromises()
    const line = w.find('[data-testid="home-tool-copilot-cli"]')
    expect(line.attributes('data-state')).toBe('cannot-send')
    expect(line.text()).toContain('Cannot send')
    expect(w.find('[data-testid="home-tool-fix-copilot-cli"]').attributes('href')).toBe('/account#your-devices')
  })

  it('an idle device raises no amber and no Fix', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '9a1e0000-0000-4000-8000-000000000005', tool: 'claude-code', display_name: 'Laptop', last_emission: '2026-11-08T03:00:00Z', revoked: false, state: 'idle' },
      ],
    })
    await flushPromises()
    const line = w.find('[data-testid="home-tool-claude-code"]')
    expect(line.attributes('data-state')).toBe('idle')
    expect(line.text()).toContain('Laptop · last usage')
    expect(line.find('.text-rag-amber').exists()).toBe(false)
    expect(w.find('[data-testid="home-tool-fix-claude-code"]').exists()).toBe(false)
  })

  it('a new device with no usage yet says so, without a warning', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '9a1e0000-0000-4000-8000-000000000006', tool: 'claude-code', display_name: null, last_emission: null, revoked: false, state: 'idle' },
      ],
    })
    await flushPromises()
    expect(w.find('[data-testid="home-tool-claude-code"]').text()).toContain('Connected, no usage yet')
  })

  it('devices not in use are not mentioned, and raise no Fix', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '9a1e0000-0000-4000-8000-000000000007', tool: 'claude-code', display_name: 'Work laptop', last_emission: recent, revoked: false, state: 'sending' },
        { instance_id: '9a1e0000-0000-4000-8000-000000000008', tool: 'claude-code', display_name: 'Old box', last_emission: '2026-06-01T00:00:00Z', revoked: false, state: 'not-in-use' },
      ],
    })
    await flushPromises()
    const line = w.find('[data-testid="home-tool-claude-code"]')
    expect(line.text()).not.toContain('Old box')
    expect(line.text()).not.toContain('silent')
    expect(w.find('[data-testid="home-tool-fix-claude-code"]').exists()).toBe(false)
  })

  it('only devices not in use: says so and offers Connect', async () => {
    const { w } = mountStrip({
      instances: [
        { instance_id: '9a1e0000-0000-4000-8000-000000000009', tool: 'claude-code', display_name: null, last_emission: null, revoked: false, state: 'not-in-use' },
      ],
    })
    await flushPromises()
    const line = w.find('[data-testid="home-tool-claude-code"]')
    expect(line.attributes('data-state')).toBe('unused')
    expect(line.text()).toContain('No device in use')
    expect(w.find('[data-testid="home-tool-connect-claude-cli"]').exists()).toBe(true)
  })

  it('if the devices read fails it says it could not check and still offers Connect; never "not connected"', async () => {
    const { w, refresh } = mountStrip({ error: new Error('boom') })
    await flushPromises()
    expect(w.find('[data-testid="home-tool-status-error"]').text()).toContain("Couldn't check your tools")
    expect(w.text()).not.toContain('Not connected')
    expect(w.find('[data-testid="home-tool-connect-copilot-cli"]').exists()).toBe(true)
    await w.find('[data-testid="home-tool-status-retry"]').trigger('click')
    expect(refresh).toHaveBeenCalled()
  })

  it('draws a line only for clients this deployment enables', async () => {
    const { w } = mountStrip({ instances: [] }, [
      { tool: 'claude-code', enabled: true },
      { tool: 'copilot-cli', enabled: false },
    ])
    await flushPromises()
    expect(w.find('[data-testid="home-tool-claude-code"]').exists()).toBe(true)
    expect(w.find('[data-testid="home-tool-copilot-cli"]').exists()).toBe(false)
  })
})
