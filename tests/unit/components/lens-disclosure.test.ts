// @vitest-environment happy-dom
/*
 * MeLensDisclosure — the declared-personal disclosure (ADR 0012 decisions 5 and
 * 5a), mounted on its own so every branch of the per-tool classification is
 * reachable without a page fixture in the way.
 *
 * The component under test is the `dot` variant: the (i) on /usage's lane
 * toggle. It replaced the "What is and is not chargeable" CARD (owner ruling
 * 2026-08-05) — same per-tool classification, same three defects guarded
 * below, one line per sentence instead of a four-line paragraph, behind an
 * affordance instead of in the page body. Only the card's three-scalar row and
 * its declared-at date did not come across; the scalars are the /usage hero
 * tiles' job and the date is on /account, which this popover links to.
 *
 * Three defects are pinned here, each of which shipped once:
 *
 *   1. ANY declaration masked EVERY gap. The warning was gated on
 *      `declarations.length` while the gap was a single account-wide boolean
 *      aggregated across all tools, so a declared Claude subscription hid an
 *      undeclared Copilot over-emission entirely. The classification is now per
 *      tool and both sentences render together.
 *   2. The review promise ignored the detector's settled-bill window. The copy
 *      said such days "are raised for review on your dashboard" while the
 *      detector deliberately does not raise anything for the trailing days. The
 *      promise is now made only for a tool that actually has an open review row.
 *   3. Decision 5a was half built. `gapIsMaterial` correctly returns false at a
 *      provider-reported $0 (an unreconciled org and a quiet month are
 *      indistinguishable) — but the ADR's honest sentence for that case, that
 *      there is no provider record for the month yet, was never written, so the
 *      component rendered NOTHING for a large month against $0.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LensDisclosure from '../../../app/components/me/LensDisclosure.vue'

type ToolGapState = 'declared' | 'material_gap' | 'provider_record_missing' | 'nothing_to_disclose'

const gap = (
  tool: string,
  label: string,
  state: ToolGapState,
  over: { attributed?: string; reported?: string; has_open_review?: boolean } = {},
) => ({
  tool,
  label,
  attributed_usage_usd: over.attributed ?? '6846.35',
  provider_reported_usd: over.reported ?? '1449.70',
  state,
  has_open_review: over.has_open_review ?? false,
})

const declaration = (tool = 'claude-code', label = 'Claude Code') => ({
  tool,
  label,
  subscription_type: 'Claude Max 20',
  monthly_cost_usd: '200.00',
  declared_at: '2026-07-30T09:00:00.000Z',
  usage_mtd_usd: '6800.00',
})

const fmtUsd = (n: number | string | null | undefined) =>
  n == null || n === '' || !Number.isFinite(Number(n))
    ? '—'
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const passThrough = (tag: string) => ({ template: `<div data-stub="${tag}"><slot /></div>` })

function mountDisclosure(
  over: Partial<{
    declared_personal: ReturnType<typeof declaration>[]
    tool_gaps: ReturnType<typeof gap>[]
  }> = {},
) {
  return mount(LensDisclosure, {
    props: {
      disclosure: {
        attributed_usage_usd: '6846.35',
        provider_reported_usd: '1449.70',
        chargeable_usd: '6.12',
        declared_personal: [],
        declared_personal_usage_usd: '0.00',
        tool_gaps: [],
        ...over,
      },
    },
    global: {
      mocks: { fmtUsd },
      stubs: {
        // InfoDot is imported by the component, so it mounts REAL — its popover
        // is `v-show`, which keeps the prose in the DOM for these text reads.
        NuxtLink: passThrough('link'),
      },
    },
  })
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('a declaration explains only the tool it names', () => {
  it('a declared Claude subscription does not hide an undeclared Copilot gap', () => {
    /*
     * THE DEFECT. Both facts are true of the same month, and the reader is owed
     * both: the Claude figure is explained, the Copilot figure is not.
     */
    const w = mountDisclosure({
      declared_personal: [declaration()],
      tool_gaps: [
        gap('claude-code', 'Claude Code', 'declared'),
        gap('copilot-cli', 'Copilot', 'material_gap', { has_open_review: true }),
      ],
    })
    expect(w.find('[data-testid="declared-personal-claude-code"]').text()).toContain('Claude Max 20')
    // Guard the guard: the two blocks are about DIFFERENT tools, so a fixture
    // where the declaration and the gap named the same tool would prove nothing.
    const undeclared = w.find('[data-testid="undeclared-gap-copilot-cli"]')
    expect(undeclared.exists()).toBe(true)
    expect(norm(undeclared.text())).toContain(
      'Your Copilot usage this month is materially higher than the provider usage records behind it',
    )
    expect(w.find('[data-testid="undeclared-gap-claude-code"]').exists()).toBe(false)
  })

  it('names the tool in the warning, so the reader knows WHICH one is unexplained', () => {
    const w = mountDisclosure({
      declared_personal: [declaration()],
      tool_gaps: [
        gap('claude-code', 'Claude Code', 'declared'),
        gap('copilot-cli', 'Copilot', 'material_gap'),
      ],
    })
    const text = norm(w.find('[data-testid="undeclared-gap-copilot-cli"]').text())
    expect(text).toContain('Your Copilot usage')
    expect(text).not.toContain('Your Claude Code usage')
  })

  it('renders one warning per unexplained tool', () => {
    const w = mountDisclosure({
      tool_gaps: [
        gap('claude-code', 'Claude Code', 'material_gap'),
        gap('copilot-cli', 'Copilot', 'material_gap'),
      ],
    })
    expect(w.findAll('[data-testid^="undeclared-gap-"]')).toHaveLength(2)
  })

  it('says nothing about a tool the detector would not flag', () => {
    /*
     * The CARD rendered nothing at all here (a page-body block with nothing to
     * say is noise). The (i) still renders — it costs a reader nothing until
     * they open it, and its lead sentence answers "why doesn't my usage
     * cross-charge?", which is a question in every month. What must stay silent
     * is the PER-TOOL claim, and that is what this now pins.
     */
    const w = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'nothing_to_disclose')],
    })
    expect(w.find('[data-testid="undeclared-gap-claude-code"]').exists()).toBe(false)
    expect(w.find('[data-testid="no-provider-record-claude-code"]').exists()).toBe(false)
    expect(w.find('[data-testid="declared-personal-claude-code"]').exists()).toBe(false)
    expect(w.find('[data-testid="lens-disclosure-lead"]').exists()).toBe(true)
  })
})

describe('the review promise is made only when a review exists', () => {
  it('points at the dashboard when this tool has an OPEN review row', () => {
    const w = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'material_gap', { has_open_review: true })],
    })
    expect(norm(w.find('[data-testid="undeclared-gap-claude-code"]').text())).toContain(
      'open for review on your',
    )
  })

  it('promises no review when the detector has raised none', () => {
    /*
     * The detector's settled-bill guard leaves the trailing days unflagged on
     * purpose, so a mismatch made entirely of this week is real AND unraised.
     * The warning still renders — the gap is true — but the promise does not.
     */
    const w = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'material_gap', { has_open_review: false })],
    })
    const text = norm(w.find('[data-testid="undeclared-gap-claude-code"]').text())
    expect(text).toContain('materially higher than the provider usage records')
    expect(text).not.toContain('review')
    // ...and the reader is still given the action that IS available to them.
    expect(norm(w.find('[data-testid="lens-disclosure-declare-cta"]').text())).toContain(
      'declare it on your',
    )
  })

  it('the promise tracks the FLAG, not the gap — same gap, two outcomes', () => {
    // Guard the guard: the only difference between these two mounts is
    // has_open_review, so a component that always promised (or never did) fails.
    const raised = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'material_gap', { has_open_review: true })],
    })
    const unraised = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'material_gap', { has_open_review: false })],
    })
    expect(norm(raised.text())).not.toBe(norm(unraised.text()))
    expect(norm(raised.text()).includes('open for review')).toBe(true)
    expect(norm(unraised.text()).includes('open for review')).toBe(false)
  })
})

describe('a month with no provider record says so (decision 5a)', () => {
  it('states the absence of the record rather than an over-emission story', () => {
    /*
     * $10,000 attributed against $0 reported, undeclared. `gapIsMaterial` is
     * false here by design; before this the component rendered nothing at all.
     */
    const w = mountDisclosure({
      tool_gaps: [
        gap('claude-code', 'Claude Code', 'provider_record_missing', {
          attributed: '10000.00',
          reported: '0.00',
        }),
      ],
    })
    const text = norm(w.find('[data-testid="no-provider-record-claude-code"]').text())
    expect(text).toContain('No provider usage record has arrived for Claude Code this month')
    expect(text).toContain('nothing to reconcile against yet')
    // NOT the over-emission sentence, and NOT a review promise.
    expect(w.find('[data-testid="undeclared-gap-claude-code"]').exists()).toBe(false)
    expect(norm(w.text())).not.toContain('open for review')
  })

  it('renders alongside a declaration on a DIFFERENT tool', () => {
    const w = mountDisclosure({
      declared_personal: [declaration()],
      tool_gaps: [
        gap('claude-code', 'Claude Code', 'declared'),
        gap('copilot-cli', 'Copilot', 'provider_record_missing', { reported: '0.00' }),
      ],
    })
    expect(w.find('[data-testid="declared-personal-claude-code"]').exists()).toBe(true)
    expect(w.find('[data-testid="no-provider-record-copilot-cli"]').exists()).toBe(true)
  })
})

describe('decision 6 — the disclosure never hedges the figure it explains', () => {
  it('carries no notional/provisional language in any branch', () => {
    const w = mountDisclosure({
      declared_personal: [declaration()],
      tool_gaps: [
        gap('claude-code', 'Claude Code', 'declared'),
        gap('copilot-cli', 'Copilot', 'material_gap', { has_open_review: true }),
      ],
    })
    /*
     * The third branch gets its OWN mount, on `claude-code`, rather than riding
     * along as a `copilot-agent` row. copilot-agent is an INGEST_ONLY tool: arm
     * 3 sources its usage FROM the provider record, so attributed usage and a
     * $0 provider record cannot coexist for it and `provider_record_missing` is
     * unreachable in production. Scanning an unreachable row proves nothing
     * about shipped copy. The two OTel emit tools (claude-code, copilot-cli)
     * are the only ones that CAN out-run a $0 provider record.
     */
    const missing = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'provider_record_missing', { reported: '0.00' })],
    })
    const text = `${norm(w.text())} ${norm(missing.text())}`.toLowerCase()
    expect(text).toContain('no provider usage record has arrived')
    for (const hedge of ['notional', 'not real spend', 'hypothetical', 'does not count']) {
      expect(text).not.toContain(hedge)
    }
  })
})

describe('the disclosure never instructs a reader to do something the product refuses', () => {
  /*
   * The declare CTA points at /account#personal-subscription. That picker is
   * Anthropic-only, and PUT /api/v1/me/personal-subscription 400s any tool
   * outside CLAUDE_FAMILY_TOOLS — so telling a Copilot reader to declare one is
   * an instruction with no destination, printed four lines under this card's own
   * sentence saying Copilot has no per-person charge.
   */
  it('a Copilot-only gap gets the sentence and NO declare instruction', () => {
    const w = mountDisclosure({
      tool_gaps: [gap('copilot-cli', 'Copilot', 'material_gap')],
    })
    const undeclared = norm(w.find('[data-testid="undeclared-gap-copilot-cli"]').text())
    expect(undeclared).toContain('Your Copilot usage this month is materially higher')
    // …and NOT the clause that implies a declaration was available to make.
    expect(undeclared).not.toContain('no personal subscription declared')
    expect(w.find('[data-testid="lens-disclosure-declare-cta"]').exists()).toBe(false)
  })

  it('the same gap on a Claude tool DOES get both — the gate is the tool, not the state', () => {
    // Guard the guard: identical state, identical props but for the tool. If
    // this rendered nothing either, the test above would only be proving that
    // material_gap is silent.
    const w = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'material_gap')],
    })
    expect(norm(w.find('[data-testid="undeclared-gap-claude-code"]').text())).toContain(
      'no personal subscription declared for Claude Code',
    )
    expect(w.find('[data-testid="lens-disclosure-declare-cta"]').exists()).toBe(true)
  })

  it('a mixed month keeps the instruction, because one of the tools can carry it', () => {
    const w = mountDisclosure({
      tool_gaps: [
        gap('copilot-cli', 'Copilot', 'material_gap'),
        gap('claude-code', 'Claude Code', 'provider_record_missing', { reported: '0.00' }),
      ],
    })
    expect(w.find('[data-testid="lens-disclosure-declare-cta"]').exists()).toBe(true)
    expect(norm(w.find('[data-testid="undeclared-gap-copilot-cli"]').text())).not.toContain(
      'no personal subscription declared',
    )
  })

  it('promises SOME of the days, not all of them', () => {
    /*
     * `has_open_review` is true when AT LEAST ONE day this month cleared the
     * detector's per-day bar. The gap is a month aggregate, so "the days behind
     * it are open for review" asserted a review of every emitting day — twenty
     * days behind one raised flag.
     */
    const w = mountDisclosure({
      tool_gaps: [gap('claude-code', 'Claude Code', 'material_gap', { has_open_review: true })],
    })
    expect(norm(w.find('[data-testid="undeclared-gap-claude-code"]').text())).toContain(
      'Some of the days behind it are open for review',
    )
  })
})
