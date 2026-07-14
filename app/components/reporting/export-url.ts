/*
 * buildExportUrl — pure querystring assembly for the CSV export endpoints.
 * Extracted so it is unit-testable without a DOM/download trigger.
 */
export type ExportParams = Record<string, string | number | boolean | null | undefined>

export function buildExportUrl(endpoint: string, params: ExportParams): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    qs.set(k, String(v))
  }
  const q = qs.toString()
  return q ? `${endpoint}?${q}` : endpoint
}
