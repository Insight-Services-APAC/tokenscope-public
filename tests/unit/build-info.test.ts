/*
 * Build stamp composition — the string that replaced a hand-typed
 * "APAC · v0.1.0 · MVP-Lite first slice" that was wrong on all three fields.
 * The rules that keep it honest: never render a field we don't have, and don't
 * tell someone they're on production (they know) while always telling them when
 * they're not (they often don't).
 */
import { describe, it, expect } from 'vitest'
import { formatBuildStamp, shortCommit } from '../../shared/build-info'

describe('shortCommit', () => {
  it('abbreviates a real sha', () => {
    expect(shortCommit('af7c985f2b1c4d5e6a7b8c9d0e1f2a3b4c5d6e7f')).toBe('af7c985')
  })

  it('treats missing and the Dockerfile default as "no commit"', () => {
    expect(shortCommit(null)).toBeNull()
    expect(shortCommit(undefined)).toBeNull()
    expect(shortCommit('')).toBeNull()
    // The Dockerfile ARG default; rendering it would be worse than rendering nothing.
    expect(shortCommit('unknown')).toBeNull()
  })
})

describe('formatBuildStamp', () => {
  it('names the environment everywhere except production', () => {
    expect(formatBuildStamp({ environment: 'dev', version: '0.1.0', commit: 'af7c985' }))
      .toBe('dev · v0.1.0 · af7c985')
    expect(formatBuildStamp({ environment: 'production', version: '0.1.0', commit: 'af7c985' }))
      .toBe('v0.1.0 · af7c985')
  })

  it('omits what it does not know instead of inventing it', () => {
    expect(formatBuildStamp({ environment: 'dev', version: '0.1.0', commit: null }))
      .toBe('dev · v0.1.0')
    expect(formatBuildStamp({ environment: 'production', version: '', commit: null }))
      .toBe('')
  })
})
