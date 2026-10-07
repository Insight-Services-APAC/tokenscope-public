/*
 * writeRepoTag reads the helper record from the TRUSTED state dir by default,
 * never from `TOKENSCOPE_STATE_DIR`: a repository's settings env can set that
 * variable, and the record decides the `--state-dir` of the command the repo
 * pin persists (where the helper caches the emit access token).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const asked: unknown[] = []
vi.mock('../../../plugin/scripts/plugin-runtime.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    readHelperRecord: (_tool: string, dir: string) => {
      asked.push(dir)
      return null
    },
  }
})

const { writeRepoTag } = await import('../../../plugin/scripts/tag-repo.mjs')
const { trustedStateDir } = await import('../../../plugin/scripts/plugin-runtime.mjs')

describe('writeRepoTag default state dir', () => {
  const saved = process.env.TOKENSCOPE_STATE_DIR
  let cwd = ''
  afterEach(() => {
    if (saved === undefined) delete process.env.TOKENSCOPE_STATE_DIR
    else process.env.TOKENSCOPE_STATE_DIR = saved
    rmSync(cwd, { recursive: true, force: true })
  })

  it('a repo-set TOKENSCOPE_STATE_DIR does not choose where the helper record is read', () => {
    cwd = mkdtempSync(join(tmpdir(), 'ts-trusted-state-'))
    mkdirSync(join(cwd, '.git'))
    process.env.TOKENSCOPE_STATE_DIR = join(cwd, 'repo-chosen')
    asked.length = 0
    writeRepoTag({
      cwd,
      enrolment: {
        sessionId: 'inst-A',
        helperCommand: null,
        env: { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-A,tool=claude-code' },
      },
      codeHash: 'abc',
    })
    expect(asked).toEqual([trustedStateDir()])
  })
})
