/*
 * requireUuidParam — ONE strict UUID router-param validator (SYS-1,
 * robustness-review-2026-06-09).
 *
 * Path-param validation previously existed in three generations:
 *   1. safeParse + RFC-9457 400 (newest — admin/users/[id].patch.ts, "R1 F5")
 *   2. the known-bad 36-char regex /^[0-9a-f-]{36}$/i (API-5 — accepts 36 hex
 *      chars with no dashes, then the PG ::uuid cast raises 22P02 → 500)
 *   3. bare Schema.parse() (API-7 — raw ZodError isn't an H3Error → 500)
 *
 * This helper retires generations 2 and 3 (the 500-producing patterns): the
 * canonical 8-4-4-4-12 hex shape gets through, anything else gets a clean
 * RFC-9457 400. A number of admin routes still inline
 * `z.string().uuid().safeParse(getRouterParam(...))` — those already return a
 * clean 400 (not a 500), so they are a consolidation opportunity, not a defect;
 * migrate them here opportunistically.
 *
 * Deliberately version-agnostic (PG's ::uuid cast domain), NOT zod 4's strict
 * z.string().uuid(): strict RFC version/variant bits would 400 well-formed ids
 * that the DB accepts, turning "row not found" (404) into "bad request" — and
 * fixtures/external ids are not guaranteed to be v4.
 */
import { createError, getRouterParam, type H3Event } from 'h3'
import { z } from 'zod'

const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

/**
 * Validate + return the named router param as a canonical UUID, or throw a
 * 400 with an RFC-9457 body. `label` customises the human-facing message
 * (defaults to the param name, e.g. 'allocation id').
 */
export function requireUuidParam(event: H3Event, name: string, label?: string): string {
  const what = label ?? name
  const parsed = UuidSchema.safeParse(getRouterParam(event, name))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid ${what}`,
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: `Invalid ${what}`,
        status: 400,
        detail: `Expected a canonical UUID for '${name}' in the URL path.`,
      },
    })
  }
  return parsed.data
}
