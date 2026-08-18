// @vitest-environment node
/*
 * GUARD — the bootstrap table set is written down TWICE, and the two copies
 * must name the same tables.
 *
 *   - `scripts/rls-roles.ts::RLS_BOOTSTRAP_TABLE_NAMES` — bare strings. This is
 *     the OPERATIONAL copy: the cutover sweep and the boot gate import it,
 *     because the runtime image ships `scripts/` and `drizzle/` but not
 *     `server/` (Dockerfile stage 4, `boot-path-imports.test.ts`).
 *   - `server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES` — table + the
 *     pre-identity read that forces it into the set. This is the copy that
 *     carries the REASONS, cited by ten handler headers and by the design doc.
 *
 * They cannot be collapsed: the reasons must not enter the boot path, and the
 * names must. So the duplication is deliberate, and this is what keeps it
 * honest. Without it, removing a table from one list leaves either a sweep that
 * refuses forever (operational copy stale) or a documented rationale describing
 * a set the code no longer uses (reasoned copy stale) — and nothing else in the
 * repo would notice, because each list type-checks perfectly well alone.
 *
 * `server/db/rls-bootstrap.ts` re-exports RLS_BOOTSTRAP_TABLE_NAMES from
 * `scripts/`, so both spellings are importable from the same place — which
 * makes the duplication easy to miss and this guard the thing that catches it.
 */
import { describe, it, expect } from 'vitest'
import { RLS_BOOTSTRAP_TABLES } from '../../../server/db/rls-bootstrap'
import { RLS_BOOTSTRAP_TABLE_NAMES } from '../../../scripts/rls-roles'

describe('the two bootstrap-table lists name the same tables', () => {
  it('agrees, table for table', () => {
    const reasoned = RLS_BOOTSTRAP_TABLES.map((t) => t.table).sort()
    const operational = [...RLS_BOOTSTRAP_TABLE_NAMES].sort()
    expect(
      reasoned,
      'server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES (the reasoned copy, cited by the handler headers) and ' +
        'scripts/rls-roles.ts::RLS_BOOTSTRAP_TABLE_NAMES (the operational copy the cutover sweep and the boot gate import) ' +
        'no longer name the same tables. Whichever you changed, change the other: a stale operational copy makes the sweep ' +
        'refuse or under-disable, and a stale reasoned copy makes ten handler headers describe a set the code does not use.',
    ).toEqual(operational)
  })

  it('every entry in the reasoned copy carries a reason', () => {
    const reasonless = RLS_BOOTSTRAP_TABLES.filter((t) => t.reason.trim().length === 0).map((t) => t.table)
    expect(reasonless, 'a bootstrap entry with no reason cannot be reviewed for whether it still belongs').toEqual(
      [],
    )
  })

  it('neither list has duplicates', () => {
    expect(new Set(RLS_BOOTSTRAP_TABLE_NAMES).size).toBe(RLS_BOOTSTRAP_TABLE_NAMES.length)
    const reasoned = RLS_BOOTSTRAP_TABLES.map((t) => t.table)
    expect(new Set(reasoned).size).toBe(reasoned.length)
  })
})
