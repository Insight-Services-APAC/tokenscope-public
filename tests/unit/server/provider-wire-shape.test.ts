// @vitest-environment node
/*
 * Provider wire-shape summariser — pure-function tests.
 *
 * The summariser is the whole point of the feature: it is what turns "we assume
 * the provider sends a model" into "the model was present on 0 of 1,240 rows".
 * Two properties therefore get the most coverage here — the PRESENCE ARITHMETIC
 * (the number the feature exists to produce) and the PRIVACY RULES (the reason
 * this diagnostic is allowed to exist at all).
 *
 * Every test below was verified to FAIL with its rule reverted — see the commit
 * body for the exact mutation applied per test.
 */
import { describe, it, expect } from 'vitest'
import {
  summariseShape,
  compareToBaseline,
  redactRequestParams,
  isSensitivePath,
  isSensitiveValue,
  isNumericShaped,
  containerPathOf,
  MAX_DISTINCT_VALUES,
  PRESENCE_DRIFT_THRESHOLD,
  MONEY_KEY_SUBSTRINGS,
  REDACTED_KEY_SEGMENT,
  type WireShapeBaseline,
  type PathStat,
} from '../../../server/diagnostics/wire-shape'
import enterpriseUsageBaseline from '../../../server/diagnostics/baselines/anthropic-enterprise-user-usage.json'
import enterpriseCostBaseline from '../../../server/diagnostics/baselines/anthropic-enterprise-user-cost.json'
import adminBaseline from '../../../server/diagnostics/baselines/anthropic-admin-claude-code.json'
import githubBaseline from '../../../server/diagnostics/baselines/github-ai-credit-usage.json'
import githubMetricsBaseline from '../../../server/diagnostics/baselines/github-user-daily-credits.json'

const stat = (summary: { paths: PathStat[] }, path: string): PathStat => {
  const found = summary.paths.find((p) => p.path === path)
  if (!found) throw new Error(`no path stat for ${path} (have: ${summary.paths.map((p) => p.path).join(', ')})`)
  return found
}

describe('summariseShape — presence arithmetic', () => {
  it('counts present/total against the CONTAINER, so a field missing from some rows reads below 100%', () => {
    // Three rows; `model` on two of them. This is exactly the shape of the
    // question the feature exists to answer.
    const body = {
      data: [{ model: 'opus' }, { model: 'sonnet' }, {}],
      has_more: false,
    }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    expect(s.itemCount).toBe(3)
    const model = stat(s, 'data[].model')
    expect(model.present).toBe(2)
    expect(model.total).toBe(3)
    expect(model.nulls).toBe(0)
  })

  it('counts nulls separately from absence, and records null as a type', () => {
    const body = { data: [{ model: 'opus' }, { model: null }, {}] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const model = stat(s, 'data[].model')
    // Present 2 (one string, one null); absent once. A null that was counted as
    // absent — or an absence counted as a null — would make the whole report lie.
    expect(model.present).toBe(2)
    expect(model.nulls).toBe(1)
    expect(model.total).toBe(3)
    expect(model.types).toEqual(['null', 'string'])
  })

  it('uses the nested array as the denominator for a doubly-nested path', () => {
    // 2 records, 3 model_breakdown entries in total, `model` on 2 of the 3.
    const body = {
      data: [
        { model_breakdown: [{ model: 'a' }, { model: 'b' }] },
        { model_breakdown: [{}] },
      ],
    }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const model = stat(s, 'data[].model_breakdown[].model')
    expect(model.present).toBe(2)
    // 3 — the number of model_breakdown ELEMENTS, not the 2 records.
    expect(model.total).toBe(3)
  })

  it('reports itemCount 0 when the item array is empty (an empty sample, not an absent field)', () => {
    const s = summariseShape({ data: [], has_more: false }, { itemsPath: 'data[]' })
    expect(s.itemCount).toBe(0)
  })

  it('containerPathOf resolves object, array-element and root parents', () => {
    expect(containerPathOf('data[].model')).toBe('data[]')
    expect(containerPathOf('data[]')).toBe('data')
    expect(containerPathOf('has_more')).toBe('')
  })
})

describe('summariseShape — privacy rules', () => {
  it('lists distinct values for a low-cardinality, non-identifying string field, sorted', () => {
    const body = { data: [{ model: 'sonnet' }, { model: 'opus' }, { model: 'opus' }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    // This is the payoff: learning what the model strings actually look like.
    expect(stat(s, 'data[].model').distinctValues).toEqual(['opus', 'sonnet'])
    expect(stat(s, 'data[].model').valuesWithheld).toBeUndefined()
  })

  it('the key-name denylist BEATS the low-cardinality rule', () => {
    // Two distinct values — trivially low-cardinality — but the key is identity.
    const body = { data: [{ email: 'a@x.test' }, { email: 'b@x.test' }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const email = stat(s, 'data[].email')
    expect(email.distinctValues).toBeUndefined()
    expect(email.valuesWithheld).toBe('denylisted-key')
    // Type + presence counts still flow — that is what the rule permits.
    expect(email.present).toBe(2)
    expect(email.types).toEqual(['string'])
  })

  it('applies the denylist to a NON-LEAF path segment, not just the leaf key', () => {
    // Leaf `type` is innocuous; its parent `actor` is not. A leaf-only check
    // would emit values from inside an identity object.
    const body = { data: [{ actor: { type: 'user_actor' } }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const actorType = stat(s, 'data[].actor.type')
    expect(actorType.distinctValues).toBeUndefined()
    expect(actorType.valuesWithheld).toBe('denylisted-key')
  })

  it('withholds values above the distinct-value cap', () => {
    const rows = Array.from({ length: MAX_DISTINCT_VALUES + 1 }, (_, i) => ({ product: `p${i}` }))
    const s = summariseShape({ data: rows }, { itemsPath: 'data[]' })
    const product = stat(s, 'data[].product')
    expect(product.distinctValues).toBeUndefined()
    expect(product.valuesWithheld).toBe('high-cardinality')
  })

  it('keeps values at exactly the distinct-value cap', () => {
    const rows = Array.from({ length: MAX_DISTINCT_VALUES }, (_, i) => ({ product: `p${i}` }))
    const s = summariseShape({ data: rows }, { itemsPath: 'data[]' })
    expect(stat(s, 'data[].product').distinctValues).toHaveLength(MAX_DISTINCT_VALUES)
  })

  it('withholds an email-shaped value even under a key the denylist does not match', () => {
    // `product` is benign; the VALUE is an address. Defence in depth for the case
    // a provider puts identity under a key nobody thought to denylist.
    const body = { data: [{ product: 'someone@example.test' }, { product: 'claude_code' }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const product = stat(s, 'data[].product')
    expect(product.valuesWithheld).toBe('value-shape')
    // The whole path is poisoned — emitting the survivors would leak "the values
    // that happened not to match a regex".
    expect(product.distinctValues).toBeUndefined()
  })

  /*
   * MONEY, BOTH ENDS. Withholding a cost rests on two independent rules, and each
   * is tested on its own so neither can pass by leaning on the other:
   *   - the KEY rule (MONEY_KEY_SUBSTRINGS), which does not care what notation
   *     the figure arrives in;
   *   - the VALUE rule (isNumericShaped), which catches a figure under a key
   *     nobody denylisted.
   * The value rule is therefore always exercised under a BENIGN key.
   */
  it('withholds a COST by KEY NAME, whatever notation it arrives in', () => {
    // user_cost_report sends `amount` / `list_amount` as fractional-cents decimal
    // STRINGS (centsStringToUsd exists to parse them). Recognising the notation is
    // a second line of defence; the key name is the first, and it does not depend
    // on having predicted the notation.
    const body = { data: [{ amount: '1250.5' }, { amount: '4.25' }, { amount: '-3' }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const amount = stat(s, 'data[].amount')
    expect(amount.types).toEqual(['string'])
    expect(amount.distinctValues).toBeUndefined()
    expect(amount.valuesWithheld).toBe('denylisted-key')
    expect(JSON.stringify(s)).not.toContain('1250.5')
  })

  /*
   * download_links on GitHub's users-1-day metrics report is an array of SIGNED
   * URLs: possessing one IS access to the enterprise's per-user data. These two
   * tests are the reason CAPABILITY_KEY_SUBSTRINGS exists rather than the value
   * rule being left to carry it alone.
   */
  it('withholds a signed download link BY KEY NAME, not by luck of its value shape', () => {
    const body = {
      download_links: [
        'https://objects.githubusercontent.com/copilot-metrics/2026-07-31.ndjson?sig=abc&exp=1',
      ],
      report_day: '2026-07-31',
    }
    const s = summariseShape(body, { itemsPath: 'download_links[]' })
    const links = stat(s, 'download_links[]')
    expect(links.distinctValues).toBeUndefined()
    // The REASON matters as much as the outcome: 'denylisted-key' proves the key
    // rule fired. With 'link' removed from the denylist this same value would
    // still be withheld — as 'value-shape', because it happens to be URL-shaped —
    // and a test asserting only "withheld" would stay green while the intended
    // defence was gone.
    expect(links.valuesWithheld).toBe('denylisted-key')
    expect(JSON.stringify(s)).not.toContain('sig=abc')
    /*
     * `report_day` is withheld too, and NOT because of anything added here: it
     * contains "repo", which the identity list has always carried. That is the
     * documented blunt over-match ("a diagnostic that occasionally withholds a
     * boring enum is strictly better…"), pinned so a later reader does not
     * mistake it for a consequence of the capability list.
     */
    expect(stat(s, 'report_day').valuesWithheld).toBe('denylisted-key')
  })

  it('withholds a download link that no value rule would catch — short, opaque, no scheme', () => {
    // The case the key rule exists for. A shortened or path-relative link is not
    // URL-shaped, is under OPAQUE_MIN_LENGTH, is not email-shaped and is not
    // numeric, so every value rule passes it through. Only the key name stops it.
    const short = 'r/9f2c'
    expect(isSensitiveValue(short)).toBe(false)
    const s = summariseShape({ download_links: [short] }, { itemsPath: 'download_links[]' })
    const links = stat(s, 'download_links[]')
    expect(links.distinctValues).toBeUndefined()
    expect(links.valuesWithheld).toBe('denylisted-key')
    expect(JSON.stringify(s)).not.toContain(short)
  })

  it('withholds a money-keyed field even when its value is not numeric at all', () => {
    // Nothing here is number-shaped, so ONLY the key rule can withhold it. Without
    // the money key names these strings are a two-value low-cardinality dimension
    // and get listed in full.
    const body = { data: [{ total_charge: 'unlimited' }, { total_charge: 'on account' }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const charge = stat(s, 'data[].total_charge')
    expect(charge.distinctValues).toBeUndefined()
    expect(charge.valuesWithheld).toBe('denylisted-key')
    expect(JSON.stringify(s)).not.toContain('unlimited')
  })

  it.each([...MONEY_KEY_SUBSTRINGS])('denylists a key containing %s', (word) => {
    expect(isSensitivePath(`data[].report_${word}_field`)).toBe(true)
  })

  /*
   * The notations a figure can wear. Anthropic sends decimal strings today; the
   * point of the table is that "today" is not the contract, and a value rule that
   * only knows bare decimals lets four of these through under a benign key.
   */
  const MONEY_NOTATIONS: [string, string][] = [
    ['bare decimal', '1250.5'],
    ['negative', '-3'],
    ['explicit sign', '+12.5'],
    ['leading-dot decimal', '.75'],
    // Distinctive digits: a short integer like '0' occurs in every count field,
    // so `not.toContain` on it would pass or fail for reasons unrelated to the rule.
    ['integer', '987654'],
    ['scientific', '1e3'],
    ['scientific with a signed exponent', '1.5E-3'],
    ['currency symbol', '$12.50'],
    ['currency symbol with a space', '$ 12.50'],
    ['trailing currency symbol', '12.50€'],
    ['leading currency code', 'USD 12.50'],
    ['trailing currency code', '12.50 USD'],
    ['thousands separators', '1,234.56'],
    ['accounting negative', '(12.50)'],
    ['accounting negative with symbol and separators', '($1,234.56)'],
    ['surrounding whitespace', '  42.00  '],
  ]

  it.each(MONEY_NOTATIONS)('isNumericShaped recognises money written as %s', (_label, value) => {
    expect(isNumericShaped(value)).toBe(true)
    expect(isSensitiveValue(value)).toBe(true)
  })

  it.each(MONEY_NOTATIONS)('withholds money written as %s under a BENIGN key', (_label, value) => {
    // `product` is on no denylist, so only the value rule can save this.
    const s = summariseShape({ data: [{ product: value }, { product: 'claude_code' }] }, { itemsPath: 'data[]' })
    const product = stat(s, 'data[].product')
    expect(product.valuesWithheld).toBe('value-shape')
    expect(product.distinctValues).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain(value.trim())
  })

  it.each([
    ['a context-window label', '0-200k'],
    ['an open-ended window label', '200k+'],
    ['a model name', 'claude-opus-4'],
    ['a Copilot model name', 'gpt-5-mini'],
    ['a bare currency code', 'USD'],
    ['a date', '2026-07-30'],
    ['a product name', 'claude_code'],
    ['a speed label', 'standard'],
  ])('isNumericShaped does NOT swallow %s', (_label, value) => {
    // Over-matching here would delete the answers the report exists to produce.
    expect(isNumericShaped(value)).toBe(false)
    expect(isSensitiveValue(value)).toBe(false)
  })

  it('a numeric-looking dimension label is still emitted (the cost guard is not a blanket ban)', () => {
    // context_window arrives as '0-200k' — not a bare number, and exactly the
    // kind of dimension the report exists to reveal.
    const body = { data: [{ context_window: '0-200k' }, { context_window: '200k+' }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    expect(stat(s, 'data[].context_window').distinctValues).toEqual(['0-200k', '200k+'])
  })

  it('never emits values for numeric fields, however few distinct values there are', () => {
    // A number on a provider payload can be a person's cost.
    const body = { data: [{ netAmount: 1 }, { netAmount: 1 }, { netAmount: 2 }] }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const amount = stat(s, 'data[].netAmount')
    expect(amount.distinctValues).toBeUndefined()
    expect(amount.valuesWithheld).toBeUndefined()
    expect(amount.present).toBe(3)
  })

  it('no PathStat anywhere carries a raw value for a denylisted path', () => {
    const body = {
      data: [
        { actor: { email: 'a@x.test', user_id: 'u-1', name: 'A Person' }, model: 'opus', repo: 'org/thing' },
      ],
    }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const leaked = s.paths.filter((p) => isSensitivePath(p.path) && p.distinctValues !== undefined)
    expect(leaked).toEqual([])
    // ...and the whole serialised report contains none of the values.
    const json = JSON.stringify(s)
    expect(json).not.toContain('a@x.test')
    expect(json).not.toContain('A Person')
    expect(json).not.toContain('org/thing')
  })

  it('isSensitivePath / isSensitiveValue classify the documented cases', () => {
    expect(isSensitivePath('data[].actor.email')).toBe(true)
    expect(isSensitivePath('data[].token_type')).toBe(true) // substring 'token'
    expect(isSensitivePath('data[].organization_id')).toBe(true) // substring 'id'
    expect(isSensitivePath('data[].model')).toBe(false)
    expect(isSensitivePath('usageItems[].sku')).toBe(false)
    expect(isSensitiveValue('a@b.test')).toBe(true)
    expect(isSensitiveValue('https://blob.example/x?sig=y')).toBe(true)
    expect(isSensitiveValue('x'.repeat(64))).toBe(true)
    expect(isSensitiveValue('12.50')).toBe(true) // money-as-a-string
    expect(isSensitiveValue('-3')).toBe(true)
    expect(isSensitiveValue('claude-opus-4')).toBe(false)
    expect(isSensitiveValue('0-200k')).toBe(false)
  })

  /*
   * The identity denylist's completeness IS the control here: below the
   * distinct-value cap, one observed value under a missing key name is emitted in
   * full. Each of these names an actor or an actor-scoped container on a payload
   * we could receive, so each gets a case rather than a comment.
   */
  it.each([
    'account',
    'handle',
    'principal',
    'owner',
    'subject',
    'assignee',
    'member',
    'workspace',
    'organization',
  ])('denylists the identity key %s and emits no value under it', (word) => {
    expect(isSensitivePath(`data[].${word}`)).toBe(true)
    const s = summariseShape({ data: [{ [word]: 'octocat' }] }, { itemsPath: 'data[]' })
    const found = stat(s, `data[].${word}`)
    expect(found.distinctValues).toBeUndefined()
    expect(found.valuesWithheld).toBe('denylisted-key')
    expect(JSON.stringify(s)).not.toContain('octocat')
  })

  it('replaces an identity-shaped object KEY with a placeholder', () => {
    // Values BENEATH `users` were already withheld — but the key itself was copied
    // into the reported path, so the address left the module as a PATH.
    const body = { users: { 'alice@example.com': { model: 'opus' } } }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const paths = s.paths.map((p) => p.path)
    expect(paths).toContain(`users.${REDACTED_KEY_SEGMENT}`)
    expect(JSON.stringify(s)).not.toContain('alice@example.com')
    // ...and the subtree is still described: the guard replaces one segment, it
    // does not truncate the walk.
    expect(paths).toContain(`users.${REDACTED_KEY_SEGMENT}.model`)
  })

  it.each([
    ['an address', 'someone@example.test'],
    ['a URL', 'https://example.test/u/1'],
    ['a long opaque handle', 'k'.repeat(64)],
    ['a bare number', '100294'],
  ])('replaces an object key that is %s', (_label, key) => {
    const s = summariseShape({ owners: { [key]: { n: 1 } } }, { itemsPath: 'data[]' })
    expect(s.paths.map((p) => p.path)).toContain(`owners.${REDACTED_KEY_SEGMENT}`)
    expect(JSON.stringify(s)).not.toContain(key)
  })

  it('leaves an ordinary schema key alone — the guard is on shape, not on key names', () => {
    // Running the key-NAME denylist over segments would erase `actor`, `model` and
    // every other key this report exists to name. Only the VALUE-shape test runs.
    const s = summariseShape({ data: [{ actor: { type: 'user_actor' }, model: 'opus' }] }, { itemsPath: 'data[]' })
    const paths = s.paths.map((p) => p.path)
    expect(paths).toContain('data[].actor.type')
    expect(paths).toContain('data[].model')
    expect(paths.some((p) => p.includes(REDACTED_KEY_SEGMENT))).toBe(false)
  })

  it('does not collect data_refreshed_at as a distinct value — the report surfaces it once, on purpose', () => {
    // It is neither denylisted nor sensitive-looking, so nothing else would have
    // stopped the generic low-cardinality rule listing it. The probe returns this
    // one timestamp deliberately, under `freshness`, with its own justification;
    // that is a decision, not a licence for a generic rule to emit it too.
    const body = { data: [{ model: 'opus' }], data_refreshed_at: '2026-07-30T00:00:00Z' }
    const s = summariseShape(body, { itemsPath: 'data[]' })
    const refreshed = stat(s, 'data_refreshed_at')
    expect(refreshed.types).toEqual(['string'])
    expect(refreshed.present).toBe(1)
    expect(refreshed.distinctValues).toBeUndefined()
    expect(refreshed.valuesWithheld).toBe('surfaced-elsewhere')
    expect(JSON.stringify(s)).not.toContain('2026-07-30T00:00:00Z')
  })
})

describe('redactRequestParams', () => {
  it('replaces the identifying parameter and preserves everything else, repeats included', () => {
    const out = redactRequestParams([
      ['user', 'octocat'],
      ['year', '2026'],
      ['starting_at', '2026-07-30T00:00:00Z'],
      ['group_by[]', 'product'],
      ['group_by[]', 'model'],
    ])
    expect(out).toEqual([
      ['user', '<redacted>'],
      ['year', '2026'],
      ['starting_at', '2026-07-30T00:00:00Z'],
      ['group_by[]', 'product'],
      ['group_by[]', 'model'],
    ])
  })
})

// A tiny baseline standing in for a schema-derived one.
const BASE: WireShapeBaseline = {
  endpoint: 'test',
  provenance: 'schema-derived',
  capturedAt: null,
  note: 'test baseline',
  paths: [
    { path: 'data', types: ['array'], presentRate: 1 },
    { path: 'data[]', types: ['object'], presentRate: 1 },
    { path: 'data[].amount', types: ['string'], presentRate: 1 },
    { path: 'data[].product', types: ['string', 'null'], presentRate: null },
    { path: 'data[].nested', types: ['array'], presentRate: null },
    { path: 'data[].nested[]', types: ['object'], presentRate: 1 },
    { path: 'data[].nested[].leaf', types: ['string'], presentRate: 1 },
  ],
}

describe('compareToBaseline', () => {
  it('reports a field the payload carries and the schema does not declare as ADDED', () => {
    // The headline case: group_by asked for model, the schema never declared it.
    const live = summariseShape({ data: [{ amount: '1', model: 'opus', nested: [{ leaf: 'x' }] }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    expect(drift.added).toContain('data[].model')
    expect(drift.status).toBe('drift')
  })

  it('distinguishes a field that DISAPPEARED from one whose container never appeared', () => {
    // `nested` is absent entirely, so `nested[].leaf` cannot be judged — calling
    // it "removed" would be a fabricated finding. `amount` genuinely vanished
    // from a container (data[]) that WAS observed.
    const live = summariseShape({ data: [{ product: 'x' }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    expect(drift.removed).toContain('data[].amount')
    expect(drift.notObserved).toContain('data[].nested[].leaf')
    expect(drift.removed).not.toContain('data[].nested[].leaf')
  })

  it('flags a presence rate that has moved materially, and reports the counts behind it', () => {
    // amount on 1 of 4 rows: 100% -> 25%, well past the threshold. This is the
    // "a field silently stopped arriving" case every test stays green through.
    const live = summariseShape(
      { data: [{ amount: '1' }, {}, {}, {}] },
      { itemsPath: 'data[]' },
    )
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    const moved = drift.presenceMoved.find((m) => m.path === 'data[].amount')
    expect(moved).toBeDefined()
    expect(moved!.baselineRate).toBe(1)
    expect(moved!.liveRate).toBe(0.25)
    expect(moved!.present).toBe(1)
    expect(moved!.total).toBe(4)
  })

  it('does NOT flag presence for a path the baseline makes no claim about', () => {
    // `product` has presentRate null (our schema says optional). It is present on
    // 1 of 4 rows here — a swing that WOULD breach the threshold against any
    // asserted rate — so the path genuinely reaches the presence check and is
    // skipped on the null claim, rather than the test passing because the path
    // was absent altogether.
    const live = summariseShape(
      { data: [{ amount: '1', product: 'x' }, { amount: '2' }, { amount: '3' }, { amount: '4' }] },
      { itemsPath: 'data[]' },
    )
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    const product = live.paths.find((p) => p.path === 'data[].product')
    expect(product).toBeDefined()
    expect(product!.present / product!.total).toBe(0.25)
    expect(drift.presenceMoved.map((m) => m.path)).not.toContain('data[].product')
  })

  it('does not flag a presence move smaller than the threshold', () => {
    // 9 of 10 = 90%, a 10-point move against a 100% baseline.
    const rows = Array.from({ length: 10 }, (_, i) => (i === 0 ? {} : { amount: '1' }))
    const live = summariseShape({ data: rows }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    expect(1 - 0.9).toBeLessThan(PRESENCE_DRIFT_THRESHOLD)
    expect(drift.presenceMoved.map((m) => m.path)).not.toContain('data[].amount')
  })

  it('flags a type the baseline does not allow, and ignores a baseline type this sample lacked', () => {
    const live = summariseShape({ data: [{ amount: 12, product: 'x' }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    const changed = drift.typeChanged.find((t) => t.path === 'data[].amount')
    expect(changed?.unexpected).toEqual(['number'])
    // product's baseline allows string|null; the sample only had string. That is
    // sampling, not drift.
    expect(drift.typeChanged.map((t) => t.path)).not.toContain('data[].product')
  })

  it('does NOT call an absent OPTIONAL field removed — that is what optional means', () => {
    // `product` has presentRate null (our schema says optional) and its container
    // WAS observed, so the container rule alone reported it as a disappearance —
    // on every run, for every optional field. False drift teaches an operator to
    // stop reading the badge, which costs more than the badge is worth.
    const live = summariseShape({ data: [{ amount: '1', nested: [{ leaf: 'x' }] }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    expect(drift.removed).not.toContain('data[].product')
    expect(drift.absentOptional).toContain('data[].product')
    // ...and it does not move the verdict, which is the whole point.
    expect(drift.status).toBe('match')
  })

  it('still calls an absent REQUIRED field removed — the optional carve-out is not a blanket amnesty', () => {
    // `amount` has presentRate 1. Absent, container observed: a real disappearance.
    const live = summariseShape({ data: [{ product: 'x', nested: [{ leaf: 'y' }] }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    expect(drift.removed).toContain('data[].amount')
    expect(drift.absentOptional).not.toContain('data[].amount')
    expect(drift.status).toBe('drift')
  })

  it('an array observed EMPTY makes its element paths notObserved, never removed', () => {
    // `nested: []` is a container that is present and contains nothing. Counting
    // presence (rather than yielded child contexts) made every declared child of
    // an empty array read as a field that had disappeared.
    const live = summariseShape({ data: [{ amount: '1', product: 'p', nested: [] }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    if (drift.status === 'no-baseline' || drift.status === 'no-data') throw new Error('unexpected status')
    expect(drift.removed).toEqual([])
    expect(drift.notObserved).toContain('data[].nested[]')
    expect(drift.notObserved).toContain('data[].nested[].leaf')
    expect(drift.status).toBe('inconclusive')
    // The distinguishing fact, reported so a reader can check the classification.
    expect(stat(live, 'data[].nested').childContexts).toBe(0)
  })

  it('refuses to compare an OBSERVED EMPTY item array rather than reporting everything as missing', () => {
    const live = summariseShape({ data: [] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    expect(drift.status).toBe('no-data')
    if (drift.status !== 'no-data') return
    // The note has to say WHICH fact earned the benign label.
    expect(drift.note).toContain('EMPTY array')
  })

  it('reports an item array that turned into an OBJECT as drift, not as "no rows observed"', () => {
    // itemCount is 0 here too — but for the loudest possible reason. Short-
    // circuiting on itemCount alone labelled this "no rows observed", the most
    // reassuring phrase available for the least reassuring fact.
    const live = summariseShape({ data: { amount: '1' } }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    expect(drift.status).toBe('drift')
    if (drift.status !== 'drift') return
    expect(drift.typeChanged.find((t) => t.path === 'data')?.unexpected).toEqual(['object'])
    expect(drift.added).toContain('data.amount')
  })

  it('reports an item array that was RENAMED as drift, not as "no rows observed"', () => {
    const live = summariseShape({ rows: [{ amount: '1' }] }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    expect(drift.status).toBe('drift')
    if (drift.status !== 'drift') return
    expect(drift.removed).toContain('data')
    expect(drift.added).toContain('rows')
  })

  it('reports an item array that stopped arriving as drift, not as "no rows observed"', () => {
    const live = summariseShape({ has_more: false }, { itemsPath: 'data[]' })
    const drift = compareToBaseline(BASE, live)
    expect(drift.status).toBe('drift')
    if (drift.status !== 'drift') return
    expect(drift.removed).toContain('data')
    // Its children cannot be judged — the container never yielded anything.
    expect(drift.notObserved).toContain('data[]')
  })

  it('returns no-baseline when none is checked in', () => {
    const live = summariseShape({ data: [{ amount: '1' }] }, { itemsPath: 'data[]' })
    expect(compareToBaseline(null, live).status).toBe('no-baseline')
  })

  it('scopePrefix keeps a stored payload (which has no HTTP envelope) from reading as mass removal', () => {
    // The stored scan wraps rows as { data: [...] }: there is no `has_more`,
    // `next_page` or `organization_id`. Without the scope those envelope paths
    // would all be reported removed — an artefact of the input, not a change.
    const withEnvelope: WireShapeBaseline = {
      ...BASE,
      paths: [...BASE.paths, { path: 'has_more', types: ['boolean'], presentRate: 1 }],
    }
    const live = summariseShape(
      { data: [{ amount: '1', product: 'p', nested: [{ leaf: 'x' }] }] },
      { itemsPath: 'data[]' },
    )
    const scoped = compareToBaseline(withEnvelope, live, { scopePrefix: 'data[]' })
    if (scoped.status === 'no-baseline' || scoped.status === 'no-data') throw new Error('unexpected status')
    expect(scoped.removed).not.toContain('has_more')
    expect(scoped.status).toBe('match')

    const unscoped = compareToBaseline(withEnvelope, live)
    if (unscoped.status === 'no-baseline' || unscoped.status === 'no-data') throw new Error('unexpected status')
    expect(unscoped.removed).toContain('has_more')
  })
})

describe('checked-in baselines', () => {
  const all = [
    ['anthropic-enterprise-user-usage', enterpriseUsageBaseline],
    ['anthropic-enterprise-user-cost', enterpriseCostBaseline],
    ['anthropic-admin-claude-code', adminBaseline],
    ['github-ai-credit-usage', githubBaseline],
    ['github-user-daily-credits', githubMetricsBaseline],
  ] as const

  it.each(all)('%s is well-formed and self-consistent', (id, raw) => {
    const b = raw as WireShapeBaseline
    expect(b.endpoint).toBe(id)
    expect(b.provenance).toBe('schema-derived')
    // A schema-derived baseline has no capture time. Claiming one would be a lie
    // about where these numbers came from.
    expect(b.capturedAt).toBeNull()
    expect(b.paths.length).toBeGreaterThan(0)
    const paths = b.paths.map((p) => p.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
    for (const p of b.paths) {
      expect(p.types.length).toBeGreaterThan(0)
      if (p.presentRate !== null) {
        expect(p.presentRate).toBeGreaterThanOrEqual(0)
        expect(p.presentRate).toBeLessThanOrEqual(1)
      }
    }
  })

  it('BOTH Enterprise baselines declare a model path — the asymmetry is closed and must stay closed', () => {
    /*
     * This assertion used to be inverted, and it pinned a DEFECT rather than a
     * contract: analytics-poller.ts sends group_by[]=product&group_by[]=model to
     * both Enterprise reports, Anthropic answers with `model` on both, and only
     * UsageRow declared it. `CostRow.model` reached actual_spend.raw_payload —
     * and from there provider_usage_fact.model and the whole billed model axis —
     * through `.passthrough()` ALONE. Load-bearing and undeclared: tightening
     * that object, or reading the type and concluding the dimension was absent,
     * silently emptied the axis (task #32).
     *
     * Now that both rows declare it, the baselines carry the path and a REMOVED
     * declaration is what goes red here. Runtime cannot see this distinction —
     * a passed-through field and a declared one look identical to a parse test —
     * so `enterprise-model-dimension.test-d.ts` guards the type alongside this.
     */
    const cost = enterpriseCostBaseline as WireShapeBaseline
    const usage = enterpriseUsageBaseline as WireShapeBaseline
    expect(cost.paths.map((p) => p.path)).toContain('data[].model')
    expect(usage.paths.map((p) => p.path)).toContain('data[].model')
  })

  it('the Admin baseline asserts model is required, which is what makes a presence drop detectable', () => {
    const admin = adminBaseline as WireShapeBaseline
    const model = admin.paths.find((p) => p.path === 'data[].model_breakdown[].model')
    expect(model?.presentRate).toBe(1)
  })

  it('the Copilot metrics baseline declares NO model path, so an arriving one reads as undeclared', () => {
    /*
     * This is the whole point of the App-mode surface. UserMetricsRecordSchema
     * declares identity, day and credits and nothing else, and the record schema
     * is .passthrough() — so if GitHub does send a model dimension it survives
     * into the summary and lands in `undeclared`. Declaring a speculative
     * `model` path here would silently ANSWER the question the surface exists to
     * ask, and a run against real data would then report a match either way.
     */
    const b = githubMetricsBaseline as WireShapeBaseline
    const paths = b.paths.map((p) => p.path)
    expect(paths).not.toContain('ndjson_records[].model')
    expect(paths.some((p) => p.includes('model'))).toBe(false)
    // ...and the four fields our schema DOES declare are all there, so a real
    // disappearance is still detectable against them.
    expect(paths).toEqual(
      expect.arrayContaining([
        'ndjson_records[].user_login',
        'ndjson_records[].user_id',
        'ndjson_records[].day',
        'ndjson_records[].ai_credits_used',
      ]),
    )
  })

  it('the Copilot metrics baseline declares the envelope, not just the records', () => {
    // Both stages are reported on one surface; a baseline covering only the
    // NDJSON rows would report every envelope key as undeclared on every run.
    const paths = (githubMetricsBaseline as WireShapeBaseline).paths.map((p) => p.path)
    expect(paths).toContain('download_links')
    expect(paths).toContain('report_day')
  })
})
