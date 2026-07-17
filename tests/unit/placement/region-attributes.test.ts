/*
 * region-attributes — the shared catalog of directory attributes that can drive
 * region derivation. Pure data + normalisers; guards the precedence contract and
 * the match-value normalisation the engine relies on.
 */
import { describe, it, expect } from 'vitest'
import {
  REGION_ATTRIBUTES,
  REGION_ATTRIBUTE_KEYS,
  isRegionAttributeKey,
  regionAttribute,
  regionAttributeLabel,
  attributePrecedence,
  normalizeMatchValue,
  isMatchMode,
} from '../../../shared/placement/region-attributes'

describe('catalog integrity', () => {
  it('keys are unique and match graph property names', () => {
    expect(new Set(REGION_ATTRIBUTE_KEYS).size).toBe(REGION_ATTRIBUTE_KEYS.length)
    for (const a of REGION_ATTRIBUTES) expect(a.graph).toBe(a.key)
  })
  it('every attribute has a label, hint and example', () => {
    for (const a of REGION_ATTRIBUTES) {
      expect(a.label).toBeTruthy()
      expect(a.hint).toBeTruthy()
      expect(a.example).toBeTruthy()
    }
  })
})

describe('precedence (entity/geo first, org-function last)', () => {
  it('companyName outranks country outranks department', () => {
    expect(attributePrecedence('companyName')).toBeLessThan(attributePrecedence('country'))
    expect(attributePrecedence('country')).toBeLessThan(attributePrecedence('department'))
  })
  it('companyName is the top signal; unknown sorts last', () => {
    expect(attributePrecedence('companyName')).toBe(0)
    expect(attributePrecedence('nope')).toBe(REGION_ATTRIBUTES.length)
  })
})

describe('helpers', () => {
  it('isRegionAttributeKey', () => {
    expect(isRegionAttributeKey('companyName')).toBe(true)
    expect(isRegionAttributeKey('email')).toBe(false)
  })
  it('regionAttribute / label lookup with fallback', () => {
    expect(regionAttribute('country')?.label).toBe('Country or region')
    expect(regionAttributeLabel('country')).toBe('Country or region')
    expect(regionAttributeLabel('mystery')).toBe('mystery')
  })
  it('normalizeMatchValue trims + lowercases; nullish → empty', () => {
    expect(normalizeMatchValue('  Insight Australia ')).toBe('insight australia')
    expect(normalizeMatchValue(null)).toBe('')
    expect(normalizeMatchValue(undefined)).toBe('')
  })
  it('isMatchMode', () => {
    expect(isMatchMode('exact')).toBe(true)
    expect(isMatchMode('prefix')).toBe(true)
    expect(isMatchMode('regex')).toBe(false)
  })
})
