/*
 * shared/reports/model-attribution — the NULL-model driver-row key/label/
 * classifier rule after the model-axis subtraction
 * (docs/design/reporting-consolidation/07-model-axis-subtraction-build.md,
 * owner ruling 2026-08-04; mig 0123/0124).
 *
 * What this file pins:
 *   - a real model is always its own key/label, whatever the provenance/reason;
 *   - a NULL-model row is a REMAINDER, keyed by provenance base + reason
 *     suffix so distinct reasons never collide into one row;
 *   - the classifier is DEFAULT-SAFE (design test 20): an unrecognised or
 *     absent reason still classifies as remainder, NEVER as a category/model;
 *   - the notes explain remainders without claiming the provider withholds a
 *     model where the 2026-08-01 capture saw one.
 *
 * MUTATIONS: make `modelBucketKind` return 'model' for an unknown `__` key →
 * the default-safe block goes red; drop the reason suffix from
 * `modelDriverKey` → the distinct-reasons block goes red; label a remainder
 * "Unattributed" → the vocabulary block goes red.
 */
import { describe, it, expect } from 'vitest'
import {
  modelDriverLabel,
  modelDriverKey,
  modelBucketKind,
  modelBucketNote,
  MODEL_GAP_REASONS,
  MODEL_GAP_REASON_LABELS,
  BILLED_NO_MODEL_KEY,
  UNATTRIBUTED_MODEL_LABEL,
  PROVIDER_USAGE_MODEL_LABEL,
  UNATTRIBUTED_MODEL_KEY,
  PROVIDER_USAGE_MODEL_KEY,
} from '../../../shared/reports/model-attribution'
import { isProviderUsageProvenance } from '../../../shared/usage/provenance'

describe('modelDriverLabel', () => {
  it('returns the real model whenever one is present, regardless of provenance or reason', () => {
    expect(modelDriverLabel('claude-sonnet-4-6', 'otel-emitted')).toBe('claude-sonnet-4-6')
    expect(modelDriverLabel('claude-opus-4-6', 'api-reconciled')).toBe('claude-opus-4-6')
    // Arm-3 fan-out rows (mig 0124) are exactly this pair: a NAMED model on
    // provider-usage provenance.
    expect(modelDriverLabel('claude-haiku-4-6', 'provider-usage')).toBe('claude-haiku-4-6')
    // A reason beside a real model (cannot occur — 0124 emits NULL reasons on
    // named rows) must not displace the model.
    expect(modelDriverLabel('claude-opus-5', 'api-reconciled', 'provider-day-grain')).toBe('claude-opus-5')
  })

  it('labels a recognised reason with its own wording', () => {
    expect(modelDriverLabel(null, 'api-reconciled', 'provider-day-grain')).toBe(
      MODEL_GAP_REASON_LABELS['provider-day-grain'],
    )
    expect(modelDriverLabel(null, 'api-reconciled', 'awaiting-provider-detail')).toBe(
      'Awaiting provider detail',
    )
    // Revision drift FOLDS into the awaiting wording (D6) — prefixed, not identical.
    expect(modelDriverLabel(null, 'provider-usage', 'provider-revision-drift')).toMatch(
      /^Awaiting provider detail/,
    )
    expect(modelDriverLabel(null, 'api-reconciled', 'unmodelled-provider-cost')).toBe(
      UNATTRIBUTED_MODEL_LABEL,
    )
    expect(modelDriverLabel(null, 'provider-usage', 'surface-remainder')).toBe(
      PROVIDER_USAGE_MODEL_LABEL,
    )
  })

  it('falls back to the provenance branch on an unknown or absent reason — never a new category', () => {
    expect(modelDriverLabel(null, 'provider-usage')).toBe(PROVIDER_USAGE_MODEL_LABEL)
    expect(modelDriverLabel(null, 'api-reconciled')).toBe(UNATTRIBUTED_MODEL_LABEL)
    expect(modelDriverLabel(null, 'api-reconciled', 'some-future-reason')).toBe(UNATTRIBUTED_MODEL_LABEL)
    expect(modelDriverLabel(null, 'provider-usage', 'some-future-reason')).toBe(PROVIDER_USAGE_MODEL_LABEL)
    expect(modelDriverLabel(null, null)).toBe(UNATTRIBUTED_MODEL_LABEL)
    expect(modelDriverLabel(undefined, undefined)).toBe(UNATTRIBUTED_MODEL_LABEL)
  })

  it('empty-string model is treated as absent (falsy), not as a real model named ""', () => {
    expect(modelDriverLabel('', 'provider-usage')).toBe(PROVIDER_USAGE_MODEL_LABEL)
  })
})

describe('modelDriverKey', () => {
  it('returns the real model as the key whenever one is present', () => {
    expect(modelDriverKey('claude-sonnet-4-6', 'otel-emitted')).toBe('claude-sonnet-4-6')
    expect(modelDriverKey('claude-haiku-4-6', 'provider-usage')).toBe('claude-haiku-4-6')
  })

  it('suffixes the reason so distinct reasons NEVER collide into one driver row', () => {
    // The drivers query groups by (model, provenance, reason) — two
    // same-provenance remainders with different reasons are two rows and need
    // two keys (Vue :key, map lookups).
    const dayGrain = modelDriverKey(null, 'provider-usage', 'provider-day-grain')
    const surface = modelDriverKey(null, 'provider-usage', 'surface-remainder')
    expect(dayGrain).toBe(`${PROVIDER_USAGE_MODEL_KEY}:provider-day-grain`)
    expect(surface).toBe(`${PROVIDER_USAGE_MODEL_KEY}:surface-remainder`)
    expect(dayGrain).not.toBe(surface)
    // …and an UNKNOWN reason still gets its own key rather than folding into
    // the bare base beside a differently-reasoned sibling.
    expect(modelDriverKey(null, 'api-reconciled', 'some-future-reason')).toBe(
      `${UNATTRIBUTED_MODEL_KEY}:some-future-reason`,
    )
  })

  it('keeps the two provenance BASES distinct, reasonless rows included', () => {
    expect(modelDriverKey(null, 'provider-usage')).toBe(PROVIDER_USAGE_MODEL_KEY)
    expect(modelDriverKey(null, 'api-reconciled')).toBe(UNATTRIBUTED_MODEL_KEY)
    expect(PROVIDER_USAGE_MODEL_KEY).not.toBe(UNATTRIBUTED_MODEL_KEY)
  })

  it('every synthetic key wears the "__" sentinel — bare, suffixed, or billed', () => {
    for (const key of [
      UNATTRIBUTED_MODEL_KEY,
      PROVIDER_USAGE_MODEL_KEY,
      BILLED_NO_MODEL_KEY,
      modelDriverKey(null, 'api-reconciled', 'provider-day-grain'),
      modelDriverKey(null, 'provider-usage', 'nonsense'),
    ]) {
      expect(key.startsWith('__')).toBe(true)
    }
  })

  it('label and key agree on WHICH remainder a (model, provenance, reason) triple belongs to', () => {
    const cases: Array<[string | null, string | null, string | null]> = [
      [null, 'provider-usage', null],
      [null, 'api-reconciled', null],
      [null, 'api-reconciled', 'provider-day-grain'],
      [null, 'provider-usage', 'surface-remainder'],
      [null, null, null],
      ['claude-opus-4-6', 'otel-emitted', null],
    ]
    for (const [model, provenance, reason] of cases) {
      const label = modelDriverLabel(model, provenance, reason)
      const key = modelDriverKey(model, provenance, reason)
      if (model) {
        expect(label).toBe(model)
        expect(key).toBe(model)
      } else {
        const base = isProviderUsageProvenance(provenance)
          ? PROVIDER_USAGE_MODEL_KEY
          : UNATTRIBUTED_MODEL_KEY
        expect(key).toBe(reason ? `${base}:${reason}` : base)
        expect(modelBucketKind(key)).toBe('remainder')
        expect(label.startsWith('__')).toBe(false)
      }
    }
  })
})

describe('isProviderUsageProvenance', () => {
  it('is true ONLY for the exact literal "provider-usage"', () => {
    expect(isProviderUsageProvenance('provider-usage')).toBe(true)
    expect(isProviderUsageProvenance('otel-emitted')).toBe(false)
    expect(isProviderUsageProvenance('api-reconciled')).toBe(false)
    expect(isProviderUsageProvenance(null)).toBe(false)
    expect(isProviderUsageProvenance(undefined)).toBe(false)
    expect(isProviderUsageProvenance('')).toBe(false)
  })
})

describe('the remainder vocabulary names what it is, not a defect', () => {
  it('never reads "Unattributed" — that word claims a fixable collection failure', () => {
    /*
     * The subtraction is SANCTIONED now (owner 2026-08-04) and the named rows
     * carry everything that was measured with a model; what is left is a
     * remainder, not a failure. The word check survives the redesign: no
     * remainder label may claim someone forgot to collect something.
     */
    expect(modelDriverLabel(null, 'api-reconciled')).not.toMatch(/unattributed/i)
    expect(UNATTRIBUTED_MODEL_LABEL).not.toMatch(/unattributed/i)
    for (const reason of MODEL_GAP_REASONS) {
      expect(MODEL_GAP_REASON_LABELS[reason]).not.toMatch(/unattributed/i)
    }
  })

  it('still returns the real model when there is one', () => {
    // Guard the guard: a function that returned a label unconditionally would
    // satisfy the assertions above.
    expect(modelDriverLabel('claude-opus-5', 'api-reconciled')).toBe('claude-opus-5')
  })
})

/*
 * The READER's half of the rule (D6). Two kinds only: a row is a rankable
 * MODEL or it is a REMAINDER the coverage footer prices. The old
 * 'structural' / 'not-carried' group bands are retired with the rendering
 * that used them.
 */
describe('modelBucketKind — exhaustive and default-safe (design test 20)', () => {
  it('a real model is rankable; no synthetic key ever is', () => {
    expect(modelBucketKind('claude-opus-5')).toBe('model')
    expect(modelBucketKind('gpt-5.6-sol')).toBe('model')
    for (const key of [BILLED_NO_MODEL_KEY, UNATTRIBUTED_MODEL_KEY, PROVIDER_USAGE_MODEL_KEY]) {
      expect(modelBucketKind(key)).toBe('remainder')
    }
  })

  it('classifies every reason-suffixed key as remainder — the whole vocabulary', () => {
    for (const reason of MODEL_GAP_REASONS) {
      expect(modelBucketKind(modelDriverKey(null, 'api-reconciled', reason))).toBe('remainder')
      expect(modelBucketKind(modelDriverKey(null, 'provider-usage', reason))).toBe('remainder')
    }
  })

  it('an UNRECOGNISED reason still classifies as remainder, never a category', () => {
    // The default-safe direction: a new view reason value must degrade to the
    // footer, not resurrect a pseudo-model row (D6, test 20).
    expect(modelBucketKind(modelDriverKey(null, 'api-reconciled', 'reason-from-the-future'))).toBe(
      'remainder',
    )
    expect(modelBucketKind(`${PROVIDER_USAGE_MODEL_KEY}:whatever`)).toBe('remainder')
    // …and even a synthetic key this module never minted stays out of the ranking.
    expect(modelBucketKind('__some_new_bucket')).toBe('remainder')
  })
})

describe('modelBucketNote', () => {
  it('explains every remainder and nothing else', () => {
    for (const key of [
      BILLED_NO_MODEL_KEY,
      UNATTRIBUTED_MODEL_KEY,
      PROVIDER_USAGE_MODEL_KEY,
      modelDriverKey(null, 'api-reconciled', 'provider-day-grain'),
      modelDriverKey(null, 'api-reconciled', 'awaiting-provider-detail'),
      modelDriverKey(null, 'provider-usage', 'provider-revision-drift'),
      modelDriverKey(null, 'provider-usage', 'surface-remainder'),
      modelDriverKey(null, 'api-reconciled', 'unknown-future-reason'),
    ]) {
      expect(modelBucketNote(key)).toBeTruthy()
    }
    expect(modelBucketNote('claude-opus-5')).toBeNull()
  })

  it('day-grain money is a measurement statement, never a ratio offer', () => {
    const note = modelBucketNote(modelDriverKey(null, 'api-reconciled', 'provider-day-grain'))!
    expect(note).toMatch(/day/i)
    expect(note).toMatch(/ratio, not a measurement/i)
  })

  it('the transient reasons say they heal themselves — they exist for today and yesterday', () => {
    for (const reason of ['awaiting-provider-detail', 'provider-revision-drift'] as const) {
      expect(modelBucketNote(modelDriverKey(null, 'api-reconciled', reason))!).toMatch(/heals itself/i)
    }
  })

  it('never claims the provider withholds a model on the surfaces the capture saw one for', () => {
    // That exact claim was made about the Claude surfaces and the 2026-08-01
    // capture disproved it. The generic remainder note owns the gap instead.
    const note = modelBucketNote(modelDriverKey(null, 'provider-usage', 'surface-remainder'))!
    expect(note).not.toMatch(/provider (does not|doesn't) report/i)
    expect(note).not.toMatch(/no model (dimension|reported)/i)
  })
})
