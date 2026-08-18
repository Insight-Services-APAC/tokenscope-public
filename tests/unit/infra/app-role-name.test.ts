/*
 * The app role's name is spelled in two languages, and nothing type-checks a
 * string inside a Bicep template.
 *
 * `RLS_APP_ROLE` (scripts/rls-roles.ts — prod-image safe) is what drizzle/provision-app-role.ts
 * CREATES; `appDbRole` (infra/modules/keyvault-secrets.bicep) is what the
 * database-url-app secret CONNECTS AS. If they ever disagree the deploy is
 * perfectly green and every connection fails authentication — the class of
 * defect that survives typecheck, lint and the whole suite, so it gets a
 * mechanical gate instead of a comment asking people to be careful.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RLS_APP_ROLE as APP_DB_ROLE } from '../../../scripts/rls-roles'

const BICEP = resolve(__dirname, '../../..', 'infra/modules/keyvault-secrets.bicep')

describe('the app role name matches between the app and the Bicep template', () => {
  it('keyvault-secrets.bicep builds database-url-app for APP_DB_ROLE', () => {
    const src = readFileSync(BICEP, 'utf8')
    const declared = /^var appDbRole = '([^']+)'$/m.exec(src)
    expect(declared, 'no `var appDbRole = \'…\'` in keyvault-secrets.bicep — did the variable move or get renamed?').not.toBeNull()
    expect(declared![1]).toBe(APP_DB_ROLE)
  })

  it('the URL secret is built from that variable, not from a repeated literal', () => {
    // A third spelling inline in the URL would defeat the check above.
    const src = readFileSync(BICEP, 'utf8')
    expect(src).toContain("value: 'postgresql://${uriComponent(appDbRole)}:")
    expect(src.match(new RegExp(APP_DB_ROLE, 'g')) ?? [], 'the role name should appear exactly once, in the var').toHaveLength(1)
  })
})
