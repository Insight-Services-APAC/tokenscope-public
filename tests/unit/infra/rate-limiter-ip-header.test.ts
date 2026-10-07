/*
 * Behind Front Door the app rate limiter keys on X-Azure-SocketIP, the TCP peer
 * Front Door saw. X-Azure-ClientIP follows a caller's X-Forwarded-For, so keying
 * on it let a caller pick its own bucket. oauth/register keys its registration
 * ceiling on the socket IP for the same reason; the two must not diverge
 * (docs/design/scaling-to-1000-users.md 0.7).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const CONTAINER_APP = readFileSync(resolve(ROOT, 'infra/modules/container-app.bicep'), 'utf8')
const REGISTER = readFileSync(resolve(ROOT, 'server/api/v1/oauth/register.post.ts'), 'utf8')

describe('NUXT_SECURITY_RATE_LIMITER_IP_HEADER', () => {
  it('is x-azure-socketip when Front Door is enforced, empty otherwise', () => {
    expect(CONTAINER_APP).toMatch(
      /\{\s*name:\s*'NUXT_SECURITY_RATE_LIMITER_IP_HEADER',\s*value:\s*empty\(azureFrontDoorId\)\s*\?\s*''\s*:\s*'x-azure-socketip'\s*\}/,
    )
  })

  it('names the same header oauth/register keys its ceiling on', () => {
    expect(REGISTER).toMatch(/getHeader\(event,\s*'x-azure-socketip'\)/)
  })
})
