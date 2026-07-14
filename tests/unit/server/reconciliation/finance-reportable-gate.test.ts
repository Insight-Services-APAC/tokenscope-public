// @vitest-environment node
/*
 * Enforcement: the /rollups/finance/* cross-charge surfaces are BILL-ANCHORED
 * (mig 0059). Money = the provider bill homed to the cost-owning unit
 * (v_finance_bill_chargeback); the per-project split = v_finance_project_overlay
 * (the bill scaled across tagged projects + the untagged remainder). Neither
 * surface may SUM attribution_record directly for a charge — that is the OTel
 * estimate, not the bill, and re-introducing it is exactly the leak the
 * bill-anchored model removes.
 *
 * Signal surfaces (manager, practice velocity) are intentionally NOT gated: they
 * show all team activity and read attribution_record by design (the allowlist).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// The CC-level money surfaces: the bill, homed to the cost-owning unit.
const BILL = ['server/api/v1/rollups/finance.get.ts', 'server/api/v1/rollups/finance/export.get.ts']
// The per-project surfaces: the bill split across tagged projects + untagged.
const OVERLAY = [
  'server/api/v1/rollups/finance/[couId]/breakdown.get.ts',
  'server/api/v1/rollups/finance/[couId]/export.get.ts',
]
const FINANCE = [...BILL, ...OVERLAY]

describe('finance bill-anchored gate', () => {
  it('CC money surfaces read the bill-chargeback view', () => {
    for (const f of BILL) {
      expect(read(f), `${f} must read v_finance_bill_chargeback`).toContain('v_finance_bill_chargeback')
    }
  })

  it('per-project surfaces read the project-overlay view', () => {
    for (const f of OVERLAY) {
      expect(read(f), `${f} must read v_finance_project_overlay`).toContain('v_finance_project_overlay')
    }
  })

  // Whitespace/case-normalise so a reformatted FROM clause can't silently pass.
  const sqlNorm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()
  it('no finance surface SELECTs FROM attribution_record for a charge', () => {
    // attribution_record is the OTel estimate; the bill-anchored surfaces draw
    // money from the bill-anchored views. (Per-project token COUNTS come from
    // v_finance_reportable_spend, which is a VIEW — still never the raw table.)
    for (const f of FINANCE) {
      expect(sqlNorm(read(f)), `${f} must not read FROM attribution_record`).not.toContain(
        'from attribution_record',
      )
    }
  })

  it('finance.get.ts no longer touches attribution_record at all (the fidelity ratio is gone)', () => {
    const fin = read('server/api/v1/rollups/finance.get.ts')
    expect(fin).not.toContain('attribution_record')
  })

  it('signal surfaces (manager, velocity) are intentionally NOT gated', () => {
    // Documented allowlist: these show all activity, so they read attribution_record.
    expect(read('server/api/v1/rollups/manager.get.ts')).toContain('attribution_record')
    expect(read('server/api/v1/rollups/practice/[ouId]/velocity.get.ts')).toContain('attribution_record')
  })
})
