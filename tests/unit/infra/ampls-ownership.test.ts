/*
 * A second Azure Monitor Private Link Scope on shared privatelink zones is an
 * outage, not a duplicate: one zone holds ONE set of Monitor A records, so the
 * scope whose PE registers last takes them and blackholes the other — silently,
 * with both deploys green. An env on central DNS zones must therefore consume
 * the central scope, and no other gate can see it: the records move outside any
 * template. History: docs/design/telemetry-query-network-posture.md.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const PARAMS_DIR = resolve(ROOT, 'infra/parameters')
const MONITORING = resolve(ROOT, 'infra/modules/monitoring.bicep')

const isTrue = (src: string, param: string): boolean =>
  new RegExp(`^param ${param}\\s*=\\s*true\\b`, 'm').test(src)

const isNonEmptyString = (src: string, param: string): boolean => {
  const declared = new RegExp(`^param ${param}\\s*=\\s*'([^']*)'`, 'm').exec(src)
  return declared !== null && declared[1].length > 0
}

describe('AMPLS ownership', () => {
  const paramFiles = readdirSync(PARAMS_DIR).filter((f) => f.endsWith('.bicepparam'))

  it('every env on central DNS zones with private query consumes the central scope', () => {
    expect(paramFiles.length, 'no .bicepparam files found — did infra/parameters move?').toBeGreaterThan(0)

    const wouldCompete = paramFiles.filter((file) => {
      const src = readFileSync(resolve(PARAMS_DIR, file), 'utf8')
      return (
        isTrue(src, 'monitorQueryPrivateOnly') &&
        isNonEmptyString(src, 'centralDnsZonesSubscriptionId') &&
        !isTrue(src, 'useCentralAmpls')
      )
    })

    expect(wouldCompete, 'these envs would deploy a scope of our own onto IT-owned privatelink zones and overwrite their Monitor records').toEqual([])
  })

  it('a central scope id is never set without a subnet to put the endpoint in', () => {
    // The PE needs BOTH: a scope to point at and a subnet to live in. Set the id
    // alone and the deploy succeeds with public query disabled and no private
    // path to reach it — the escape hatch silently doing nothing, in the incident
    // it exists for.
    const stranded = paramFiles.filter((file) => {
      const src = readFileSync(resolve(PARAMS_DIR, file), 'utf8')
      return isNonEmptyString(src, 'centralAmplsResourceId') && !isNonEmptyString(src, 'amplsSubnetPrefix')
    })

    expect(stranded, 'these set centralAmplsResourceId with no amplsSubnetPrefix — the id is ignored and no PE is deployed').toEqual([])
  })

  it('useCentralAmpls gates the scope, its workspace link, and our private endpoint', () => {
    const src = readFileSync(MONITORING, 'utf8')

    // A decorative flag would pass the check above while still deploying a scope.
    expect(src).toContain("privateLinkScopes@2021-07-01-preview' = if (enableQueryPrivateLink && !useCentralAmpls)")
    expect(src).toContain("scopedResources@2021-07-01-preview' = if (enableQueryPrivateLink && !useCentralAmpls)")
    expect(src).toMatch(/var deployAmplsPrivateEndpoint = .*\(!useCentralAmpls \|\| !empty\(centralAmplsResourceId\)\)/)
    // The variable existing proves nothing — the PE resource has to CONSUME it.
    // Reverting the condition alone would leave every other assertion here green.
    expect(src).toContain("resource amplsPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (deployAmplsPrivateEndpoint)")
    expect(src).toContain('privateLinkServiceId: useCentralAmpls ? centralAmplsResourceId : ampls!.id')
  })
})
