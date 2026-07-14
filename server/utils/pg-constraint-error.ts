/*
 * translatePgConstraintError — shared PG constraint-violation → HTTP
 * translator (SYS-2, robustness-review-2026-06-09).
 *
 * The same SQLSTATE classes were being caught ad-hoc (23505 in
 * activity-types, 23503 in projects.delete) and NOT caught at all in
 * identities.post, regions.delete, the lifecycle PUT and the allocation
 * write paths — surfacing constraint races as raw 500s. This normalises:
 *
 *   23505 unique_violation     → 409 (duplicate created concurrently)
 *   23503 foreign_key_violation→ 409 (or 404 where the FK target vanished)
 *   23P01 exclusion_violation  → 409 (tstzrange overlap on the gist EXCLUDE)
 *
 * Usage — call in a catch block; it throws the mapped H3Error when the
 * SQLSTATE matches, otherwise rethrows the original error:
 *
 *   try { ... } catch (err) {
 *     translatePgConstraintError(err, {
 *       '23P01': { title: 'Budget period overlaps', detail: '...' },
 *     })
 *   }
 */
import { createError } from 'h3'
import { pgErrorCode } from '../db/pg-error'

export type PgConstraintCode = '23505' | '23503' | '23P01'

export interface ConstraintMapping {
  /** HTTP status to emit — defaults to 409. Use 404 where the FK target is the resource itself. */
  status?: 404 | 409
  title: string
  detail: string
}

export function translatePgConstraintError(
  err: unknown,
  map: Partial<Record<PgConstraintCode, ConstraintMapping>>,
): never {
  const code = pgErrorCode(err)
  const mapping = code ? map[code as PgConstraintCode] : undefined
  if (!mapping) throw err

  const status = mapping.status ?? 409
  throw createError({
    statusCode: status,
    statusMessage: mapping.title,
    data: {
      type:
        status === 404
          ? 'https://tokenscope.example.com/errors/not-found'
          : 'https://tokenscope.example.com/errors/conflict',
      title: mapping.title,
      status,
      detail: mapping.detail,
    },
  })
}
