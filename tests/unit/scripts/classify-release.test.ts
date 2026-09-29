// @vitest-environment node
/*
 * scripts/classify-release.mjs — the validation tier follows the files a
 * release changes, and breaking deploy changes refuse a non-major bump.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { classify, bumpOf, tierOf } from '../../../scripts/classify-release.mjs'

let base: string
let from: string
let to: string

function write(root: string, rel: string, content: string) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'release-'))
  from = join(base, 'from')
  to = join(base, 'to')
  write(from, 'infra/main.bicep', "param env string\nparam frontDoorSku string = 'Standard'\noutput containerAppUrl string = ''\n")
  write(from, 'infra/parameters/example-sandbox.bicepparam', "param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')\n")
  write(from, 'examples/github-actions/deploy.yml', 'on:\n  workflow_dispatch:\n    inputs:\n      build:\n        default: x\n      runner:\n        default: y\n  workflow_call:\n    inputs:\n      build:\n        type: string\n      runner:\n        type: string\n')
  write(from, 'package.json', JSON.stringify({ name: 't', version: '1.0.0', dependencies: { a: '1' } }))
  write(from, 'server/api/x.ts', 'export {}\n')
  write(from, 'docs/guide.md', '# Guide\n')
  cpSync(from, to, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('classify-release', () => {
  it('needs no validation for an identical tree or prose-only changes', () => {
    expect(classify(from, to).validation).toBe('none')
    write(to, 'docs/guide.md', '# Guide, reworded\n')
    write(to, 'examples/github-actions/README.md', 'new\n')
    expect(classify(from, to).validation).toBe('none')
  })

  it('needs one deployment for app code and anything unrecognised', () => {
    write(to, 'server/api/x.ts', 'export const y = 1\n')
    expect(classify(from, to).validation).toBe('sandbox')
    expect(tierOf('Dockerfile')).toBe('sandbox')
    expect(tierOf('package-lock.json')).toBe('sandbox')
  })

  it('needs both postures for templates and example workflows, and says why', () => {
    write(to, 'infra/modules/new.bicep', '// new\n')
    const r = classify(from, to)
    expect(r.validation).toBe('full')
    expect(r.reasons).toContain('infra/modules/new.bicep → full')
    expect(tierOf('examples/github-actions/tokenscope-infra.yml')).toBe('full')
  })

  it('reports breaking deploy changes and refuses them without a major bump', () => {
    write(to, 'infra/main.bicep', "param env string\nparam added string\noutput other string = ''\n")
    write(to, 'infra/parameters/example-sandbox.bicepparam', '\n')
    write(to, 'examples/github-actions/deploy.yml', 'on:\n  workflow_dispatch:\n    inputs:\n      build:\n        default: x\n  workflow_call:\n    inputs:\n      build:\n        type: string\n')
    const r = classify(from, to, { version: '1.1.0', previous: '1.0.0' })
    expect(r.breaking).toEqual([
      'infra/main.bicep parameter "frontDoorSku" removed',
      'infra/main.bicep parameter "added" is now required',
      'infra/main.bicep output "containerAppUrl" removed',
      'secrets variable PG_ADMIN_PASSWORD is no longer read by the example parameter files',
      'example workflow input deploy.yml workflow_dispatch.runner removed',
      'example workflow input deploy.yml workflow_call.runner removed',
    ])
    expect(r.ok).toBe(false)
    expect(classify(from, to, { version: '2.0.0', previous: '1.0.0' }).ok).toBe(true)
  })

  it('accepts a new optional parameter as non-breaking', () => {
    write(to, 'infra/main.bicep', "param env string\nparam frontDoorSku string = 'Standard'\nparam extra bool = false\noutput containerAppUrl string = ''\n")
    expect(classify(from, to, { version: '1.1.0', previous: '1.0.0' })).toMatchObject({ breaking: [], ok: true })
  })

  it('ignores a version-only bump of package.json', () => {
    write(to, 'package.json', JSON.stringify({ name: 't', version: '1.1.0', dependencies: { a: '1' } }))
    expect(classify(from, to).validation).toBe('none')
    write(to, 'package.json', JSON.stringify({ name: 't', version: '1.1.0', dependencies: { a: '2' } }))
    expect(classify(from, to).validation).toBe('sandbox')
  })

  it('needs the Front Door posture for code that behaves differently behind it', () => {
    write(from, 'server/utils/public-url.ts', 'const h = "x-forwarded-host"\n')
    write(to, 'server/utils/public-url.ts', 'const h = "x-forwarded-host" // reworked\n')
    expect(classify(from, to).reasons).toContain('server/utils/public-url.ts → full')
  })

  it('reports a newly required secret, only a removed workflow_call input, and a default lost to a comment', () => {
    write(to, 'infra/parameters/example-sandbox.bicepparam',
      "param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')\nparam k = readEnvironmentVariable('NEW_KEY')\nparam o = readEnvironmentVariable('OPTIONAL', '')\n")
    write(to, 'examples/github-actions/deploy.yml', 'on:\n  workflow_dispatch:\n    inputs:\n      build:\n        default: x\n      runner:\n        default: y\n  workflow_call:\n    inputs:\n      build:\n        type: string\n')
    write(to, 'infra/main.bicep', "param env string\nparam frontDoorSku string // was = 'Standard'\noutput containerAppUrl string = ''\n")
    expect(classify(from, to).breaking).toEqual([
      'infra/main.bicep parameter "frontDoorSku" is now required',
      'secrets variable NEW_KEY is now required by the example parameter files',
      'example workflow input deploy.yml workflow_call.runner removed',
    ])
  })

  it('treats a nullable parameter as optional and lists changed defaults', () => {
    write(to, 'infra/main.bicep', "param env string\nparam frontDoorSku string = 'Premium'\nparam note string?\noutput containerAppUrl string = ''\n")
    const r = classify(from, to)
    expect(r.breaking).toEqual([])
    expect(r.defaults).toEqual(["infra/main.bicep parameter \"frontDoorSku\" default 'Standard' -> 'Premium'"])
  })

  it('names the semver step and rejects anything that is not one', () => {
    expect(bumpOf('1.0.0', '1.0.1')).toBe('patch')
    expect(bumpOf('1.0.3', '1.1.0')).toBe('minor')
    expect(bumpOf('1.4.2', '2.0.0')).toBe('major')
    for (const v of ['1.0.0', '0.9.0', '1.2.0-rc.1', '2.1.0', '1.1.1']) expect(bumpOf('1.0.0', v)).toBe('invalid')
  })
})
