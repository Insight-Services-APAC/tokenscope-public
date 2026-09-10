/*
 * F299 — a committed `.gitignore` symlink must not redirect our append.
 *
 * THE DEFECT. Git stores a symlink as mode 120000 and checkout recreates it, so
 * a hostile repo can ship a `.gitignore` that is a symlink to any path the
 * developer can write. `ensureGitignored` read and appended by pathname with no
 * type check. The content appended is fixed, so this is not code execution —
 * but aimed at `~/.claude/settings.json` it makes that file unparseable, and
 * every reader fails closed: silent, durable, device-wide de-enrolment. It
 * needs no env steering at all, and BOTH lanes reach it (the Claude lane calls
 * it on every tagged repo at session start).
 *
 * Both bundles are asserted, because `copilot-plugin/` vendors its own copy —
 * the duplicate class that made up 27% of the MDASH findings. Revert either
 * implementation to `appendFileSync` and its case goes red.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, realpathSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureGitignored as claudeLane } from '../../../plugin/scripts/copilot-forwarder.mjs'
import { ensureGitignored as copilotLane } from '../../../copilot-plugin/scripts/copilot-forwarder.mjs'

let sandbox: string
let repo: string
let victim: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'gitignore-')))
  repo = join(sandbox, 'repo')
  // `.git` is REQUIRED: ensureGitignored short-circuits on `isGitRepo(cwd)`
  // before it ever reaches the append, so without this the refusal assertions
  // below pass for the wrong reason and certify nothing.
  mkdirSync(join(repo, '.git'), { recursive: true })
  victim = join(sandbox, 'settings.json')
  writeFileSync(victim, '{"env":{"TOKENSCOPE_BEARER_ENDPOINT":"https://real"}}\n')
})

afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

const lanes: [string, typeof claudeLane][] = [
  ['claude lane (plugin/)', claudeLane],
  ['copilot lane (copilot-plugin/)', copilotLane],
]

describe.each(lanes)('ensureGitignored — %s', (_label, ensureGitignored) => {
  it('refuses a .gitignore that is a SYMLINK, leaving the target untouched', () => {
    const before = readFileSync(victim, 'utf8')
    symlinkSync(victim, join(repo, '.gitignore')) // what `git checkout` recreates

    const wrote = ensureGitignored(repo)

    expect(wrote, 'reported a write through a symlink').toBe(false)
    expect(readFileSync(victim, 'utf8'), 'the symlink target was APPENDED TO').toBe(before)
    // and the link itself is still a link — we did not clobber it either
    expect(lstatSync(join(repo, '.gitignore')).isSymbolicLink()).toBe(true)
  })

  it('still creates a .gitignore when there is none', () => {
    expect(ensureGitignored(repo)).toBe(true)
    const written = readFileSync(join(repo, '.gitignore'), 'utf8')
    expect(written).toContain('.tokenscope.local/')
    expect(lstatSync(join(repo, '.gitignore')).isFile()).toBe(true)
  })

  it('still appends to a real .gitignore, and is idempotent', () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
    expect(ensureGitignored(repo)).toBe(true)
    const once = readFileSync(join(repo, '.gitignore'), 'utf8')
    expect(once).toContain('node_modules')
    expect(ensureGitignored(repo), 'appended a second time').toBe(false)
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(once)
  })
})

describe('writeRepoTag refuses a symlinked .claude (MDASH r3)', () => {
  it('does not write credentials through a committed directory symlink', async () => {
    const { writeRepoTag } = await import('../../../plugin/scripts/tag-repo.mjs')
    const victimDir = join(sandbox, 'victim')
    mkdirSync(victimDir, { recursive: true })
    // What `git checkout` recreates from a committed mode-120000 entry.
    symlinkSync(victimDir, join(repo, '.claude'))

    const r = writeRepoTag({
      cwd: repo,
      enrolment: {
        instanceId: 'inst-A',
        helperPath: join(sandbox, 'helper.sh'),
        env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt_DURABLE' },
      },
      codeHash: 'abc123',
    })

    expect(r.settingsPath, 'wrote through a symlinked .claude').toBeNull()
    expect(r.changed).toBe(false)
    expect(
      readdirSync(victimDir).length,
      'a credential-bearing file landed in the symlink target',
    ).toBe(0)
  })
})

describe('writeRepoTag refuses a symlinked settings.local.json', () => {
  it('does not merge fields from, or block on, a committed file symlink', async () => {
    const { writeRepoTag } = await import('../../../plugin/scripts/tag-repo.mjs')
    const decoy = join(sandbox, 'decoy.json')
    writeFileSync(decoy, JSON.stringify({ env: { SOMETHING_ELSE: 'from-the-decoy' } }))
    mkdirSync(join(repo, '.claude'), { recursive: true })
    symlinkSync(decoy, join(repo, '.claude', 'settings.local.json'))

    const r = writeRepoTag({
      cwd: repo,
      enrolment: { instanceId: 'inst-A', helperPath: join(sandbox, 'h.sh'), env: {} },
      codeHash: 'abc123',
    })

    expect(r.settingsPath, 'read through a symlinked settings.local.json').toBeNull()
    // the decoy is untouched, and its fields were not merged anywhere
    expect(JSON.parse(readFileSync(decoy, 'utf8')).env.SOMETHING_ELSE).toBe('from-the-decoy')
  })
})
