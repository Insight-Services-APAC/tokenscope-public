/*
 * directory-snapshot — persist the two directory attributes an admin groups by,
 * at the moments we ALREADY hold the directory record.
 *
 * WHY THIS EXISTS. The Teammates worklist needs Department and Company to let an
 * admin recognise a cluster of 40 people who obviously belong to one cost centre.
 * Neither attribute was stored anywhere: they live on the Entra record, and the
 * only readers fetched them, used them for a placement decision, and dropped them.
 *
 * SO IT CAPTURES RATHER THAN RE-FETCHES. Both placement lanes (placement-sync via
 * provisionAndPlace, and region-reenrichment) already resolve a DirectoryUser for
 * exactly the unplaced population, once per person, on a cron. Writing the two
 * fields they already have costs no extra Graph call and no extra pass. The
 * alternative — enriching the list endpoint per page load — would fan hundreds of
 * requests at a throttle-prone API, and getDirectoryUserByMailOrUpn nulls on ANY
 * error, so a throttled read and a genuinely-empty attribute would render as the
 * same blank cell.
 *
 * IT IS A SNAPSHOT AND SAYS SO. `capturedAt` is stamped on every write, so a stale
 * department is legible as stale rather than as current truth. Nothing derives
 * placement from these values — they are shown to a human who then decides. The
 * derivation itself still reads the live DirectoryUser, never this copy.
 *
 * WHICH ATTRIBUTES, AND WHY NOT MORE. department + companyName only. Those are the
 * two the estate populates; employeeOrgData.costCenter is empty across it, so
 * capturing it would produce a column that is blank for everyone and implies the
 * data exists. Add a field here when a directory sample shows real coverage, not
 * before.
 *
 * WHICH CALLERS. The two lanes above, and only those: they resolve the directory
 * record OF THE TEAMMATE BEING PLACED. The other directory readers in the codebase
 * (owner assignment, project members, GitHub identity mapping) resolve a DIFFERENT
 * person for a different purpose, and stamping a snapshot from there would attach
 * one teammate's attributes to whatever row that flow happened to touch.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Db = Pick<PostgresJsDatabase<Record<string, never>>, 'execute'>

/** The captured subset of a DirectoryUser. Nulls are captured too — "we looked and
 *  the tenant leaves this empty" is a different fact from "we never looked". */
export interface DirectorySnapshot {
  department: string | null
  companyName: string | null
  /**
   * The teammate's OWN direct manager, from the first hop of the chain walk the
   * placement derivation already made (C9 groups the default unit's occupants by
   * it — "12 report to Lee Hughes" is a to-do list; "12 people are wrong" is not).
   *
   * OPTIONAL, and the distinction is the whole reason: OMIT the key when the
   * derivation did not walk, so the previous capture survives; pass
   * `{ oid: null }` when the walk ran and the person is the top of the chart.
   * Nulling on "we did not ask" would silently empty the clusters every time a
   * lane short-circuited before the walk.
   */
  manager?: { oid: string | null; email: string | null }
}

/** The metadata key the snapshot lives under. Read by the teammates list query. */
export const DIRECTORY_SNAPSHOT_KEY = 'directory'

/**
 * Merge the snapshot INTO `teammate.metadata.directory`.
 *
 * TWO levels, and the second one was missing. `metadata || jsonb_build_object(
 * 'directory', {...})` merges at the TOP level only: it leaves the placement
 * provenance (`placedVia` / `placedOwnerOid` / `placedAt`) alone — which is the
 * property that matters most, since region-reenrichment depends on it and both
 * writers share the column — but it REPLACES `metadata.directory` wholesale.
 * Every field previously under that key is dropped. Today this writer happens to
 * supply all three keys it knows about, so nothing visibly breaks; the moment any
 * other writer (or a later field on this one, added on a different code path)
 * puts something under `directory`, one capture erases it silently. jsonb_set
 * with the nested `||` merges at BOTH levels, so the claim and the statement
 * agree.
 *
 * The `jsonb_typeof` guard is not decoration: `||` between a jsonb scalar and an
 * object raises, so a `directory` key holding a string (hand-written data, an
 * older shape) would fail the UPDATE rather than be overwritten. Treat a
 * non-object as an empty object and replace it.
 */
export async function captureDirectorySnapshot(
  db: Db,
  teammateId: string,
  snap: DirectorySnapshot,
): Promise<void> {
  /*
   * `?? null` is LOAD-BEARING, not defensive noise. drizzle's sql`` template
   * OMITS an `undefined` value entirely rather than binding it — the statement
   * renders as `'companyName', ::text` and PostgreSQL rejects it as a syntax
   * error. A DirectoryUser from the real Graph mapper always carries both keys,
   * but a caller that builds one by hand (every test fixture in the suite, and
   * any future adapter) can leave one off, and the failure mode is a broken
   * UPDATE rather than a missing value. Coerce to a real SQL NULL so an absent
   * attribute is stored as "we looked and it was empty".
   */
  await db.execute(sql`
    UPDATE teammate
    SET metadata = jsonb_set(
          coalesce(metadata, '{}'::jsonb),
          ARRAY[${DIRECTORY_SNAPSHOT_KEY}::text],
          CASE WHEN jsonb_typeof(metadata -> ${DIRECTORY_SNAPSHOT_KEY}::text) = 'object'
               THEN metadata -> ${DIRECTORY_SNAPSHOT_KEY}::text
               ELSE '{}'::jsonb
          END
          || jsonb_build_object(
               'department',  ${snap.department ?? null}::text,
               'companyName', ${snap.companyName ?? null}::text,
               'capturedAt',  now()
             )
          ${
            /*
             * Merged as a SEPARATE term, present only when the caller resolved a
             * manager. Folding it into the object above would write
             * `'managerOid', NULL` whenever the key was omitted, which is exactly
             * the erase this field's contract forbids.
             */
            snap.manager
              ? sql`|| jsonb_build_object(
               'managerOid',   ${snap.manager.oid ?? null}::text,
               'managerEmail', ${snap.manager.email ?? null}::text)`
              : sql``
          },
          true)
    WHERE id = ${teammateId}::uuid`)
}
