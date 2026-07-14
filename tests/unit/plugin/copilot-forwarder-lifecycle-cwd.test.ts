/**
 * forwarder-lifecycle resolveProjectDir — regression guard.
 *
 * Copilot runs the SessionStart/Stop hooks with cwd = the PLUGIN install dir, NOT the
 * project. It passes the project root as COPILOT_PROJECT_DIR (and CLAUDE_PROJECT_DIR for
 * compat). The per-project forwarder must take its cwd from that env — using
 * process.cwd() points the forwarder at the plugin dir, so it tails an empty span file
 * and nothing forwards (the bug found in dogfood against Copilot CLI 1.0.60).
 *
 * The hook's action dispatch is guarded behind an isDirectRun check, so importing the
 * module here is inert (no enrol / spawn / process.exit).
 */
import { describe, it, expect, afterEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { resolveProjectDir } = await import('../../../copilot-plugin/hooks/forwarder-lifecycle.mjs')

describe('resolveProjectDir — project root comes from env, not the plugin-dir cwd', () => {
  const saved = {
    copilot: process.env.COPILOT_PROJECT_DIR,
    claude: process.env.CLAUDE_PROJECT_DIR,
  }
  afterEach(() => {
    if (saved.copilot === undefined) delete process.env.COPILOT_PROJECT_DIR
    else process.env.COPILOT_PROJECT_DIR = saved.copilot
    if (saved.claude === undefined) delete process.env.CLAUDE_PROJECT_DIR
    else process.env.CLAUDE_PROJECT_DIR = saved.claude
  })

  it('prefers COPILOT_PROJECT_DIR (the project root Copilot hands the hook)', () => {
    process.env.COPILOT_PROJECT_DIR = '/proj/a'
    process.env.CLAUDE_PROJECT_DIR = '/proj/claude'
    expect(resolveProjectDir()).toBe('/proj/a')
  })

  it('falls back to CLAUDE_PROJECT_DIR when COPILOT_PROJECT_DIR is unset', () => {
    delete process.env.COPILOT_PROJECT_DIR
    process.env.CLAUDE_PROJECT_DIR = '/proj/b'
    expect(resolveProjectDir()).toBe('/proj/b')
  })

  it('falls back to process.cwd() when neither env is set (the forwarder guard then warns)', () => {
    delete process.env.COPILOT_PROJECT_DIR
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveProjectDir()).toBe(process.cwd())
  })
})
