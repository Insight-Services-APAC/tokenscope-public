/*
 * validated-body — Zod request validation that surfaces a HUMAN-READABLE reason.
 *
 * h3's `readValidatedBody(event, (d) => Schema.parse(d))` throws a raw ZodError that the app
 * sees as a bare "Validation Error" (no field, no rule) — useless in a form. These helpers read
 * + safeParse and, on failure, throw the standard RFC-9457 400 with a `detail` that names the
 * offending field and its rule, so `apiErrorDetail` shows e.g. "code: code must be lowercase
 * letters, numbers and hyphens (e.g. global-it)".
 *
 * Plus `lowercaseSlug()` for keys that MUST be lowercase (region code, credential names, provider
 * slugs): it trims + lowercases the input ("GlobalIT" → "globalit") BEFORE the slug check, so a
 * casing slip is auto-corrected instead of rejected. Do NOT use it for case-FLEXIBLE external
 * references (project / org-unit / WBS codes — those keep their case by design).
 */
import { createError, getQuery, readBody, type H3Event } from 'h3'
import { z, type ZodType } from 'zod'

const VALIDATION_TYPE = 'https://tokenscope.example.com/errors/validation'

function failValidation(error: z.ZodError): never {
  const issue = error.issues[0]
  const path = issue?.path.filter((p) => p !== '').join('.') ?? ''
  const detail = issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'invalid request'
  throw createError({
    statusCode: 400,
    statusMessage: detail,
    data: { type: VALIDATION_TYPE, title: 'Invalid request', status: 400, detail },
  })
}

/** Read + Zod-validate the request body; a failure is a 400 whose detail names the field + rule. */
export async function readValidated<S extends ZodType>(event: H3Event, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) failValidation(parsed.error)
  return parsed.data
}

/** Read + Zod-validate the query string; same friendly-400 behaviour. */
export async function getValidated<S extends ZodType>(event: H3Event, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(getQuery(event))
  if (!parsed.success) failValidation(parsed.error)
  return parsed.data
}

/**
 * A lowercase slug field. Trims + lowercases the input BEFORE validating, so "GlobalIT" is accepted
 * as "globalit" instead of rejected. For keys that REQUIRE lowercase only — not case-flexible codes.
 */
export function lowercaseSlug(opts: { min?: number; max?: number; label?: string } = {}): ZodType<string> {
  const { min = 2, max = 40, label = 'value' } = opts
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z
      .string()
      .min(min, `${label} must be at least ${min} characters`)
      .max(max, `${label} must be at most ${max} characters`)
      .regex(/^[a-z0-9][a-z0-9-]*$/, `${label} must be lowercase letters, numbers and hyphens (e.g. global-it)`),
  ) as unknown as ZodType<string>
}
