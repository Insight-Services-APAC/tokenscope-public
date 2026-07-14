/*
 * env-builder — the per-repo OTel tag + settings-merge helpers.
 * Guards that merging never clobbers a developer's pre-existing local settings
 * and that the repo resource-attr string carries the instance id + code_hash.
 *
 * (The global device env block — buildDeviceEnvBlock — was removed in the
 * OAuth/MCP cutover; device emit is now provisioned by provision_emit →
 * /setup/redeem, not by this module.)
 */
import { describe, it, expect } from 'vitest'
import { buildRepoResourceAttrs, mergeClaudeSettings } from '../../../plugin/scripts/env-builder.mjs'

describe('buildRepoResourceAttrs', () => {
  it('carries the instance id, project.code_hash, and tool in the server attr ordering', () => {
    expect(buildRepoResourceAttrs('sid', 'abc123')).toBe(
      'tokenscope.instance_id=sid,project.code_hash=abc123,tool=claude-code',
    )
  })
})

describe('mergeClaudeSettings', () => {
  it('preserves existing keys, sets the helper, merges the env block', () => {
    const existing = { permissions: { allow: ['Bash(node:*)'] }, env: { FOO: 'bar' } }
    const merged = mergeClaudeSettings(existing, '/plugin/scripts/otel-headers-helper.sh', {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    })
    expect(merged.permissions).toEqual({ allow: ['Bash(node:*)'] })
    expect(merged.otelHeadersHelper).toBe('/plugin/scripts/otel-headers-helper.sh')
    expect(merged.env.FOO).toBe('bar') // pre-existing env preserved
    expect(merged.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1') // new merged in
  })

  it('handles a missing / non-object existing settings', () => {
    const merged = mergeClaudeSettings(null, '/h.sh', { A: '1' })
    expect(merged.env).toEqual({ A: '1' })
    expect(merged.otelHeadersHelper).toBe('/h.sh')
  })

  it('replaces the env block wholesale when replaceEnv is set (repo-pin self-heal)', () => {
    const existing = { permissions: { allow: ['x'] }, env: { STALE: 'gone', FOO: 'old' } }
    const merged = mergeClaudeSettings(existing, '/h.sh', { FOO: 'new' }, { replaceEnv: true })
    expect(merged.env).toEqual({ FOO: 'new' }) // STALE dropped, not key-merged
    expect(merged.permissions).toEqual({ allow: ['x'] }) // non-env keys preserved
  })
})
