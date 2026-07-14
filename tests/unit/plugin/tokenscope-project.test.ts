/*
 * tokenscope-project — the extracted client-neutral resolver/hasher (P0-2).
 *
 * Pins the four functions both clients (Claude + Copilot) MUST agree on so an
 * identical `.tokenscope` derives the SAME project.code_hash:
 *   - findTokenscopeFile / parseTokenscope  (walk-up + tiny-YAML)
 *   - computeCodeHash                         (sha256 hex == server)
 *   - resolveRepoProjectCode                  (arg or committed file → code)
 *
 * Also guards the LATENT FORMAT-DRIFT bug (P0-1 precondition): a BARE one-line
 * `.tokenscope` parses to NO project.code, so resolveRepoProjectCode throws — the
 * exact behaviour the project skill's YAML rewrite is required to avoid.
 *
 * Cross-module identity: re-exports through tokenscope-reader.mjs and tag-repo.mjs
 * MUST resolve to the SAME functions (no accidental duplication after extraction).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
import {
  findTokenscopeFile, parseTokenscope, computeCodeHash, resolveRepoProjectCode,
} from '../../../plugin/scripts/tokenscope-project.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as reader from '../../../plugin/scripts/tokenscope-reader.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as tagRepo from '../../../plugin/scripts/tag-repo.mjs'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ts-project-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('computeCodeHash', () => {
  it('is sha256(code) plain hex (matches the server derivation)', () => {
    const code = 'TokenScope-MVP'
    expect(computeCodeHash(code)).toBe(createHash('sha256').update(code).digest('hex'))
  })
})

describe('parseTokenscope — YAML project block (matches the skill-written form)', () => {
  it('reads code from an indented `code:` under `project:`', () => {
    const p = join(dir, '.tokenscope')
    writeFileSync(p, '# TokenScope\nproject:\n  code: TokenScope-MVP\n')
    expect(parseTokenscope(p).project.code).toBe('TokenScope-MVP')
  })

  it('LATENT DRIFT: a bare one-liner yields NO project.code (P0-1 precondition)', () => {
    const p = join(dir, '.tokenscope')
    writeFileSync(p, 'TokenScope-MVP\n') // the OLD, wrong skill output
    const parsed = parseTokenscope(p)
    expect(parsed.project.code).toBeUndefined()
  })
})

describe('resolveRepoProjectCode', () => {
  it('prefers an explicit arg (trimmed)', () => {
    expect(resolveRepoProjectCode({ arg: '  ABC ', cwd: dir })).toEqual({
      code: 'ABC', source: 'arg', tokenscopePath: null,
    })
  })

  it('resolves from a committed YAML .tokenscope walked up from cwd', () => {
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: NAB-CIB\n')
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    const r = resolveRepoProjectCode({ arg: '', cwd: nested })
    expect(r.code).toBe('NAB-CIB')
    expect(r.source).toBe('tokenscope')
    expect(r.tokenscopePath).toBe(join(dir, '.tokenscope'))
  })

  it('throws on a bare one-liner .tokenscope (no project.code) — drift surfaced', () => {
    writeFileSync(join(dir, '.tokenscope'), 'TokenScope-MVP\n')
    expect(() => resolveRepoProjectCode({ arg: '', cwd: dir })).toThrow(/no project\.code/)
  })

  it('throws when no .tokenscope exists above cwd', () => {
    expect(() => resolveRepoProjectCode({ arg: '', cwd: dir })).toThrow(/Could not resolve/)
  })
})

describe('extraction identity — no accidental duplication', () => {
  it('tokenscope-reader.mjs re-exports the SAME find/parse functions', () => {
    expect(reader.findTokenscopeFile).toBe(findTokenscopeFile)
    expect(reader.parseTokenscope).toBe(parseTokenscope)
  })

  it('tag-repo.mjs re-exports the SAME computeCodeHash/resolveRepoProjectCode', () => {
    expect(tagRepo.computeCodeHash).toBe(computeCodeHash)
    expect(tagRepo.resolveRepoProjectCode).toBe(resolveRepoProjectCode)
  })
})
