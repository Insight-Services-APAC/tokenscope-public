// @vitest-environment node
/*
 * Pure validation helpers for the reconciliation-provider admin surface. No DB,
 * no env — these encode the mig 0062 (lowercase external_id) and mig 0063
 * (api_kind) CHECK invariants so the routes reject bad input as a clean 400
 * before the DB raises a raw 23514.
 */
import { describe, it, expect } from 'vitest'
import {
  validateApiKindForProvider,
  validateReconciledCredential,
  canonicaliseExternalId,
} from '../../../server/reconciliation/provider-validation'

describe('validateApiKindForProvider (mig 0063)', () => {
  it('anthropic requires a valid api_kind', () => {
    expect(validateApiKindForProvider('anthropic', null)).toMatch(/requires api_kind/)
    expect(validateApiKindForProvider('anthropic', undefined)).toMatch(/requires api_kind/)
    expect(validateApiKindForProvider('anthropic', 'enterprise-analytics')).toBeNull()
    expect(validateApiKindForProvider('anthropic', 'claude-code-admin')).toBeNull()
  })
  it('github must NOT carry an api_kind', () => {
    expect(validateApiKindForProvider('github', null)).toBeNull()
    expect(validateApiKindForProvider('github', 'claude-code-admin')).toMatch(/must be null/)
  })
})

describe('validateReconciledCredential', () => {
  it('a reconciled anthropic org needs a credential', () => {
    expect(validateReconciledCredential('anthropic', 'reconciled', null)).toMatch(/requires a credentialSecretName/)
    expect(validateReconciledCredential('anthropic', 'reconciled', 'k')).toBeNull()
    expect(validateReconciledCredential('anthropic', 'indicative', null)).toBeNull()
  })
  it('github org-level credential is not required here (lives on the enterprise)', () => {
    expect(validateReconciledCredential('github', 'reconciled', null)).toBeNull()
  })
})

describe('canonicaliseExternalId (mig 0062)', () => {
  it('auto-lowercases a mixed-case github slug (GitHub canonicalises slugs to lowercase)', () => {
    expect(canonicaliseExternalId('github', 'Insight-Demo')).toEqual({ value: 'insight-demo' })
  })
  it('still rejects a github slug with an invalid charset', () => {
    const r = canonicaliseExternalId('github', 'bad slug!')
    expect('error' in r && r.error).toMatch(/slug/)
  })
  it('accepts a lowercase github slug verbatim', () => {
    expect(canonicaliseExternalId('github', 'insight-demo')).toEqual({ value: 'insight-demo' })
  })
  it('auto-lowercases an anthropic org id', () => {
    expect(canonicaliseExternalId('anthropic', 'Org-ABC')).toEqual({ value: 'org-abc' })
  })
  it('rejects an empty id', () => {
    const r = canonicaliseExternalId('anthropic', '   ')
    expect('error' in r && r.error).toMatch(/must not be empty/)
  })
})
