/*
 * Every inbox alert says what happened and takes you to the fix (#573).
 *
 * The class gate: it reads KNOWN_INBOX_CATEGORIES (every kind the server
 * writes, itself checked against server/notifications/dispatch.ts by
 * tests/unit/shared/inbox-categories.test.ts) and fails if a kind has no body,
 * no destination, or a developer kind that points into /admin.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { KNOWN_INBOX_CATEGORIES } from '../../../shared/inbox/categories'
import { itemSubject, variantForCategory } from '../../../app/components/inbox/types'
import {
  ADMIN_ROUTED_KINDS,
  MISSING,
  NO_FIX_SCREEN,
  PRIMARY_DESTINATION,
  drawerCopy,
  opsConditionMeaning,
  primaryAction,
  roughDuration,
} from '../../../app/components/inbox/drawer-copy'
import { COVERAGE_STATE_WORDS } from '../../../shared/inbox/coverage-states'
import DrawerBodySections from '../../../app/components/inbox/DrawerBodySections.vue'
import DrawerBodyNearlyUsed from '../../../app/components/inbox/DrawerBodyNearlyUsed.vue'
import { projectedMonthEnd } from '../../../app/composables/useRagState'
import { fmtUsd } from '../../../app/composables/useFormat'

const ROOT = resolve(__dirname, '../../..')
const withTargets = (category: string) => ({
  category,
  target_allocation_id: '9a1e0000-0000-4000-8000-000000000001',
  target_project_code: 'ACME-1',
})

describe('every inbox kind has a body and a way forward', () => {
  it.each(KNOWN_INBOX_CATEGORIES.map((c) => [c]))('%s has a body', (category) => {
    expect(variantForCategory(category)).not.toBe('unknown')
    if (variantForCategory(category) === 'sections') {
      expect(drawerCopy({ category, body: {} })?.sections.length ?? 0).toBeGreaterThanOrEqual(2)
    }
  })

  it.each(KNOWN_INBOX_CATEGORIES.map((c) => [c]))('%s has a primary destination', (category) => {
    const where = PRIMARY_DESTINATION[category]
    expect(where).toBeDefined()
    if (where === 'footer') expect(primaryAction(withTargets(category))).not.toBeNull()
    if (where === 'in-body') expect(primaryAction(withTargets(category))).toBeNull()
    if (where === 'none') expect(NO_FIX_SCREEN[category], `${category} has no fix screen but no reason`).toBeTruthy()
  })

  it('a kind a developer receives never sends them to /admin', () => {
    for (const category of KNOWN_INBOX_CATEGORIES) {
      if (ADMIN_ROUTED_KINDS.has(category)) continue
      const a = primaryAction(withTargets(category))
      if (a) expect(a.to, category).not.toMatch(/^\/admin/)
    }
  })

  it('the developer kinds go where #573 says', () => {
    expect(primaryAction(withTargets('project-ending-soon'))).toEqual({ label: 'Open project', to: '/projects/ACME-1' })
    expect(primaryAction({ ...withTargets('project-ending-soon'), target_project_code: null })?.to).toBe('/projects')
    expect(primaryAction(withTargets('project-ended-retag'))).toEqual({ label: 'Re-tag in the worklist', to: '/#worklist' })
    for (const c of ['went-silent', 'untagged-backlog', 'reconciliation-gap']) {
      expect(primaryAction(withTargets(c))).toEqual({ label: 'Open my devices', to: '/account#your-devices' })
    }
    expect(primaryAction(withTargets('velocity-warning'))?.to).toBe('/usage')
  })

  it('every admin kind is a known kind', () => {
    for (const c of ADMIN_ROUTED_KINDS) expect(KNOWN_INBOX_CATEGORIES).toContain(c)
  })
})

describe('a missing field reads "not recorded on this alert", never blank or $0.00', () => {
  const sectionKinds = KNOWN_INBOX_CATEGORIES.filter((c) => variantForCategory(c) === 'sections')
  it.each(sectionKinds.map((c) => [c]))('%s with an empty body', (category) => {
    const copy = drawerCopy({ category, body: {} })!
    const text = [...copy.sections.map((s) => s.text ?? s.steps?.map((x) => x.text).join(' ') ?? ''), copy.footnote ?? ''].join(' ')
    expect(text).not.toMatch(/\$0\.00|undefined|null|NaN|—/)
    // Every kind's "What happened" quotes at least one figure or name.
    if (copy.sections[0]!.text!.includes('{')) throw new Error('unfilled placeholder')
  })

  it('the silent-device body names the device and the steps', () => {
    const w = mount(DrawerBodySections, {
      props: { category: 'went-silent', body: { instanceId: '7f3a91c2-0000-4000-8000-000000000001', detectedAt: '2026-11-06T04:20:00Z' } },
    })
    expect(w.text()).toContain('Your device 7f3a91c2 stopped sending usage')
    expect(w.text()).toContain('/tokenscope:status')
    expect(w.text()).toContain('/tokenscope:setup')
    expect(w.find('[data-testid="drawer-footnote"]').text()).toContain('closes by itself')
  })

  it('a missing device id renders the missing line', () => {
    const w = mount(DrawerBodySections, { props: { category: 'went-silent', body: {} } })
    expect(w.text()).toContain(`Your device ${MISSING}`)
  })

  it('the project-ending body shows the end date as a UTC day', () => {
    const copy = drawerCopy({ category: 'project-ending-soon', body: { project: 'HERON', endDate: '2026-11-30 00:00:00+00', daysRemaining: 5 } })!
    expect(copy.sections[0]!.text).toBe('Project HERON ends on 30 Nov 2026 (UTC), 5 days from when this alert was sent.')
  })

  it('"Usage not recorded" says what its producer measures: provider spend no session accounts for, never "untagged" or "lost"', () => {
    const copy = drawerCopy({ category: 'untagged-backlog', body: { anthropic_actual_usd: 200, otel_attributed_usd: 150, gap_pct: 0.25 } })!
    expect(copy.sections[0]!.text).toBe(
      'Anthropic reports $200.00 of Claude usage for you this month. Sessions from your devices account for $150.00 of it, so 25% is spend the provider reported that no session from your devices accounts for.',
    )
    const all = copy.sections.map((x) => x.text ?? '').join(' ')
    expect(all).not.toMatch(/untagged|lost/i)
  })
})

describe('the dead references are gone from app/', () => {
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(vue|ts)$/.test(p)) files.push(p)
    }
  }
  walk(join(ROOT, 'app'))
  it.each([["aren't laid out yet"], ['tokenscope:claim'], ['Spill listing'], ['rollup view']])('"%s" appears nowhere in app/', (needle) => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(needle))
    expect(hits).toEqual([])
  })
})

describe('Budget nearly used (#575)', () => {
  const body = { project: 'FALCON', usedUsd: 4100, capUsd: 5000, dayOfMonth: 10, daysInMonth: 30, month: '2026-11' }

  it('shows used against budget and the same pace figure My projects computes', () => {
    const w = mount(DrawerBodyNearlyUsed, { props: { body } })
    expect(w.find('[data-testid="nearly-used-spend"]').text()).toBe('$4,100.00')
    expect(w.find('[data-testid="nearly-used-of"]').text()).toContain('of $5,000.00')
    expect(w.find('[data-testid="nearly-used-of"]').text()).toContain('day 10 of 30')
    const pace = w.find('[data-testid="nearly-used-pace"]').text()
    expect(pace).toContain('On pace to exceed')
    expect(pace).toContain(`on pace for about ${fmtUsd(projectedMonthEnd(4100, 10, 30), { whole: true })} by 30 Nov`)
    expect(w.text()).toContain('Nothing is blocked')
  })

  it('has no pace line before PACE_MIN_DAYS', () => {
    const w = mount(DrawerBodyNearlyUsed, { props: { body: { ...body, dayOfMonth: 2 } } })
    expect(w.find('[data-testid="nearly-used-pace"]').exists()).toBe(false)
    expect(w.find('[data-testid="nearly-used-too-early"]').exists()).toBe(true)
  })

  it('a missing figure reads the missing line', () => {
    const w = mount(DrawerBodyNearlyUsed, { props: { body: {} } })
    expect(w.find('[data-testid="nearly-used-spend"]').text()).toBe(MISSING)
    expect(w.text()).not.toContain('$0.00')
  })
})

describe('the drawer footer (#573)', () => {
  const stubs = {
    UiBadge: { template: '<span><slot /></span>' },
    UiButton: { props: ['to'], template: '<button :data-to="to"><slot /></button>' },
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  }
  const item = (category: string) => ({
    id: '9a1e0000-0000-4000-8000-0000000000a1',
    category,
    severity: 'attention' as const,
    subject: 's',
    body: {},
    related_entity_kind: null,
    related_entity_id: null,
    target_allocation_id: null,
    target_project_code: null,
    ack_state: 'read' as const,
    ack_at: null,
    created_at: '2026-11-10T00:00:00Z',
  })
  const mountDrawer = async (category: string, viewerIsAdmin?: boolean) => {
    const { default: InboxDrawer } = await import('../../../app/components/inbox/InboxDrawer.vue')
    return mount(InboxDrawer, { props: { item: item(category), viewerIsAdmin }, global: { stubs } })
  }

  it('a developer kind gets its button and keeps Resolve', async () => {
    const w = await mountDrawer('went-silent')
    expect(w.find('[data-testid="drawer-action-primary"]').attributes('data-to')).toBe('/account#your-devices')
    expect(w.find('[data-testid="drawer-action-primary"]').text()).toContain('Open my devices')
    expect(w.find('[data-testid="drawer-action-resolve"]').exists()).toBe(true)
  })

  it('an admin page is offered only to an admin', async () => {
    expect((await mountDrawer('read-path-stale', false)).find('[data-testid="drawer-action-primary"]').exists()).toBe(false)
    const admin = await mountDrawer('read-path-stale', true)
    expect(admin.find('[data-testid="drawer-action-primary"]').attributes('data-to')).toBe('/admin/diagnostics')
  })

  it('a budget alert keeps Resolve beside Add top-up (no budget alert closes by itself)', async () => {
    const { default: InboxDrawer } = await import('../../../app/components/inbox/InboxDrawer.vue')
    const w = mount(InboxDrawer, {
      props: { item: { ...item('budget-nearly-used'), target_allocation_id: '9a1e0000-0000-4000-8000-0000000000f1' } },
      global: { stubs },
    })
    expect(w.find('[data-testid="drawer-action-add-topup"]').exists()).toBe(true)
    expect(w.find('[data-testid="drawer-action-resolve"]').exists()).toBe(true)
  })

  it('keeps its header: the severity badge has its colour and the close button is there', async () => {
    const { default: InboxDrawer } = await import('../../../app/components/inbox/InboxDrawer.vue')
    const w = mount(InboxDrawer, {
      props: { item: item('went-silent') },
      global: { stubs: { ...stubs, UiBadge: { props: ['kind'], template: '<span :data-kind="kind"><slot /></span>' } } },
    })
    expect(w.find('[data-kind="hunger"]').text()).toBe('attention')
    expect(w.find('[data-testid="drawer-close"]').exists()).toBe(true)
  })

  it('an unknown kind says it comes from a newer version', async () => {
    const w = await mountDrawer('brand-new-kind')
    expect(w.find('[data-testid="drawer-unknown-kind"]').text()).toContain('newer version of TokenScope')
  })

  it('the Acknowledge tooltip no longer claims to clear the bell', async () => {
    const w = await mountDrawer('velocity-warning')
    expect(w.find('[data-testid="drawer-action-snooze"]').attributes('title')).toBe('Marks it seen and keeps it open until resolved.')
  })
})

describe('external review fixes: copy says only what the producer measured', () => {
  it('ops-alert does not claim ops-channel delivery; over-attribution does not claim admins are told', () => {
    expect(JSON.stringify(drawerCopy({ category: 'ops-alert', body: { condition: 'worker:x', severity: 'warning' } }))).not.toMatch(/ops channel/)
    expect(JSON.stringify(drawerCopy({ category: 'over-attribution', body: {} }))).not.toMatch(/[Aa]dmins are told/)
  })

  it('an org-name-mismatch Copilot alert says the names did not match, not that a licence charge is missing', () => {
    const t = drawerCopy({ category: 'copilot-bill-unsettled', body: { kind: 'org-name-mismatch', enterprise: 'acme', month: '2026-10-01' } })!.sections[0]!.text!
    expect(t).toContain('match an organisation registered in TokenScope')
    expect(t).not.toContain('licence charge')
  })

  it('owed bills have no fix screen, and the copy says so', () => {
    expect(PRIMARY_DESTINATION['connector-health']).toBe('none')
    expect(primaryAction(withTargets('connector-health'))).toBeNull()
    expect(drawerCopy({ category: 'connector-health', body: { count: 2, grace_days: 7 } })!.sections[1]!.text).toContain('No screen in TokenScope lists the waiting bills yet')
  })

  it('the status steps name both tools', () => {
    const steps = drawerCopy({ category: 'went-silent', body: {} })!.sections.find((x) => x.steps)!.steps!
    expect(steps.map((s) => `${s.text} ${s.after ?? ''}`).join(' ')).toMatch(/GitHub Copilot CLI/)
  })

  it('the 80% body tells a member to ask, and a manager to top up', () => {
    const body = { usedUsd: 85, capUsd: 100, dayOfMonth: 10, daysInMonth: 30, month: '2026-11' }
    expect(mount(DrawerBodyNearlyUsed, { props: { body } }).find('[data-testid="nearly-used-member"]').exists()).toBe(true)
    expect(mount(DrawerBodyNearlyUsed, { props: { body, canTopUp: true } }).find('[data-testid="nearly-used-can-top-up"]').exists()).toBe(true)
  })
})

/* #576: the silent-device alert names the device as its owner named it. */
describe('the silent-device alert uses the device name (#576)', () => {
  const body = { instanceId: '7f3a91c2-0000-4000-8000-000000000001', detectedAt: '2026-11-06T04:20:00Z' }
  it('names the device when the recipient has named it', () => {
    const w = mount(DrawerBodySections, { props: { category: 'went-silent', body, deviceName: 'Home desktop' } })
    expect(w.text()).toContain('Your device Home desktop stopped sending usage')
    expect(w.text()).not.toContain('7f3a91c2')
  })
  it('falls back to the short id when it has no name', () => {
    const w = mount(DrawerBodySections, { props: { category: 'went-silent', body, deviceName: null } })
    expect(w.text()).toContain('Your device 7f3a91c2 stopped sending usage')
  })
})

/* #587: six copy fixes from the sprint 1 design check. */
describe('inbox copy fixes (#587)', () => {
  it('Device behind: the gap reads as a rounded duration, with no raw id, runbook path or em dash', () => {
    const copy = drawerCopy({
      category: 'attribution-gap',
      body: {
        teammate: 'Alex',
        instance_id: '7f3a91c2-0000-4000-8000-000000000001',
        gap_hours: 78.74,
        hint: 'joiner fault (ours) — see docs/development/joiner-dead-zone-recovery.md; HTTP 204',
      },
    })!
    const all = JSON.stringify(copy)
    expect(copy.sections[0]!.text).toContain('about 3 days older')
    // A short id, so two devices can be told apart; no bracketed raw id.
    expect(copy.sections[0]!.text).toContain("Alex's device 7f3a91c2 took")
    expect(copy.sections[0]!.text).not.toContain('(7f3a91c2')
    expect(all).not.toContain('docs/development')
    expect(all).not.toMatch(/ours|theirs|HTTP 204|—/)
    expect(copy.detail).toBeUndefined()
    const todo = copy.sections.find((x) => x.heading === 'What to do')!
    expect(todo.steps![0]!.text).toContain('Diagnose')
    expect(todo.steps![1]!.text).toContain('re-read')
    expect(todo.steps![1]!.text).toContain('needs the Admin role; a Region admin cannot')
  })

  it('roughDuration rounds hours and days', () => {
    expect(roughDuration(0.4)).toBe('under an hour')
    expect(roughDuration(1)).toBe('about 1 hour')
    expect(roughDuration(5.4)).toBe('about 5 hours')
    expect(roughDuration(78.74)).toBe('about 3 days')
    expect(roughDuration(null)).toBe(MISSING)
  })

  it('Service alert: What it means says what the condition means, never only "where to start"', () => {
    for (const condition of ['telemetry-read', 'attribution-stall', 'worker-fleet', 'probe-network', 'worker-duration', 'telemetry-cap', 'worker:budget-alert']) {
      const means = drawerCopy({ category: 'ops-alert', body: { condition, severity: 'warning' } })!.sections[1]!.text!
      expect(means).not.toMatch(/where to start/i)
      expect(means).toBe(opsConditionMeaning(condition))
    }
    expect(opsConditionMeaning('worker:budget-alert')).toContain('budget-alert')
    // Only what each condition measures: a trigger wait is not a server deadline,
    // and a stall can fire when arrivals could not be measured.
    expect(opsConditionMeaning('worker-duration')).toContain('can still finish')
    expect(opsConditionMeaning('attribution-stall')).toContain('cannot be measured')
    expect(opsConditionMeaning('attribution-stall')).not.toContain('still')
  })

  it('GitHub coverage lost: the body states the same state as the title, with no "cost-owning-unit"', () => {
    for (const [state, words] of Object.entries(COVERAGE_STATE_WORDS)) {
      const happened = drawerCopy({ category: 'github-coverage-gap', body: { org: 'acme', enterpriseExternalId: 'ent', state } })!.sections[0]!.text!
      expect(happened).toBe(`GitHub organisation acme in enterprise ent is ${words}.`)
      expect(happened).not.toMatch(/cost-owning/i)
    }
    expect(COVERAGE_STATE_WORDS['not-onboarded']).toBe('installed, but has no Business Unit to bill to')
  })

  it('the coverage alert title is built from the same words (one source)', () => {
    const src = readFileSync(resolve(__dirname, '../../../server/reconciliation/coverage-alerts.ts'), 'utf8')
    expect(src).toContain('coverageOrgGapSubject(org, ent.externalId, state)')
    expect(src).not.toMatch(/cost-owning-unit home/)
    expect(src).not.toContain('Reconciliation ->')
  })

  it('an alert stored before the wording fix reads the current title and no stale hint (#591)', () => {
    const stored = {
      category: 'github-coverage-gap',
      subject: "GitHub org 'acme' (ent) is installed but missing a cost-owning-unit home",
      body: {
        kind: 'org-gap',
        org: 'acme',
        enterpriseExternalId: 'ent',
        state: 'not-onboarded',
        hint: 'Open the Coverage column on the admin Reconciliation -> Providers tab for a remediation action (Edit / Discover / Delete / Recheck).',
      },
    }
    expect(itemSubject(stored)).toBe("GitHub org 'acme' (ent) is installed, but has no Business Unit to bill to")
    const copy = drawerCopy(stored)!
    expect(copy.detail).toBeUndefined()
    expect(copy.sections[1]!.text).toContain('Coverage column under Admin, Reconciliation, Providers')
    expect(JSON.stringify(copy)).not.toContain('->')
    // Other items keep the subject the server stored.
    expect(itemSubject({ category: 'went-silent', subject: 'A device went silent', body: {} })).toBe('A device went silent')
    // A capability-loss alert keeps its stored title (no state words in it).
    expect(itemSubject({ category: 'github-coverage-gap', subject: 'stored', body: { kind: 'capability-loss' } })).toBe('stored')
  })

  it('instants in drawer copy use the product format, not toLocaleString', () => {
    const text = drawerCopy({ category: 'went-silent', body: { instanceId: 'x', detectedAt: '2026-11-06T04:20:00Z' } })!.sections[0]!.text!
    expect(text).toMatch(/at \d{1,2} Nov 2026, \d{2}:\d{2}:/)
  })
})
