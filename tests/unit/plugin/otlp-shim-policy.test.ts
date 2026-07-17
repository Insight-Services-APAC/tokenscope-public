/*
 * otlp-shim-policy — the single source of truth for whether the CC #72671
 * Content-Length forwarder runs. Contract: OFF by default, ON only for CLI
 * versions in a known-broken range; manual =1 forces on, =0 forces off. The
 * version is read from the env Claude sets at launch (CLAUDE_CODE_EXECPATH /
 * AI_AGENT), never spawned.
 */
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { parseCliVersion, detectCliVersion, brokenRangeFor, resolveShim, shimActive, OTLP_BROKEN_RANGES } =
  await import('../../../plugin/scripts/otlp-shim-policy.mjs')

const execEnv = (v: string) => ({ CLAUDE_CODE_EXECPATH: `/home/x/.local/share/claude/versions/${v}` })

describe('parseCliVersion', () => {
  it('parses a bare semver and a "(Claude Code)" suffix', () => {
    expect(parseCliVersion('2.1.212')).toEqual([2, 1, 212])
    expect(parseCliVersion('2.1.212 (Claude Code)')).toEqual([2, 1, 212])
  })
  it('returns null for junk / empty', () => {
    expect(parseCliVersion('')).toBeNull()
    expect(parseCliVersion('nope')).toBeNull()
    expect(parseCliVersion(undefined)).toBeNull()
  })
})

describe('detectCliVersion', () => {
  it('prefers CLAUDE_CODE_EXECPATH versions/X.Y.Z', () => {
    expect(detectCliVersion(execEnv('2.1.211'))).toEqual([2, 1, 211])
  })
  it('falls back to AI_AGENT claude-code_X-Y-Z_agent', () => {
    expect(detectCliVersion({ AI_AGENT: 'claude-code_2-1-205_agent' })).toEqual([2, 1, 205])
  })
  it('falls back to AI_AGENT when EXECPATH is PRESENT but non-matching (differently-packaged install)', () => {
    // The regex only matches .../versions/X.Y.Z; an install that lays the binary
    // out differently must still resolve via AI_AGENT, not silently go unknown.
    expect(
      detectCliVersion({ CLAUDE_CODE_EXECPATH: '/opt/weird/claude-bin', AI_AGENT: 'claude-code_2-1-207_agent' }),
    ).toEqual([2, 1, 207])
  })
  it('returns null when EXECPATH is non-matching AND AI_AGENT is absent (→ AUTO dormant)', () => {
    expect(detectCliVersion({ CLAUDE_CODE_EXECPATH: '/opt/weird/claude-bin' })).toBeNull()
  })
  it('returns null when neither signal is present', () => {
    expect(detectCliVersion({})).toBeNull()
  })
})

describe('brokenRangeFor (#72671 span is half-open [2.1.191, 2.1.212))', () => {
  it('excludes the version just below the range (2.1.190)', () => {
    expect(brokenRangeFor([2, 1, 190])).toBeNull()
  })
  it('includes the first broken version (2.1.191) and a mid one (2.1.211)', () => {
    expect(brokenRangeFor([2, 1, 191])?.issue).toContain('72671')
    expect(brokenRangeFor([2, 1, 211])?.issue).toContain('72671')
  })
  it('excludes the fix version (2.1.212) and everything after', () => {
    expect(brokenRangeFor([2, 1, 212])).toBeNull()
    expect(brokenRangeFor([2, 2, 0])).toBeNull()
    expect(brokenRangeFor([3, 0, 0])).toBeNull()
  })
  it('is null for an unknown version', () => {
    expect(brokenRangeFor(null)).toBeNull()
  })
})

describe('resolveShim / shimActive', () => {
  it('DEFAULT is OFF on a fixed CLI (2.1.212)', () => {
    const r = resolveShim(execEnv('2.1.212'))
    expect(r.active).toBe(false)
    expect(r.reason).toBe('auto-clear')
    expect(shimActive(execEnv('2.1.212'))).toBe(false)
  })
  it('DEFAULT is OFF when the version is unknown (no signal)', () => {
    expect(shimActive({})).toBe(false)
  })
  it('AUTO-ON only for an affected CLI (2.1.205), carrying the range + version', () => {
    const r = resolveShim(execEnv('2.1.205'))
    expect(r.active).toBe(true)
    expect(r.reason).toBe('auto-affected')
    expect(r.version).toEqual([2, 1, 205])
    expect(r.range.issue).toContain('72671')
  })
  it('=1 forces ON even on a fixed CLI', () => {
    expect(shimActive({ ...execEnv('2.1.212'), TOKENSCOPE_OTLP_PROXY: '1' })).toBe(true)
    expect(resolveShim({ TOKENSCOPE_OTLP_PROXY: '1' }).reason).toBe('forced-on')
  })
  it('=0 forces OFF even on an affected CLI', () => {
    expect(shimActive({ ...execEnv('2.1.205'), TOKENSCOPE_OTLP_PROXY: '0' })).toBe(false)
    expect(resolveShim({ ...execEnv('2.1.205'), TOKENSCOPE_OTLP_PROXY: '0' }).reason).toBe('forced-off')
  })
})

describe('OTLP_BROKEN_RANGES table', () => {
  it('documents the #72671 span with an issue ref (extend here for a re-regression)', () => {
    expect(OTLP_BROKEN_RANGES.length).toBeGreaterThanOrEqual(1)
    const r = OTLP_BROKEN_RANGES[0]
    expect(r.from).toEqual([2, 1, 191])
    expect(r.to).toEqual([2, 1, 212])
    expect(r.issue).toContain('claude-code#72671')
  })
})
