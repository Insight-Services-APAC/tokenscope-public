/*
 * apiErrorDetail (SYS-5) — the single error-extraction chokepoint. The
 * precedence order matters: RFC-9457 Problem-Details bodies carry the human
 * text at data.data.detail and MUST win over h3's statusMessage; several
 * hand-rolled copies missed that path before the consolidation sweep.
 */
import { describe, it, expect } from 'vitest'
import { apiErrorDetail } from '../../../app/composables/useApiError'

describe('apiErrorDetail', () => {
  it('prefers the RFC-9457 data.data.detail path', () => {
    expect(
      apiErrorDetail(
        {
          data: {
            data: { detail: 'Budget overlaps an existing allocation.' },
            statusMessage: 'Conflict',
            detail: 'other',
          },
          message: 'Request failed',
        },
        'fallback',
      ),
    ).toBe('Budget overlaps an existing allocation.')
  })

  it('falls back to statusMessage, then data.detail, then message', () => {
    expect(apiErrorDetail({ data: { statusMessage: 'Forbidden' } }, 'f')).toBe('Forbidden')
    expect(apiErrorDetail({ data: { detail: 'plain detail' } }, 'f')).toBe('plain detail')
    expect(apiErrorDetail({ message: 'boom' }, 'f')).toBe('boom')
  })

  it('returns the fallback for null/undefined/shapeless errors', () => {
    expect(apiErrorDetail(null, 'fallback')).toBe('fallback')
    expect(apiErrorDetail(undefined, 'fallback')).toBe('fallback')
    expect(apiErrorDetail({}, 'fallback')).toBe('fallback')
  })
})
