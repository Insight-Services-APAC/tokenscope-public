/*
 * buildExportUrl — the CSV export querystring assembler (ExportCsvButton core).
 */
import { describe, it, expect } from 'vitest'
import { buildExportUrl } from '../../../app/components/reporting/export-url'

describe('buildExportUrl', () => {
  it('appends params and skips null/undefined/empty', () => {
    expect(
      buildExportUrl('/api/v1/reports/export', {
        scope: 'finance',
        month: '2026-05',
        region: undefined,
        ou: null,
        cc: '',
      }),
    ).toBe('/api/v1/reports/export?scope=finance&month=2026-05')
  })

  it('returns the bare endpoint when there are no usable params', () => {
    expect(buildExportUrl('/api/v1/reports/export', {})).toBe('/api/v1/reports/export')
  })

  it('coerces numbers and booleans', () => {
    expect(buildExportUrl('/x', { a: 1, b: true })).toBe('/x?a=1&b=true')
  })
})
