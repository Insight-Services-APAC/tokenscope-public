/*
 * copilot-forwarder — PER-PROJECT tagging + org stamp + .gitignore self-heal.
 *
 * The forwarder is now per PROJECT (cwd = project root), not per HOME, so there is
 * exactly ONE repo in play and the old cross-repo-bleed guard (boundRepo /
 * lastBatchRepos / F3-deferral) is OBSOLETE and removed. These tests pin the
 * re-architected behaviour:
 *   - repoFromSpan reads `github.copilot.git.repository` from BOTH span shapes
 *     (it rides invoke_agent ONLY — spike-verified; used only as the org fallback).
 *   - resolveProjectCodeHash derives the hash from the cwd `.tokenscope` via the
 *     SHARED resolver (Copilot + Claude hash identically), NOT cfg.otel_resource_attributes,
 *     and with NO cross-repo guard (per-project = one repo).
 *   - parseGithubOrg / resolveGithubOrg derive the org for F2 keying: git remote
 *     first, span repo fallback, null when neither.
 *   - ensureGitignored idempotently appends `.tokenscope.local/` to the project .gitignore.
 *   - readNewSpans captures the batch repo (org fallback) from invoke_agent spans it
 *     does NOT forward.
 *
 * No network, no Azure, no daemon spawn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const suiteDir = mkdtempSync(join(tmpdir(), 'ts-tag-suite-'))
process.env.TOKENSCOPE_FWD_OFFSET_FILE = join(suiteDir, 'forwarder-offset')
process.env.TOKENSCOPE_FWD_PID_FILE = join(suiteDir, 'forwarder.pid')

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const {
  repoFromSpan, resolveProjectCodeHash, parseGithubOrg, resolveGithubOrg,
  ensureGitignored, readNewSpans, _resetStateForTest, _getLastBatchRepo,
} = await import('../../../plugin/scripts/copilot-forwarder.mjs')

const HASH = (code: string) => createHash('sha256').update(code).digest('hex')

// File-exporter shape span builders.
function invokeAgentSpan(repo: string | null) {
  const attributes: Record<string, unknown> = { 'gen_ai.operation.name': 'invoke_agent' }
  if (repo != null) attributes['github.copilot.git.repository'] = repo
  return { type: 'span', name: 'invoke_agent', spanId: 'ia', attributes }
}
function chatSpan(spanId = 'c1') {
  return {
    type: 'span', name: 'chat m', spanId, endTime: [1780825137, 0],
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm',
      'gen_ai.conversation.id': 'conv', 'gen_ai.usage.input_tokens': 10,
    },
  }
}

let dir: string
let spanFile: string
beforeEach(() => {
  _resetStateForTest()
  dir = mkdtempSync(join(tmpdir(), 'ts-tag-'))
  spanFile = join(dir, 'copilot-otel.ndjson')
  rmSync(process.env.TOKENSCOPE_FWD_OFFSET_FILE!, { force: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('repoFromSpan', () => {
  it('reads the repo from a file-exporter invoke_agent span', () => {
    expect(repoFromSpan(invokeAgentSpan('Org/Repo'))).toBe('Org/Repo')
  })
  it('reads the repo from an OTLP wire-shape span', () => {
    const span = { attributes: [{ key: 'github.copilot.git.repository', value: { stringValue: 'Org/Repo' } }] }
    expect(repoFromSpan(span)).toBe('Org/Repo')
  })
  it('returns null when the attr is absent (chat spans never carry it)', () => {
    expect(repoFromSpan(chatSpan())).toBeNull()
    expect(repoFromSpan(invokeAgentSpan(null))).toBeNull()
    expect(repoFromSpan(invokeAgentSpan('   '))).toBeNull()
    expect(repoFromSpan({})).toBeNull()
  })
})

describe('resolveProjectCodeHash — F5 cwd .tokenscope derivation (per-project, no guard)', () => {
  it('derives the hash from the cwd .tokenscope', () => {
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: TokenScope-MVP\n')
    expect(resolveProjectCodeHash({}, { cwd: dir })).toBe(HASH('TokenScope-MVP'))
  })

  it('untagged (null) when the cwd has no .tokenscope — honest, not a crash', () => {
    expect(resolveProjectCodeHash({}, { cwd: dir })).toBeNull()
  })

  it('IGNORES cfg.otel_resource_attributes (the legacy config-stamp is gone)', () => {
    const cfg = { otel_resource_attributes: 'project.code_hash=deadbeef,tool=copilot-cli' }
    // No .tokenscope above the temp cwd → null, even though config has a hash.
    expect(resolveProjectCodeHash(cfg, { cwd: dir })).toBeNull()
  })

  it('per-project = one repo: the cwd hash always applies (no cross-repo guard inputs)', () => {
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: TokenScope-MVP\n')
    // The forwarder no longer threads any repo set / boundRepo — the cwd hash applies
    // unconditionally because the daemon is scoped to one project root.
    expect(resolveProjectCodeHash({}, { cwd: dir })).toBe(HASH('TokenScope-MVP'))
  })
})

describe('parseGithubOrg — org from a remote URL or slug', () => {
  it('parses https remotes', () => {
    expect(parseGithubOrg('https://github.com/Insight-Services-APAC/a sibling project.git')).toBe('insight-services-apac')
    expect(parseGithubOrg('https://github.com/acme/repo')).toBe('acme')
  })
  it('parses ssh / scp-style remotes', () => {
    expect(parseGithubOrg('git@github.com:acme/repo.git')).toBe('acme')
    expect(parseGithubOrg('ssh://git@github.com/acme/repo.git')).toBe('acme')
  })
  it('parses GitHub Enterprise hosts (org is the key, host is not)', () => {
    expect(parseGithubOrg('https://github.acme-corp.com/platform/infra.git')).toBe('platform')
  })
  it('strips an explicit :port on https and GHE/scp hosts', () => {
    expect(parseGithubOrg('https://github.com:443/acme/repo.git')).toBe('acme')
    expect(parseGithubOrg('ssh://git@github.example.com:2222/acme/repo.git')).toBe('acme')
  })
  it('parses a dotless scp host (e.g. localhost) without leaking user@host into the org', () => {
    expect(parseGithubOrg('git@localhost:acme/repo.git')).toBe('acme')
  })
  it('parses userinfo with a password', () => {
    expect(parseGithubOrg('https://user:pass@github.com/acme/repo.git')).toBe('acme')
  })
  it('parses a bare org/repo slug (the span-attr fallback shape)', () => {
    expect(parseGithubOrg('acme/repo')).toBe('acme')
  })
  it('null for empty / unparseable / non-github noise', () => {
    expect(parseGithubOrg('')).toBeNull()
    expect(parseGithubOrg(null)).toBeNull()
    expect(parseGithubOrg('not a url')).toBeNull()
    expect(parseGithubOrg('justrepo')).toBeNull()
  })
})

describe('resolveGithubOrg — git remote first, span repo fallback, null otherwise', () => {
  it('PRIMARY: the git remote wins over the span repo', () => {
    const readRemote = () => 'https://github.com/Insight/platform.git'
    expect(resolveGithubOrg({ cwd: dir, spanRepo: 'OtherOrg/x', readRemote })).toBe('insight')
  })
  it('FALLBACK: the span repo when there is no remote', () => {
    const readRemote = () => null
    expect(resolveGithubOrg({ cwd: dir, spanRepo: 'Client/x', readRemote })).toBe('client')
  })
  it('NULL: no remote and no span repo (untagged-enterprise is acceptable)', () => {
    expect(resolveGithubOrg({ cwd: dir, spanRepo: null, readRemote: () => null })).toBeNull()
  })
})

describe('ensureGitignored — telemetry dir is never committed', () => {
  // ensureGitignored only acts inside a real git work tree (never creates a .gitignore
  // in a non-git dir like $HOME) — mark the temp dir as one.
  beforeEach(() => { mkdirSync(join(dir, '.git'), { recursive: true }) })

  it('skips a non-git dir (no .gitignore created)', () => {
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    expect(ensureGitignored(dir)).toBe(false)
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
  })

  it('appends .tokenscope.local/ when the .gitignore lacks it', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    expect(ensureGitignored(dir)).toBe(true)
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(gi).toMatch(/node_modules\//)
    expect(gi).toMatch(/\.tokenscope\.local\//)
  })

  it('creates a .gitignore when none exists', () => {
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
    expect(ensureGitignored(dir)).toBe(true)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/\.tokenscope\.local\//)
  })

  it('is idempotent — a second call is a no-op (no duplicate entry)', () => {
    expect(ensureGitignored(dir)).toBe(true)
    expect(ensureGitignored(dir)).toBe(false)
    const occurrences = readFileSync(join(dir, '.gitignore'), 'utf8')
      .split('\n').filter((l) => l.trim().replace(/\/$/, '') === '.tokenscope.local').length
    expect(occurrences).toBe(1)
  })

  it('recognises existing forms (leading slash, no trailing slash)', () => {
    writeFileSync(join(dir, '.gitignore'), '/.tokenscope.local\n')
    expect(ensureGitignored(dir)).toBe(false)
  })
})

describe('readNewSpans — captures the batch repo (org fallback) from invoke_agent', () => {
  it('keeps only chat spans BUT records the repo from invoke_agent spans', () => {
    writeFileSync(spanFile,
      JSON.stringify(invokeAgentSpan('Insight/A')) + '\n' +
      JSON.stringify(chatSpan('c1')) + '\n')
    const spans = readNewSpans(spanFile)
    // Only the chat span is forwarded...
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('c1')
    // ...but the repo was captured for the org-stamp fallback.
    expect(_getLastBatchRepo()).toBe('Insight/A')
  })

  it('null when no span in the batch carries a repo', () => {
    writeFileSync(spanFile, JSON.stringify(chatSpan('c1')) + '\n')
    readNewSpans(spanFile)
    expect(_getLastBatchRepo()).toBeNull()
  })
})
