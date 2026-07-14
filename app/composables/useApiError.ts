/*
 * useApiError — robust extraction of a human-readable detail from an $fetch
 * error.
 *
 * The server returns errors in a few shapes: RFC-9457 Problem-Details bodies
 * carry `data.data.detail`; h3's createError surfaces `data.statusMessage`;
 * some handlers put the message at `data.detail`. Components hand-rolled this
 * with inconsistent precedence — this helper standardises the order so the
 * surfaced text is predictable.
 *
 * Order: data.data.detail → data.statusMessage → data.detail → message →
 * fallback.
 */
interface ApiErrorShape {
  data?: {
    data?: { detail?: string }
    statusMessage?: string
    detail?: string
  }
  message?: string
}

export function apiErrorDetail(err: unknown, fallback: string): string {
  const e = err as ApiErrorShape | null | undefined
  return (
    e?.data?.data?.detail ??
    e?.data?.statusMessage ??
    e?.data?.detail ??
    e?.message ??
    fallback
  )
}
