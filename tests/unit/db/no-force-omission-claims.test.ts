// @vitest-environment node
/*
 * GUARD — no source comment may claim a table is SAFE because it is omitted from
 * a `FORCE ROW LEVEL SECURITY` phase.
 *
 * It is not safe. `FORCE` binds the table OWNER; a NON-OWNER is bound by
 * `ENABLE` alone. Production is about to become a non-owner, so a table with RLS
 * enabled filters that connection whatever any FORCE plan says. A table is
 * protected from that only by being in
 * `server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES` and explicitly DISABLEd at
 * the role switch.
 *
 * WHY A GUARD AND NOT A FIX. This exact misconception was written ELEVEN times
 * across one branch — four sections of docs/design/rls-enforcement.md, the
 * bootstrap constant (three separate under-derivations), and ten handler headers
 * that inherited the reasoning from the design doc while it was still wrong. Each
 * round of review found more of it, and each fix looked complete at the time.
 * Nothing type-checks a sentence, so the only durable answer is to make the
 * phrasing itself fail (CLAUDE.md rule 14: where the class is mechanically
 * detectable, gate it).
 *
 * The consequence of getting it wrong is not cosmetic: the first instance would
 * have stopped the whole emit fleet at the role switch, and the third would have
 * 500'd every device enrolment.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const SCANNED = ['server', 'drizzle', 'shared']

/** Phrasings that assert protection-by-omission. */
const CLAIM = /(not in|out of|outside|omitted from|excluded from|keeps? [^.]*? out of)\s+(the\s+)?(phase-?\d+\s+)?FORCE\s+set/i

/*
 * A line may name the claim in order to REFUTE it — several comments now do,
 * deliberately, because "this used to say X and X is false" is the most useful
 * form of the correction. Allow only that shape.
 */
/*
 * Punctuation-tolerant: the phrasing in the wild is `ENABLE` ALONE, with
 * backticks and caps, and an exact-string matcher flagged a correct REFUTATION
 * as an offender. A guard whose allowance depends on someone writing the
 * refutation in one particular spelling produces false positives, and a false
 * positive is how a guard gets weakened or deleted.
 */
const REFUTATION =
  /\bNOT\s+"|protects? nothing|is not protection|would not have helped|would not help|is false|ENABLE[`'"\s]+alone|binds?[`'"\s]+the[`'"\s]+owner/i

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.nuxt') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|mjs|sql|vue)$/.test(name)) out.push(p)
  }
  return out
}

describe('no comment claims safety by omission from a FORCE phase', () => {
  const files = SCANNED.flatMap((d) => sources(resolve(ROOT, d)))

  it('scans a meaningful number of files (guards against the walker matching nothing)', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('finds no unrefuted protection-by-omission claim', () => {
    const offenders: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!CLAIM.test(line)) return
        // Look at the line and its immediate neighbours: these are prose blocks,
        // and the refutation often sits on the next line.
        const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ')
        if (REFUTATION.test(context)) return
        // A POSITIVE statement ("`project` IS in the phase-1 FORCE set") is fine —
        // the defect is claiming omission makes something safe.
        if (/\bis in the\b/i.test(line)) return
        offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
    }
    expect(
      offenders,
      'A comment claims a table is safe because it is omitted from a FORCE phase. ' +
        'FORCE binds the OWNER; a non-owner is bound by ENABLE alone, so omission protects nothing. ' +
        'Say that the table is in RLS_BOOTSTRAP_TABLES and DISABLEd at the role switch, or fix the code.',
    ).toEqual([])
  })
})
