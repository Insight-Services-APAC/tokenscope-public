// @vitest-environment node
/*
 * Lane firewall (build-design §7(7)) — a STATIC test: no reporting READ path may
 * touch `attribution_record` or raw `actual_spend`. The usage lane reads
 * `v_complete_usage`; the finance/bill lane reads the `v_finance_*` views (incl.
 * the Σ=bill term via `v_finance_bill_totals_month`) — so the firewall holds with
 * NO exceptions. Scans BOTH the endpoint dir (`server/api/v1/reports/**`) and the
 * shared query layer (`server/reporting/**`, where the query fns actually live).
 *
 * Comments are stripped first so a doc-comment MENTIONING the banned tables (like
 * this file's own, or the query module's header) is not a false positive.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCAN_DIRS = [join(ROOT, 'server', 'api', 'v1', 'reports'), join(ROOT, 'server', 'reporting')]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Strip block + line comments (line-comment strip skips `https://` URLs). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const files = SCAN_DIRS.flatMap(walk)

describe('reporting lane firewall', () => {
  it('scans the actual reporting read path (sanity — files are present)', () => {
    // The 5 endpoints + the shared query/param modules.
    expect(files.length).toBeGreaterThanOrEqual(6)
    expect(files.some((f) => f.endsWith('regional.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('meta.get.ts'))).toBe(true)
  })

  it('no reporting read path references `attribution_record` (usage lane = v_complete_usage)', () => {
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'))
      expect(code, `${f} must not read attribution_record`).not.toMatch(/\battribution_record\b/)
    }
  })

  it('no reporting read path references raw `actual_spend` (bill lane = v_finance_* views)', () => {
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'))
      expect(code, `${f} must not read raw actual_spend`).not.toMatch(/\bactual_spend\b/)
    }
  })
})
