/*
 * endpoint-guard — assertSafeEndpoint / isUsableDce (S1 fix 3).
 *
 * The ONE endpoint validator every credential-bearing network call in the
 * plugin routes through (directly, or via plugin-runtime.mjs's re-export).
 * Dependency-free by design (Node builtins only, no plugin/scripts/*
 * imports) so it survives being vendored into the standalone copilot-plugin
 * distribution — see the module header.
 */
import { describe, it, expect } from 'vitest'
import { inspect } from 'node:util'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertSafeEndpoint,
  isUsableDce,
  unsafeEndpointError,
} from '../../../plugin/scripts/endpoint-guard.mjs'

describe('assertSafeEndpoint — table', () => {
  const cases: Array<{ name: string; url: string; allowLoopback?: boolean; ok: boolean }> = [
    {
      name: 'https-offhost: a real https URL',
      url: 'https://tokenscope.example.com/api/v1/instances/x/bearer',
      ok: true,
    },
    {
      name: 'https-offhost with allowLoopback true still passes',
      url: 'https://tokenscope.example.com/x',
      allowLoopback: true,
      ok: true,
    },
    {
      name: 'http-offhost: plaintext to a real host is REJECTED',
      url: 'http://tokenscope.example.com/x',
      ok: false,
    },
    {
      name: 'http-offhost even WITH allowLoopback (off-box is still off-box)',
      url: 'http://evil.example.com/x',
      allowLoopback: true,
      ok: false,
    },
    {
      name: 'http-loopback (127.0.0.1) with allowLoopback → PASSES',
      url: 'http://127.0.0.1:3450/api/v1/x',
      allowLoopback: true,
      ok: true,
    },
    {
      name: 'http-loopback (localhost) with allowLoopback → PASSES',
      url: 'http://localhost:3450/x',
      allowLoopback: true,
      ok: true,
    },
    {
      name: 'http-loopback (::1) with allowLoopback → PASSES',
      url: 'http://[::1]:3450/x',
      allowLoopback: true,
      ok: true,
    },
    {
      name: 'http-loopback WITHOUT allowLoopback (default false) → REJECTED',
      url: 'http://127.0.0.1:3450/x',
      ok: false,
    },
    {
      name: 'leading-dash: rejected regardless of allowLoopback',
      url: '-K/tmp/x',
      allowLoopback: true,
      ok: false,
    },
    {
      name: 'leading-dash on an otherwise-valid-looking value',
      url: '-https://example.com',
      ok: false,
    },
    { name: 'non-URL: plain garbage string', url: 'not a url at all', ok: false },
    { name: 'non-URL: empty string', url: '', ok: false },
    { name: 'non-URL: whitespace only', url: '   ', ok: false },
    {
      name: 'non-https scheme other than http (e.g. ftp) off-box',
      url: 'ftp://example.com/x',
      ok: false,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      if (c.ok) {
        expect(() => assertSafeEndpoint(c.url, { allowLoopback: c.allowLoopback })).not.toThrow()
      } else {
        expect(() => assertSafeEndpoint(c.url, { allowLoopback: c.allowLoopback })).toThrow()
      }
    })
  }

  it('returns the parsed URL on success', () => {
    const parsed = assertSafeEndpoint('https://tokenscope.example.com/api/v1/x')
    expect(parsed).toBeInstanceOf(URL)
    expect(parsed.hostname).toBe('tokenscope.example.com')
  })

  it('rejects non-string input', () => {
    // @ts-expect-error deliberately testing a non-string input
    expect(() => assertSafeEndpoint(null)).toThrow()
    // @ts-expect-error deliberately testing a non-string input
    expect(() => assertSafeEndpoint(undefined)).toThrow()
  })
})

describe('isUsableDce — a usable "real DCE" value (loopback rejected UNCONDITIONALLY)', () => {
  it('accepts a well-formed https, non-loopback URL', () => {
    expect(
      isUsableDce('https://dce-tokenscope-dev.westus3-1.ingest.monitor.azure.com/streams/x'),
    ).toBe(true)
  })

  it('rejects a plaintext http off-box URL', () => {
    expect(isUsableDce('http://dce-tokenscope-dev.example.com/streams/x')).toBe(false)
  })

  it('rejects loopback even under https — the proxy address must never masquerade as the DCE', () => {
    expect(isUsableDce('https://127.0.0.1:14318/v1/logs')).toBe(false)
    expect(isUsableDce('http://127.0.0.1:14318/v1/logs')).toBe(false)
    expect(isUsableDce('https://localhost/v1/logs')).toBe(false)
  })

  it('rejects garbage / empty / non-string input', () => {
    expect(isUsableDce('')).toBe(false)
    expect(isUsableDce('   ')).toBe(false)
    expect(isUsableDce('not a url')).toBe(false)
    expect(isUsableDce(null)).toBe(false)
    expect(isUsableDce(undefined)).toBe(false)
    expect(isUsableDce(42)).toBe(false)
  })

  it('rejects a leading-dash value', () => {
    expect(isUsableDce('-https://example.com')).toBe(false)
  })
})

describe('endpoint errors carry a VALUE-FREE reason code (CodeQL: clear-text logging)', () => {
  // The redeem bundle is SERVER-supplied, and validating it is an act of
  // distrust. Echoing the rejected value into an error the caller prints
  // carries untrusted bytes to a clear-text log sink — CodeQL flagged exactly
  // that path at copilot-redeem.mjs. Callers validating server input log
  // `reason`; callers validating the developer's OWN config keep the fuller
  // message, which is theirs to read.
  const cases: Array<[string, string]> = [
    ['', 'empty'],
    ['-K/tmp/payload', 'leading-dash'],
    ['not a url at all', 'not-a-url'],
    ['http://attacker.example.com/bearer', 'insecure-scheme'],
  ]
  for (const [input, reason] of cases) {
    it(`${JSON.stringify(input)} → reason '${reason}'`, () => {
      try {
        assertSafeEndpoint(input)
        throw new Error('should have thrown')
      } catch (e: unknown) {
        expect((e as { reason?: string }).reason).toBe(reason)
      }
    })
  }

  it('a reason code never contains the rejected value', () => {
    const secretish = 'http://attacker.example.com/steal?t=SUPER_SECRET_VALUE'
    try {
      assertSafeEndpoint(secretish)
    } catch (e: unknown) {
      const reason = (e as { reason?: string }).reason ?? ''
      expect(reason).not.toContain('SUPER_SECRET_VALUE')
      expect(reason).not.toContain('attacker.example.com')
      expect(reason).toBe('insecure-scheme')
    }
  })
})

/*
 * unsafeEndpointError — CodeQL js/clear-text-logging #7.
 *
 * The redaction rule ("reason only, never the value") was convention, and
 * convention did not hold it: callers built a value-FREE outer message but
 * attached `{ cause: err }`, whose inner message DOES embed the rejected
 * value. Node prints the cause chain — for console.error(err) in object form
 * and for an uncaught throw — so the value reached a clear-text sink through a
 * field no call site ever named. A comment at one site asserted the opposite.
 *
 * These assert on the FULL PRINTED FORM, not just `.message`, because
 * inspecting only `.message` is exactly the blind spot that let the leak sit
 * behind a comment claiming safety. `util.inspect` is what console.error uses
 * for an Error object, so this reproduces the real sink.
 */
describe('unsafeEndpointError — no untrusted byte survives into any printable field', () => {
  // Lowercase deliberately: URL parsing case-folds the hostname, so an
  // uppercase marker would not match the insecure-scheme message verbatim and
  // the vacuity guard below would fire on a leak it should have caught.
  const MARKER = 'super-secret-host-abc123.evil.example.com'

  function rejected(url: string): unknown {
    try {
      assertSafeEndpoint(url)
      throw new Error('expected assertSafeEndpoint to reject')
    } catch (err) {
      return err
    }
  }

  const vectors: Array<{ name: string; url: string; reason: string }> = [
    {
      name: 'insecure-scheme (value appears in the raw message)',
      url: `http://${MARKER}/x`,
      reason: 'insecure-scheme',
    },
    { name: 'not-a-url', url: `not a url ${MARKER}`, reason: 'not-a-url' },
    { name: 'leading-dash', url: `-${MARKER}`, reason: 'leading-dash' },
    { name: 'empty', url: '', reason: 'empty' },
  ]

  for (const v of vectors) {
    it(`${v.name}: redacted error leaks nothing under util.inspect`, () => {
      const raw = rejected(v.url)
      const redacted = unsafeEndpointError('Test bundle field', raw)

      // Sanity: for the vectors that embed it, the RAW error really does carry
      // the marker — otherwise this test would pass vacuously.
      if (v.reason !== 'empty') {
        expect(inspect(raw, { depth: null })).toContain(MARKER)
      }

      expect(redacted.message).not.toContain(MARKER)
      // The whole printed object: message + stack + cause chain + own props.
      expect(inspect(redacted, { depth: null })).not.toContain(MARKER)
      // Specifically: no cause chain is retained at all.
      expect((redacted as { cause?: unknown }).cause).toBeUndefined()
      // Classification survives — that is what diagnosis needs.
      expect(redacted.message).toContain('Test bundle field')
      expect((redacted as { reason?: string }).reason).toBe(v.reason)
    })
  }

  it('falls back to a stable reason when handed a non-endpoint-guard error', () => {
    const out = unsafeEndpointError('Some field', new Error(`boom ${MARKER}`))
    expect(inspect(out, { depth: null })).not.toContain(MARKER)
    expect((out as { reason?: string }).reason).toBe('invalid')
  })
})

/*
 * CALL-SITE PIN.
 *
 * The tests above prove unsafeEndpointError() redacts. They do NOT prove the
 * production code uses it — and that gap is exactly how CodeQL #7 survived: the
 * helper's contract was documented, one call site ignored it, and every unit
 * test still passed. This asserts the property at the call sites themselves.
 *
 * Source-level rather than behavioural because these are CLI entry points whose
 * failure paths call process.exit; the behavioural half is covered by
 * copilot-redeem-discovery.test.ts ("a plain-http .mcp.json url is refused, and
 * the rejected value is NOT printed").
 */
describe('endpoint-guard call sites', () => {
  const SCRIPTS = join(process.cwd(), 'plugin', 'scripts')

  // DISCOVERED, not hardcoded. An earlier revision listed three consumers by
  // name, and the list was already wrong: copilot-forwarder.mjs called the
  // guard and rejected the raw error, which is the same leak the pin exists to
  // prevent. A hardcoded list can only ever pin the sites someone remembered,
  // so a NEW consumer is unprotected by default — exactly backwards. Deriving
  // the list from the directory means adding a consumer opts it in
  // automatically, and the vacuity guard below catches the discovery breaking.
  const CONSUMERS = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => readFileSync(join(SCRIPTS, f), 'utf8').includes('assertSafeEndpoint('))
    // endpoint-guard.mjs DEFINES the helper rather than consuming it.
    .filter((f) => f !== 'endpoint-guard.mjs')
    .sort()

  it('discovers the guard consumers (vacuity guard for the pin below)', () => {
    // If discovery silently returned [], every per-file test below would vanish
    // and the suite would stay green while pinning nothing.
    expect(CONSUMERS.length).toBeGreaterThanOrEqual(3)
    // The known consumers must be among them; a rename that drops one should
    // fail here rather than quietly shrink the pinned set.
    expect(CONSUMERS).toEqual(
      expect.arrayContaining(['claude-redeem.mjs', 'copilot-redeem.mjs', 'copilot-forwarder.mjs']),
    )
  })

  /**
   * Strip comments: these files deliberately DESCRIBE the banned patterns in
   * their explanatory headers, and matching prose is a false positive.
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  /**
   * Brace-match every block in the file, skipping string and template literals
   * so a `{` inside a string cannot desynchronise the depth count.
   *
   * This replaces a fixed 500-character window. The window was a guess at
   * "roughly the enclosing catch block", and it was wrong in both directions:
   * any unrelated `catch {` occurring within 500 characters satisfied it, and a
   * genuinely long catch block would have fallen outside it. Matching the
   * actual block means the test asserts the real scope rather than a proxy.
   */
  function blocks(code: string): Array<[number, number]> {
    const stack: number[] = []
    const found: Array<[number, number]> = []
    let i = 0
    while (i < code.length) {
      const c = code[i]
      if (c === '"' || c === "'" || c === '`') {
        const quote = c
        i++
        while (i < code.length) {
          if (code[i] === '\\') {
            i += 2
            continue
          }
          if (code[i] === quote) break
          i++
        }
        i++
        continue
      }
      if (c === '{') stack.push(i)
      else if (c === '}') {
        const open = stack.pop()
        if (open !== undefined) found.push([open, i])
      }
      i++
    }
    return found
  }

  function guardOffsets(code: string): number[] {
    const out: number[] = []
    for (
      let i = code.indexOf('assertSafeEndpoint(');
      i !== -1;
      i = code.indexOf('assertSafeEndpoint(', i + 1)
    ) {
      if (code.slice(0, i).endsWith('import { ')) continue
      out.push(i)
    }
    return out
  }

  /** The innermost `try { ... }` block containing `at`, if any. */
  /**
   * Remove every `name(...)` call, parens balanced, so what remains is the code
   * that does something ELSE with the value. Used to tell "passed to the
   * redactor" apart from "leaked to a printer" without enumerating sinks.
   */
  function stripCalls(code: string, name: string): string {
    let out = ''
    let i = 0
    while (i < code.length) {
      const at = code.indexOf(`${name}(`, i)
      if (at === -1) {
        out += code.slice(i)
        break
      }
      out += code.slice(i, at)
      let depth = 0
      let j = at + name.length
      for (; j < code.length; j++) {
        if (code[j] === '(') depth++
        else if (code[j] === ')') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      i = j
    }
    return out
  }

  function enclosingTry(code: string, all: Array<[number, number]>, at: number) {
    return all
      .filter(([open, close]) => open < at && close > at)
      .filter(([open]) => /try\s*$/.test(code.slice(Math.max(0, open - 8), open)))
      .sort((a, b) => b[0] - a[0])[0]
  }

  for (const name of CONSUMERS) {
    it(`${name} never lets a rejected endpoint escape its catch`, () => {
      const src = readFileSync(join(SCRIPTS, name), 'utf8')
      // Vacuity guard: if the file stopped using the guard, this test would
      // trivially pass while proving nothing.
      expect(src).toContain('assertSafeEndpoint')

      const code = stripComments(src)
      const all = blocks(code)
      const offsets = guardOffsets(code)
      expect(offsets.length).toBeGreaterThan(0)

      for (const at of offsets) {
        const tryBlock = enclosingTry(code, all, at)
        // An unguarded call site rejects with the raw error straight to
        // whatever awaited it, which is the leak itself.
        expect(tryBlock, `${name}: assertSafeEndpoint at ${at} is not inside a try`).toBeTruthy()

        const header = code.slice(tryBlock![1] + 1, tryBlock![1] + 40)
        const bound = /^\s*catch\s*\(/.test(header)
        if (!bound) {
          // `catch {` never binds the error, so nothing can print it.
          // Discarding is as safe as redacting; demanding one particular
          // implementation would churn already-correct files while saying
          // nothing about whether the value escapes.
          expect(header, `${name}: guard at ${at} has no catch`).toMatch(/^\s*catch\s*\{/)
          continue
        }

        // The catch BODY, brace-matched, not a character window.
        const bodyOpen = code.indexOf('{', tryBlock![1] + 1)
        const body = all.find(([open]) => open === bodyOpen)
        expect(body, `${name}: could not resolve the catch body at ${at}`).toBeTruthy()
        const catchBody = code.slice(body![0], body![1])

        expect(
          catchBody,
          `${name}: catch for the guard at ${at} binds the error but never redacts it via unsafeEndpointError`,
        ).toContain('unsafeEndpointError(')
        // `{ cause: err }` re-attaches the chain Node prints — CodeQL #7.
        expect(catchBody, `${name}: catch at ${at} re-attaches a cause`).not.toMatch(/cause:\s*err/)
        // Interpolating the guard's own message embeds the rejected endpoint.
        expect(catchBody, `${name}: catch at ${at} interpolates err.message`).not.toMatch(
          /\$\{[^}]*err(or)?\.message/,
        )

        // The checks above prove a redaction EXISTS. They do not prove the raw
        // error stops there: `throw err`, `reject(err)`, `String(err)` or
        // `console.error(err.message)` alongside a redaction all still ship the
        // rejected endpoint to a printer. Rather than enumerate sinks -- an
        // enumeration is only ever as good as its last update -- strip the
        // redaction calls and require that the bound identifier does not appear
        // at all in what remains. Passing it to unsafeEndpointError is the one
        // legitimate use, so removing those calls leaves exactly the leaks.
        const boundName = /^\s*catch\s*\(\s*([A-Za-z_$][\w$]*)/.exec(header)?.[1]
        expect(boundName, `${name}: could not read the bound error name at ${at}`).toBeTruthy()
        const withoutRedactions = stripCalls(catchBody, 'unsafeEndpointError')
        expect(
          withoutRedactions,
          `${name}: catch at ${at} still uses '${boundName}' outside unsafeEndpointError, so the rejected endpoint can escape`,
        ).not.toMatch(new RegExp(`\\b${boundName}\\b`))
      }
    })
  }

  /*
   * The aggregate that used to live here counted `unsafeEndpointError(`
   * occurrences anywhere in the file against the number of guard sites needing
   * one. Two flaws: a decorative call elsewhere in the file satisfied it, and
   * although its comment claimed exact equality it asserted `>=`. The per-site
   * loop above subsumes it -- it resolves each catch body by brace matching and
   * checks that body -- so counting file-wide occurrences added a false green
   * and nothing else.
   */
})
