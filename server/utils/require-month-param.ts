/*
 * requireMonthParam — validate a `YYYY-MM` router param (finance-period
 * month key), mirroring require-uuid-param.ts's clean-400 pattern.
 */
import { createError, getRouterParam, type H3Event } from 'h3'
import { z } from 'zod'

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

/** Validate + return the named router param as `YYYY-MM`, or throw a clean 400. */
export function requireMonthParam(event: H3Event, name = 'month'): string {
  const parsed = MonthSchema.safeParse(getRouterParam(event, name))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid month',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid month',
        status: 400,
        detail: `Expected 'YYYY-MM' (e.g. 2026-07) for '${name}' in the URL path.`,
      },
    })
  }
  return parsed.data
}
