/*
 * api-base — resolveApiBase's endpoint validation (S1 fix 2/3).
 *
 * TOKENSCOPE_API_BASE is never written to global settings.json, so there is
 * no legitimate global value to outvote a repo-supplied override with (see
 * plugin-runtime.mjs's safeProcessEnv, which deletes the key outright).
 * Validating the RESOLVED base inside resolveApiBase closes that gap for
 * every caller (enroll.mjs, claude-redeem.mjs) in one place.
 */
import { inspect } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { resolveApiBase, DEFAULT_API_BASE } from '../../../plugin/scripts/api-base.mjs'

const savedEnv = process.env.TOKENSCOPE_API_BASE
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TOKENSCOPE_API_BASE
  else process.env.TOKENSCOPE_API_BASE = savedEnv
})

describe('resolveApiBase', () => {
  it('returns the baked default when nothing overrides it', () => {
    delete process.env.TOKENSCOPE_API_BASE
    expect(resolveApiBase(null)).toBe(DEFAULT_API_BASE)
  })

  it('strips a trailing slash from an explicit arg', () => {
    delete process.env.TOKENSCOPE_API_BASE
    expect(resolveApiBase('https://ts.example.com/')).toBe('https://ts.example.com')
  })

  it('an EXPLICIT arg outranks the env override', () => {
    // Reversed deliberately. This used to assert env-first, on the general
    // principle that an operator's environment beats a script default. That
    // holds when the arg IS a default; it is wrong for the caller that matters
    // here. The redeem helper passes the origin of the server that MINTED a
    // one-time handoff code, and a handoff can only be redeemed at its issuer,
    // so a stale TOKENSCOPE_API_BASE outranking it does not override a default
    // — it posts a live single-use secret to a host that cannot honour it, and
    // does so silently, because the wrong host just 404s.
    process.env.TOKENSCOPE_API_BASE = 'https://ts-env.example.com'
    expect(resolveApiBase('https://ts-arg.example.com')).toBe('https://ts-arg.example.com')
  })

  it('an OFF-BOX env value is ignored entirely, not merely outranked', () => {
    // This used to assert the env var wins when no arg is passed. It no longer
    // is a source at all off-box: a cloned repository can supply the variable
    // and a repo-injected value is indistinguishable from a shell-exported one,
    // so "point it at another deployment" is not a capability this resolver can
    // safely offer. Nothing to opt out of means nothing for a future caller to
    // forget to opt out of.
    process.env.TOKENSCOPE_API_BASE = 'https://ts-env.example.com'
    expect(resolveApiBase(null)).toBe(DEFAULT_API_BASE)
    expect(resolveApiBase(null)).not.toContain('ts-env')
  })

  it('a DISCOVERED MCP origin beats the baked default, and an off-box env value beats nothing', () => {
    process.env.TOKENSCOPE_API_BASE = 'https://ts-env.example.com'
    expect(resolveApiBase(null, { discovered: 'https://ts-mcp.example.com' })).toBe(
      'https://ts-mcp.example.com',
    )
    delete process.env.TOKENSCOPE_API_BASE
    expect(resolveApiBase(null, { discovered: 'https://ts-mcp.example.com' })).toBe(
      'https://ts-mcp.example.com',
    )
  })

  it('the documented local-dev loopback override keeps working', () => {
    // The reason the env source is narrowed rather than deleted. Deleting it
    // outright left local Claude development silently pointed at the shared dev
    // host: no env read, and no discoverable bundle either (see mcp-origin.mjs
    // on why the Claude bundle tier never resolves). A loopback value cannot
    // express the threat the narrowing exists for — being served by 127.0.0.1
    // means the attacker is already running on the machine.
    process.env.TOKENSCOPE_API_BASE = 'http://localhost:3450'
    expect(resolveApiBase(null)).toBe('http://localhost:3450')
    process.env.TOKENSCOPE_API_BASE = 'http://127.0.0.1:3450'
    expect(resolveApiBase(null)).toBe('http://127.0.0.1:3450')
    process.env.TOKENSCOPE_API_BASE = 'http://[::1]:3450'
    expect(resolveApiBase(null)).toBe('http://[::1]:3450')
  })

  it('the loopback override outranks discovery but never an explicit arg', () => {
    process.env.TOKENSCOPE_API_BASE = 'http://localhost:3450'
    expect(resolveApiBase(null, { discovered: 'https://ts-mcp.example.com' })).toBe(
      'http://localhost:3450',
    )
    expect(resolveApiBase('https://ts-arg.example.com', { discovered: null })).toBe(
      'https://ts-arg.example.com',
    )
  })

  it('a NON-HTTP scheme is not a loopback override, even on a loopback host', () => {
    // assertSafeEndpoint takes an early exit for loopback — that is the
    // documented dev exception — so it never re-checks the scheme, and these
    // reached the caller as a usable "API base" that would only fail later, at
    // the request, with a confusing error. The loopback gate is the one that
    // has to say http(s). Caught by @copilot on #210 and reproduced before fixing.
    for (const bad of ['ftp://127.0.0.1', 'gopher://[::1]', 'file://localhost']) {
      process.env.TOKENSCOPE_API_BASE = bad
      expect(resolveApiBase(null), bad).toBe(DEFAULT_API_BASE)
    }
  })

  it('a host merely CONTAINING "localhost" is not loopback', () => {
    // Parsed, never substring-matched: `localhost.attacker.example` resolves
    // wherever the attacker's DNS says, and is exactly the value a naive check
    // would wave through.
    process.env.TOKENSCOPE_API_BASE = 'https://localhost.attacker.example'
    expect(resolveApiBase(null)).toBe(DEFAULT_API_BASE)
    process.env.TOKENSCOPE_API_BASE = 'https://127.0.0.1.attacker.example'
    expect(resolveApiBase(null)).toBe(DEFAULT_API_BASE)
  })

  // The endpoint guard still matters, but the env var can no longer DELIVER a
  // bad value off-box, so these now drive it through the sources that survive:
  // the explicit argument and a discovered registration. Both still reach a
  // caller that prints err.message from a generic top-level handler, which is
  // what the redaction is for.
  it('rejects a plaintext http arg for an off-box host, WITHOUT echoing it', () => {
    expect(() => resolveApiBase('http://evil.example.com')).toThrow(/API base/i)
    try {
      resolveApiBase('http://evil.example.com')
      throw new Error('expected resolveApiBase to throw')
    } catch (err) {
      expect(inspect(err, { depth: null })).not.toContain('evil.example.com')
      expect((err as { reason?: string }).reason).toBeTruthy()
    }
  })

  it('rejects a plaintext http DISCOVERED origin too, redacted the same way', () => {
    // Discovery reads a file rather than a flag, so this value is the one least
    // likely to be something the reader typed and already knows.
    expect(() => resolveApiBase(null, { discovered: 'http://evil.example.com' })).toThrow(
      /API base/i,
    )
    try {
      resolveApiBase(null, { discovered: 'http://evil.example.com' })
      throw new Error('expected resolveApiBase to throw')
    } catch (err) {
      expect(inspect(err, { depth: null })).not.toContain('evil.example.com')
    }
  })

  it("rejects a value starting with '-'", () => {
    // Classification only — the rejected value is redacted (see above).
    expect(() => resolveApiBase('-x')).toThrow(/API base/i)
  })

  it('rejects a non-URL string', () => {
    expect(() => resolveApiBase('not a url at all')).toThrow()
  })

  it('a whitespace-only env override falls through to the arg/default rather than becoming a garbage base', () => {
    process.env.TOKENSCOPE_API_BASE = '   '
    expect(resolveApiBase(null)).toBe(DEFAULT_API_BASE)
  })
})

/*
 * The hostile-repository boundary.
 *
 * Claude Code merges a project's .claude settings env OVER the global one, so
 * TOKENSCOPE_API_BASE is a value a cloned repository controls, and there is no
 * way to tell a repo-injected value from a shell-exported one — they are the
 * same process.env.
 *
 * This was first closed with a `trustEnv: false` opt-out per caller, which made
 * "is this safe?" mean "did we enumerate every caller?" — and the enumeration
 * was wrong for weeks. The flag is gone: the resolver accepts the variable only
 * when it names loopback, which is a value that cannot express the threat. These
 * tests pin the boundary itself rather than any caller's use of a flag.
 */
describe('resolveApiBase — repo-supplied env is not a destination', () => {
  let prior: string | undefined
  beforeEach(() => {
    prior = process.env.TOKENSCOPE_API_BASE
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.TOKENSCOPE_API_BASE
    else process.env.TOKENSCOPE_API_BASE = prior
  })

  it('prefers discovery over an off-box env value, with nothing to opt out of', () => {
    process.env.TOKENSCOPE_API_BASE = 'https://attacker.example.com'
    expect(resolveApiBase(null, { discovered: 'https://real.example.com' })).toBe(
      'https://real.example.com',
    )
  })

  it('falls to the baked default rather than the env var when there is no discovery', () => {
    // The stock-install case, and — per mcp-origin.mjs — the COMMON one on
    // Claude, where the bundle tier never resolves and nothing is registered by
    // hand. Landing on the attacker host here would be the whole vulnerability.
    process.env.TOKENSCOPE_API_BASE = 'https://attacker.example.com'
    const out = resolveApiBase(null)
    expect(out).toBe(DEFAULT_API_BASE)
    expect(out).not.toContain('attacker')
  })

  it('still lets an explicitly passed base win, because a human typed it', () => {
    process.env.TOKENSCOPE_API_BASE = 'https://attacker.example.com'
    expect(
      resolveApiBase('https://typed.example.com', { discovered: 'https://real.example.com' }),
    ).toBe('https://typed.example.com')
  })

  it('a repo cannot re-open the hole by naming a plausible-looking scheme or port', () => {
    for (const hostile of [
      'https://attacker.example.com:3450',
      'http://attacker.example.com:3450',
      'https://tokenscope.example.com.attacker.example',
    ]) {
      process.env.TOKENSCOPE_API_BASE = hostile
      expect(resolveApiBase(null)).toBe(DEFAULT_API_BASE)
    }
  })
})

/**
 * Read a script with its COMMENTS REMOVED.
 *
 * Every source-level pin in this file previously matched raw text, which meant
 * it also matched the prose explaining why the thing it forbids is absent. The
 * older pins survived only because no comment happened to use the exact spelling
 * they searched for — they were one explanatory sentence away from a false
 * failure, and (worse) a genuine violation could have been argued away by
 * "it's only a comment". Strip first, then the assertion is about code.
 *
 * The `[^:]` guard keeps `https://…` inside a string literal from being treated
 * as the start of a line comment. This is a lexer's job done with a regex, which
 * is fine for "does this identifier appear in code" and would not be for
 * anything that needed to understand the code.
 */
function readCode(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('no caller can opt back into an off-box environment source', () => {
  // Source-level pins, because the call sites sit behind argument parsing, hook
  // plumbing and a network call. Paired with the behavioural tests above: those
  // prove the boundary holds, these prove nobody is routing around it.
  const SCRIPTS = join(process.cwd(), 'plugin', 'scripts')
  const COPILOT_ENROLL = join(process.cwd(), 'copilot-plugin', 'scripts', 'enroll.mjs')
  const ALL = ['claude-redeem.mjs', 'enroll.mjs', 'copilot-redeem.mjs']

  it('the resolver has no trustEnv escape hatch left to pass', () => {
    // The flag itself is the finding. While it existed, safety was opt-in and
    // two of four callers silently never opted in.
    expect(readCode(join(SCRIPTS, 'api-base.mjs'))).not.toMatch(/trustEnv/)
  })

  it('no shipped script passes trustEnv to resolveApiBase', () => {
    for (const f of ALL) expect(readCode(join(SCRIPTS, f)), f).not.toMatch(/trustEnv/)
    expect(readCode(COPILOT_ENROLL)).not.toMatch(/trustEnv/)
  })

  it('only api-base.mjs reads TOKENSCOPE_API_BASE, and only through the loopback gate', () => {
    for (const f of ALL)
      expect(readCode(join(SCRIPTS, f)), f).not.toMatch(/process\.env\.TOKENSCOPE_API_BASE/)
    expect(readCode(COPILOT_ENROLL)).not.toMatch(/process\.env\.TOKENSCOPE_API_BASE/)
    const resolver = readCode(join(SCRIPTS, 'api-base.mjs'))
    expect(resolver.match(/process\.env\.TOKENSCOPE_API_BASE/g)).toHaveLength(1)
    expect(resolver).toMatch(/isLoopbackBase\(envBase\)/)
  })

  it('the comment stripper does not hide a real violation', () => {
    // The pins above are only as good as readCode. Prove it keeps code and drops
    // prose, rather than trusting a regex written in the same sitting as the
    // tests that depend on it.
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(strip('// we removed trustEnv: false here\nconst a = 1')).not.toMatch(/trustEnv/)
    expect(strip('/* trustEnv: false was here */\nconst a = 1')).not.toMatch(/trustEnv/)
    expect(strip('resolveApiBase(x, { trustEnv: false })')).toMatch(/trustEnv/)
    expect(strip("const u = 'https://x.example' // trailing")).toMatch(/https:\/\/x\.example/)
  })
})

describe('the second resolver stays honest', () => {
  // Copilot's enrol door keeps its OWN resolveApiBase: that file is not vendored
  // from plugin/scripts/ (Copilot writes a different on-disk contract), so it
  // cannot import the shared one. That duplication is exactly how the env-first
  // precedence survived being fixed in the canonical file — a copy no drift
  // check covered. Pinned until the two are consolidated.
  const COPILOT_ENROLL = join(process.cwd(), 'copilot-plugin', 'scripts', 'enroll.mjs')

  it('resolves arg then discovery, and takes no environment source', () => {
    const src = readFileSync(COPILOT_ENROLL, 'utf8')
    const decl = /export function resolveApiBase\(([^)]*)\)/.exec(src)
    expect(decl, 'the Copilot enrol resolver moved — re-point this pin').toBeTruthy()
    expect(decl![1]).toContain('discovered')
  })

  it('has no loopback override, deliberately, because Copilot never had one', () => {
    // Not an oversight to be tidied into symmetry later. TOKENSCOPE_API_BASE was
    // never an override channel on the Copilot side at all: copilot-plugin/.mcp.json
    // ships a LITERAL url because Copilot CLI does not expand ${VAR}. Adding a
    // loopback env source here would be a new capability, not parity.
    expect(readFileSync(COPILOT_ENROLL, 'utf8')).not.toMatch(/process\.env\.TOKENSCOPE_API_BASE/)
  })
})
