// @vitest-environment node
/*
 * r3-L1 — THE WIKI STATES THE AS-BUILT GATE, NOT THE INTENDED ONE.
 *
 * `docs/wiki/API-Reference.md` described member depth as "membership-gated, 404
 * for a non-member". The gate has TWO arms (`requireProjectMembership`,
 * server/usage/consumption.ts): current membership, OR an active `cou_owner` row
 * on the project's lead cost-owning unit — the P&L drill-through, which returns
 * `access: 'cou-owner'` and a 200. A non-member cost-centre owner reading that
 * line would conclude they cannot reach the page they in fact can.
 *
 * A STATIC pin, deliberately: the failure mode is drift, and drift is only ever
 * caught by asserting the two artefacts against each other. If the second arm is
 * ever REMOVED, this test fails on the code side and the doc line comes out with
 * it — which is the correct direction too.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const wiki = readFileSync(join(ROOT, 'docs', 'wiki', 'API-Reference.md'), 'utf8')
const gate = readFileSync(join(ROOT, 'server', 'usage', 'consumption.ts'), 'utf8')

/** The one row that documents `/api/v1/reports/project/{code}` and its sibling. */
const projectDepthRow =
  wiki.split('\n').find((l) => l.includes('/api/v1/reports/project/{code}')) ?? ''

describe('API-Reference member depth ↔ requireProjectMembership', () => {
  it('the gate really does admit a cost-centre owner who is not a member', () => {
    // Guards the premise: if this arm disappears, the doc claim below must too.
    expect(gate).toMatch(/'member' ELSE 'cou-owner'/)
    expect(gate).toMatch(/FROM cou_owner co\s+WHERE co\.org_unit_id = p\.cost_owning_unit_id/)
  })

  it('the wiki names that second arm instead of promising a universal 404', () => {
    expect(projectDepthRow).not.toBe('')
    expect(projectDepthRow).toContain('cou-owner')
    // The retired claim: "membership-gated, 404 for a non-member" — true of the
    // team EXPORT (which asserts access === 'member') and false of the page.
    expect(projectDepthRow).not.toMatch(/membership-gated, 404 for a non-member/)
  })
})
