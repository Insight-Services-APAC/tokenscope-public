/*
 * writeTokenscopeFile — the one-step `/tokenscope:project <code>` path writes a
 * committable .tokenscope AND tags. These tests pin: (a) a fresh write is
 * parseable and minimal, (b) re-writing with a new code preserves existing
 * project.name + top-level optional fields, (c) the emitted file round-trips
 * through parseTokenscope (the reader expects optional fields at top level).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeTokenscopeFile, computeCodeHash } from '../../../plugin/scripts/tag-repo.mjs'
import { parseTokenscope } from '../../../plugin/scripts/tokenscope-reader.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-write-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeTokenscopeFile', () => {
  it('creates a parseable, minimal .tokenscope when none exists', () => {
    const p = writeTokenscopeFile(dir, 'TokenScope-MVP')
    expect(p).toBe(join(dir, '.tokenscope'))
    expect(parseTokenscope(p).project.code).toBe('TokenScope-MVP')
  })

  it('preserves project.name + top-level optional fields when re-writing the code', () => {
    const p = join(dir, '.tokenscope')
    writeFileSync(p, 'project:\n  code: OLD\n  name: Old Name\nclient: Acme\n')
    writeTokenscopeFile(dir, 'TokenScope-MVP')
    const parsed = parseTokenscope(p)
    expect(parsed.project.code).toBe('TokenScope-MVP')
    expect(parsed.project.name).toBe('Old Name')
    expect(parsed.optional.client).toBe('Acme')
  })

  it('emits optional fields at top level so the file round-trips through the reader', () => {
    const p = join(dir, '.tokenscope')
    writeFileSync(p, 'project:\n  code: X\npractice: Data\n')
    writeTokenscopeFile(dir, 'Y')
    // No nested `optional:` block — the reader only reads top-level optional keys.
    expect(readFileSync(p, 'utf8')).not.toContain('optional:')
    expect(parseTokenscope(p).optional.practice).toBe('Data')
  })

  it('rejects a project code that would not round-trip (#, ", newline, edge whitespace)', () => {
    // A `#` is stripped as a comment, `"` collides with value quoting, newlines
    // split lines, and leading/trailing whitespace is trimmed by the reader —
    // any of these make a later no-arg read derive a different code_hash and
    // split the spend.
    for (const bad of ['Foo # bar', 'Foo"bar', 'Foo\nbar', '  Lead', 'Trail  ', '']) {
      expect(() => writeTokenscopeFile(dir, bad)).toThrow()
    }
    // A clean code (letters, digits, -, _, internal spaces, colons) still writes.
    expect(() => writeTokenscopeFile(dir, 'TokenScope-MVP')).not.toThrow()
  })

  it('computes a code_hash that matches the server (sha256 plain hex)', () => {
    expect(computeCodeHash('TokenScope-MVP')).toBe(
      createHash('sha256').update('TokenScope-MVP').digest('hex'),
    )
  })
})
