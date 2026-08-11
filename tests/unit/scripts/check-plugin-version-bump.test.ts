// @vitest-environment node
/*
 * scripts/check-plugin-version-bump.mjs — the comparator that stops a
 * same-version (or lower-version) plugin-code edit from shipping silently.
 * tests/unit/plugin/version-sync.test.ts only asserts plugin.json and the
 * marketplace entry AGREE with each other; it never asserts either one goes
 * UP. This test drives `evaluateBump` — the pure decision function, no git
 * shelling out — over the five scenarios the story names: same version,
 * lower version, higher version, no plugin files touched, docs-only touched.
 */
import { describe, it, expect } from 'vitest'
import { evaluateBump, touchesSurface, compareSemver, SURFACES } from '../../../scripts/check-plugin-version-bump.mjs'

const claudeSurface = SURFACES.find((s) => s.marketplaceEntryName === 'tokenscope')!
const copilotSurface = SURFACES.find((s) => s.marketplaceEntryName === 'tokenscope-copilot')!

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('0.1.27', '0.1.27')).toBe(0)
    expect(compareSemver('0.1.28', '0.1.27')).toBe(1)
    expect(compareSemver('0.1.26', '0.1.27')).toBe(-1)
    expect(compareSemver('0.2.0', '0.1.99')).toBe(1)
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1)
  })

  it('throws on a malformed version instead of silently coercing', () => {
    expect(() => compareSemver('0.1', '0.1.0')).toThrow()
    expect(() => compareSemver('v0.1.0', '0.1.0')).toThrow()
  })
})

describe('touchesSurface', () => {
  it('matches a file under a prefix', () => {
    expect(touchesSurface(['plugin/scripts/copilot-forwarder.mjs'], claudeSurface)).toBe(true)
  })

  it('does not match an unrelated file', () => {
    expect(touchesSurface(['server/api/health.get.ts'], claudeSurface)).toBe(false)
  })

  it('carves out the doc-only path', () => {
    expect(touchesSurface(['plugin/README.md'], claudeSurface)).toBe(false)
  })

  it('a docs-only touch plus a real touch still counts as touched', () => {
    expect(touchesSurface(['plugin/README.md', 'plugin/hooks/session-start.mjs'], claudeSurface)).toBe(true)
  })

  it('copilot surface matches its own prefixes, not the claude ones', () => {
    expect(touchesSurface(['copilot-plugin/scripts/copilot-forwarder.mjs'], copilotSurface)).toBe(true)
    expect(touchesSurface(['plugin/scripts/copilot-forwarder.mjs'], copilotSurface)).toBe(false)
  })
})

describe('evaluateBump', () => {
  const changedPluginFiles = ['plugin/scripts/copilot-forwarder.mjs']
  const changedDocsOnly = ['plugin/README.md']
  const changedUnrelated = ['server/api/health.get.ts']

  it('same version → required, NOT ok (this is the regression the gate exists to catch)', () => {
    const result = evaluateBump({
      changedFiles: changedPluginFiles,
      surface: claudeSurface,
      oldVersion: '0.1.27',
      newVersion: '0.1.27',
    })
    expect(result.required).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.cmp).toBe(0)
  })

  it('lower version → required, NOT ok', () => {
    const result = evaluateBump({
      changedFiles: changedPluginFiles,
      surface: claudeSurface,
      oldVersion: '0.1.27',
      newVersion: '0.1.26',
    })
    expect(result.required).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.cmp).toBe(-1)
  })

  it('higher version → required, ok', () => {
    const result = evaluateBump({
      changedFiles: changedPluginFiles,
      surface: claudeSurface,
      oldVersion: '0.1.27',
      newVersion: '0.1.28',
    })
    expect(result.required).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.cmp).toBe(1)
  })

  it('no plugin files touched → not required, vacuously ok even with a same/lower version', () => {
    const result = evaluateBump({
      changedFiles: changedUnrelated,
      surface: claudeSurface,
      oldVersion: '0.1.27',
      newVersion: '0.1.27',
    })
    expect(result.required).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.cmp).toBeNull()
  })

  it('docs-only touched (plugin/README.md) → not required, vacuously ok', () => {
    const result = evaluateBump({
      changedFiles: changedDocsOnly,
      surface: claudeSurface,
      oldVersion: '0.1.27',
      newVersion: '0.1.27',
    })
    expect(result.required).toBe(false)
    expect(result.ok).toBe(true)
  })

  it('the copilot surface is evaluated independently of the claude surface', () => {
    const result = evaluateBump({
      changedFiles: ['copilot-plugin/hooks/session-start.mjs'],
      surface: copilotSurface,
      oldVersion: '0.1.6',
      newVersion: '0.1.6',
    })
    expect(result.required).toBe(true)
    expect(result.ok).toBe(false)
  })
})
