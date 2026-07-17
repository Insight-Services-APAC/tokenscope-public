/*
 * Field-distribution — pure aggregation for the "which attribute maps to region
 * on MY tenant?" diagnostic. Given a sample of directory users, for each region
 * attribute it returns coverage (how populated) + the top distinct values with
 * counts. PII-safe by construction: only ATTRIBUTE VALUES (company/country/…) and
 * counts, never names/emails; and a k-anonymity floor (`minCell`) suppresses any
 * value seen fewer than `minCell` times so a rare value + count can't
 * de-anonymise one person. (Caveat: coveragePct/distinct/other are aggregates,
 * not value-suppressed, so on a tiny sample they can hint that "exactly one
 * person has X populated" — the endpoint frames the sample as directional, and
 * the attributes are non-sensitive org fields, never name/email.)
 */
import { REGION_ATTRIBUTES, normalizeMatchValue, type RegionAttributeKey } from './region-attributes'

/** k-anonymity floor: never surface a value cell smaller than this. */
export const MIN_CELL = 5

export interface AttributeDistribution {
  attribute: RegionAttributeKey
  label: string
  /** Users with a non-empty value for this attribute. */
  populated: number
  /** populated / total, 0–100. High + few distinct values = a strong signal. */
  coveragePct: number
  /** Distinct normalised values seen. */
  distinct: number
  /** Top values (count ≥ minCell), original casing, most common first. */
  top: Array<{ value: string; count: number }>
  /** Everything not shown (rare < minCell OR beyond topN) — the "other" bucket. */
  other: { values: number; users: number }
}

export interface FieldDistribution {
  total: number
  attributes: AttributeDistribution[]
}

/** Minimal shape the aggregator needs off each sampled user (a DirectoryUser fits). */
export type DistributionUser = Partial<Record<RegionAttributeKey, string | null>>

export function computeFieldDistribution(
  users: DistributionUser[],
  opts?: { topN?: number; minCell?: number },
): FieldDistribution {
  const topN = opts?.topN ?? 12
  const minCell = opts?.minCell ?? MIN_CELL
  const total = users.length

  const attributes = REGION_ATTRIBUTES.map<AttributeDistribution>((a) => {
    const counts = new Map<string, { raw: string; count: number }>()
    let populated = 0
    for (const u of users) {
      const raw = (u[a.key] ?? '').trim()
      if (!raw) continue
      populated++
      const norm = normalizeMatchValue(raw)
      const e = counts.get(norm)
      if (e) e.count++
      else counts.set(norm, { raw, count: 1 })
    }
    const sorted = [...counts.values()].sort((x, y) => y.count - x.count)
    const top: Array<{ value: string; count: number }> = []
    let otherValues = 0
    let otherUsers = 0
    for (const c of sorted) {
      if (c.count >= minCell && top.length < topN) top.push({ value: c.raw, count: c.count })
      else {
        otherValues++
        otherUsers += c.count
      }
    }
    return {
      attribute: a.key,
      label: a.label,
      populated,
      coveragePct: total ? Math.round((populated / total) * 100) : 0,
      distinct: counts.size,
      top,
      other: { values: otherValues, users: otherUsers },
    }
  })

  return { total, attributes }
}
