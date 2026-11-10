/*
 * The unmatched-spend list names each source in words (#545), keeping the
 * account id an admin needs to register or link, and agrees with the server's
 * own reading of the same key (server/reconciliation/source-org-ref.ts).
 */
import { describe, it, expect } from 'vitest'
import { unmatchedSourceLabel } from '../../../shared/governance/unmatched-source'
import { parseActualSpendSourceOrgRef } from '../../../server/reconciliation/source-org-ref'

const CASES: [string, string][] = [
  ['anthropic-analytics-api:org-123', 'Anthropic organisation org-123'],
  ['anthropic-analytics-api', 'Anthropic, no organisation recorded'],
  ['copilot-seat:acme', 'GitHub Copilot seats, organisation acme'],
  ['copilot-seat:unknown', 'GitHub Copilot seats, no organisation recorded'],

]

describe('unmatchedSourceLabel', () => {
  it('an unknown source never prints its key', () => {
    expect(unmatchedSourceLabel('something-else')).toBe('Another source')
  })

  it.each(CASES)('%s reads as %s', (source, label) => {
    expect(unmatchedSourceLabel(source)).toBe(label)
  })

  it.each(CASES)('agrees with the server parser on %s', (source) => {
    const ref = parseActualSpendSourceOrgRef(source)
    const label = unmatchedSourceLabel(source)
    if (ref.provider === 'anthropic') expect(label).toMatch(/^Anthropic/)
    else if (ref.provider === 'github') expect(label).toMatch(/^GitHub/)
    else expect(label).toBe('Another source')
    if (ref.externalOrgId) expect(label).toContain(ref.externalOrgId)
    else expect(label).toContain('no organisation recorded')
  })
})
