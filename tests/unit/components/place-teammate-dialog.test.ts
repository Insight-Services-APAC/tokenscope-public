// @vitest-environment happy-dom
/*
 * PlaceTeammateDialog — the four things a person must be able to read before
 * they restate somebody else's recorded usage.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * The owner ran a real correction on Dev, approved eleven thousand dollars
 * moving, and asked "how do I know if it worked?". Everything downstream of that
 * question — the figure, where the money is leaving, the collapse warning, the
 * receipt — is COPY DRIVEN BY STATE, and none of it had a test. The browser walk
 * captures what one state looks like; this pins the branches, including the two
 * a walk cannot easily stage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PlaceTeammateDialog from '../../../app/components/admin/PlaceTeammateDialog.vue'

const TO = 'bu-target'

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(PlaceTeammateDialog, {
    props: {
      open: true,
      teammateId: 'tm-1',
      teammateLabel: 'kaito@x.test',
      toUnitId: TO,
      toUnitName: 'APAC · CTO',
      ...props,
    },
  })
}

/** Tick the history box and run the check, with `$fetch` stubbed to `span`. */
async function check(wrapper: ReturnType<typeof mountDialog>, span: unknown) {
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(span))
  await wrapper.find('[data-testid="pt-move-history"]').setValue(true)
  await wrapper.find('[data-testid="pt-check"]').trigger('click')
  await flushPromises()
  return wrapper.find('[data-testid="pt-span"]').text().replace(/\s+/g, ' ')
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('what the operator is shown before they agree', () => {
  it('leads with the AMOUNT, and names the Business Unit losing it', async () => {
    const wrapper = mountDialog()
    const text = await check(wrapper, {
      usd: 15037.53,
      spansMultipleUnits: false,
      sources: [
        { orgUnitId: 'bu-aiad', displayName: 'APAC · AI Apps & Data', usd: 15037.53, firstDay: '2026-05-27', lastDay: '2026-08-10' },
      ],
    })

    expect(text).toContain('$15,037.53')
    // A single source used to render nothing at all: the operator saw what they
    // were gaining and not what was losing it — the BU whose owner will notice.
    expect(text).toContain('from')
    expect(text).toContain('APAC · AI Apps & Data')
    // Recorded DAYS render in UTC and are never converted: they are provider
    // facts bucketed by UTC day, and the viewer's zone would slide half of them
    // to the previous date.
    expect(text).toContain('27 May 2026')
    expect(text).toContain('10 Aug 2026')
  })

  it('EXCLUDES money already on the destination from the headline', async () => {
    /*
     * The write skips rows already on the target, so counting them would tell an
     * operator $1,000 is moving when $100 will.
     */
    const wrapper = mountDialog()
    const text = await check(wrapper, {
      usd: 1000,
      spansMultipleUnits: true,
      sources: [
        { orgUnitId: 'bu-old', displayName: 'Old BU', usd: 100, firstDay: '2026-01-01', lastDay: '2026-01-02' },
        { orgUnitId: TO, displayName: 'APAC · CTO', usd: 900, firstDay: '2026-01-01', lastDay: '2026-01-02' },
      ],
    })

    expect(text).toContain('$100.00')
    expect(text).not.toContain('$1,000.00')
  })

  it('warns when several Business Units of history would become one', async () => {
    const wrapper = mountDialog()
    await check(wrapper, {
      usd: 300,
      spansMultipleUnits: true,
      sources: [
        { orgUnitId: 'a', displayName: 'Alpha', usd: 200, firstDay: '2026-01-01', lastDay: '2026-02-01' },
        { orgUnitId: 'b', displayName: 'Beta', usd: 100, firstDay: '2026-03-01', lastDay: '2026-04-01' },
      ],
    })

    const warn = wrapper.find('[data-testid="pt-span-warning"]')
    expect(warn.exists()).toBe(true)
    // Right for a correction, wrong for somebody who really did change team —
    // and only the operator knows which, so the copy must not decide for them.
    expect(warn.text()).toMatch(/Right if it was mis-placed/)
    expect(warn.text()).toMatch(/From date/)
  })

  it('says nothing alarming when ONE Business Unit is the source', async () => {
    const wrapper = mountDialog()
    await check(wrapper, {
      usd: 200,
      spansMultipleUnits: false,
      sources: [{ orgUnitId: 'a', displayName: 'Alpha', usd: 200, firstDay: '2026-01-01', lastDay: '2026-02-01' }],
    })
    expect(wrapper.find('[data-testid="pt-span-warning"]').exists()).toBe(false)
  })

  it('says so when the attributed usage is already on the destination', async () => {
    const wrapper = mountDialog()
    const text = await check(wrapper, {
      usd: 900,
      spansMultipleUnits: false,
      sources: [{ orgUnitId: TO, displayName: 'APAC · CTO', usd: 900, firstDay: '2026-01-01', lastDay: '2026-01-02' }],
    })
    expect(text).toMatch(/already on/)
  })

  it('an EMPTY history does not claim the usage was already on the destination', async () => {
    /*
     * `{ usd: 0, sources: [] }` means there is no recorded usage at all, which
     * is a different fact from "it is already here" — and the branch had no
     * test, so its copy could say either.
     */
    const wrapper = mountDialog()
    const text = await check(wrapper, { usd: 0, spansMultipleUnits: false, sources: [] })
    expect(text).toMatch(/No attributed usage/)
    expect(text).not.toMatch(/already on/)
  })

  it('never promises that NOTHING will happen — the write reaches the bill rows too', async () => {
    /*
     * The preview is §A (`v_complete_usage`). The write also re-homes
     * `actual_spend` and `reconciliation_record`, which this figure cannot see,
     * so "nothing left to move" was a guarantee the code does not deliver.
     */
    const wrapper = mountDialog()
    const onTarget = await check(wrapper, {
      usd: 900,
      spansMultipleUnits: false,
      sources: [{ orgUnitId: TO, displayName: 'APAC · CTO', usd: 900, firstDay: '2026-01-01', lastDay: '2026-01-02' }],
    })
    expect(onTarget).not.toMatch(/nothing left to move/i)
    expect(onTarget).toMatch(/bill rows/)
  })

  it('a positive amount below a cent never renders as $0.00', async () => {
    const wrapper = mountDialog()
    const text = await check(wrapper, {
      usd: 0.004,
      spansMultipleUnits: false,
      sources: [{ orgUnitId: 'a', displayName: 'Alpha', usd: 0.004, firstDay: '2026-01-01', lastDay: '2026-01-01' }],
    })
    expect(text).toContain('< $0.01')
    expect(text).not.toMatch(/\$0\.00 /)
  })

  it('a preview that lands AFTER the range changed is discarded', async () => {
    /*
     * Check January, switch From to August before the answer returns, and the
     * late January figure would paint itself beside an August range — then ride
     * out with the confirm as the amount the operator approved.
     */
    const wrapper = mountDialog()
    let release: (v: unknown) => void = () => {}
    vi.stubGlobal('$fetch', vi.fn().mockReturnValue(new Promise((r) => { release = r })))
    await wrapper.find('[data-testid="pt-move-history"]').setValue(true)
    await wrapper.find('[data-testid="pt-check"]').trigger('click')

    // The operator changes their mind while it is in flight.
    await wrapper.find('[data-testid="pt-from"]').setValue('2026-08-01')
    release({ usd: 999, spansMultipleUnits: false, sources: [{ orgUnitId: 'a', displayName: 'Stale', usd: 999, firstDay: '2026-01-01', lastDay: '2026-01-31' }] })
    await flushPromises()

    expect(wrapper.find('[data-testid="pt-span"]').exists()).toBe(false)
    // And with no span, the confirm is not available — so the stale figure can
    // never become the approved one.
    expect(wrapper.find('[data-testid="pt-confirm"]').attributes('disabled')).toBeDefined()
  })
})

describe('the same-unit repair', () => {
  it('does not promise a move that will not happen', async () => {
    const wrapper = mountDialog({ sameUnit: true })
    const text = wrapper.text().replace(/\s+/g, ' ')
    expect(text).toContain('Repair history')
    expect(text).toContain('Their placement will not change')
    expect(text).not.toContain('Moving to')
  })

  it('offers ONLY the repair — confirming without it would write nothing', async () => {
    const wrapper = mountDialog({ sameUnit: true })
    const confirm = wrapper.find('[data-testid="pt-confirm"]')
    expect(confirm.attributes('disabled')).toBeDefined()

    await check(wrapper, { usd: 10, spansMultipleUnits: false, sources: [{ orgUnitId: 'a', displayName: 'A', usd: 10, firstDay: '2026-01-01', lastDay: '2026-01-01' }] })
    expect(wrapper.find('[data-testid="pt-confirm"]').attributes('disabled')).toBeUndefined()
  })
})

describe('applying', () => {
  it('cannot be applied before the check has run', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-testid="pt-move-history"]').setValue(true)
    expect(wrapper.find('[data-testid="pt-confirm"]').attributes('disabled')).toBeDefined()
  })

  it('carries the APPROVED figure out with the confirm, for the receipt', async () => {
    /*
     * The server responds with row counts. "189 records" does not answer the
     * question the operator actually has, which is about the money they were
     * shown — so the figure they agreed to travels with the decision.
     */
    const wrapper = mountDialog()
    await check(wrapper, {
      usd: 500,
      spansMultipleUnits: false,
      sources: [{ orgUnitId: 'a', displayName: 'Alpha', usd: 500, firstDay: '2026-01-01', lastDay: '2026-02-01' }],
    })
    await wrapper.find('[data-testid="pt-confirm"]').trigger('click')

    const [payload] = wrapper.emitted('confirm')![0] as [
      { rehome?: unknown; previewedUsd?: number; previewedRangeUsd?: number },
    ]
    expect(payload.rehome).toEqual({ from: 'all' })
    expect(payload.previewedUsd).toBeCloseTo(500, 2)
    expect(payload.previewedRangeUsd).toBeCloseTo(500, 2)
  })

  it('carries the RANGE total too — 0 approved cannot tell "none" from "already here"', async () => {
    /*
     * Both cases send `previewedUsd: 0`. Only the range total distinguishes
     * "there is no recorded usage" from "all of it is already on the target",
     * and the receipt says one of those two sentences.
     */
    const wrapper = mountDialog()
    await check(wrapper, {
      usd: 900,
      spansMultipleUnits: false,
      sources: [{ orgUnitId: TO, displayName: 'APAC · CTO', usd: 900, firstDay: '2026-01-01', lastDay: '2026-01-02' }],
    })
    await wrapper.find('[data-testid="pt-confirm"]').trigger('click')

    const [payload] = wrapper.emitted('confirm')![0] as [{ previewedUsd?: number; previewedRangeUsd?: number }]
    expect(payload.previewedUsd).toBe(0)
    expect(payload.previewedRangeUsd).toBeCloseTo(900, 2)
  })

  it('a placement-only confirm carries no rehome at all', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-testid="pt-confirm"]').trigger('click')
    const [payload] = wrapper.emitted('confirm')![0] as [{ rehome?: unknown }]
    expect(payload.rehome).toBeUndefined()
  })
})
