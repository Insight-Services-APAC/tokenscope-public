/*
 * reporting/behaviour-csv — the CSV serialisers for the two behaviour cards
 * (Behavioural exposure, Spend per active developer).
 *
 * ONE COPY, not one per scope. Both cards render at Region scope AND at
 * Cost-Centre scope, and the composers that serve them are separate files. A
 * serialiser per composer is the drift the shared engine exists to prevent —
 * `engine/scope.ts` names the pair that had already diverged on a map-key
 * separator. These take the primitive's own output, so the CSV cannot re-derive
 * a figure the screen computed differently (build-design §2, byte-identical rule).
 */
import { csvEscape } from '../utils/csv-escape'
import type { PerDeveloperSeries } from '../../shared/reports/per-developer'
import { ACTIVE_DEVELOPERS_NOTE } from '../../shared/reports/per-developer'
import { TIER_BAND_LABELS, type TierExposure } from '../../shared/reports/tier-exposure'

/** Two-decimal money, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/**
 * Behavioural exposure → `band, provider, spendUsd, consumption, unit, periodStart`
 * (04-prototype-delta.md §7).
 *
 * ONE ROW PER (band, provider, DAY), plus a leading period row per (band,
 * provider) whose `periodStart` is the window start. The period rows are the
 * bars on screen and the day rows are the trend under them, and both come from
 * the same primitive call — so a reader summing the day rows for a band gets the
 * period row back.
 *
 * `consumption` is EMPTY, never `0`, when the band carried no consumption row.
 * A zero would put an uncounted band in the volume column at zero and imply the
 * work moved no tokens rather than that nothing counted them. The `unit` column
 * says what the count is in, because the two providers do not meter the same
 * thing (tokens vs interactions) and a bare number would invite adding them.
 *
 * A `no-data-yet` arm emits ONE row naming itself, rather than six zero rows:
 * zero rows would read as "this provider spent nothing", which is a claim about
 * spending rather than about an adapter that has not been written.
 */
export function tierExposureToCsv(
  exposure: TierExposure,
  meta: { scopeLabel: string; asOfDate: string | null },
): string {
  const lines = [
    `# tokenscope behavioural exposure · scope=${meta.scopeLabel} · window=${exposure.window.from}..${exposure.window.to} · as_of=${meta.asOfDate ?? 'n/a'}`,
    '# bands come from model_catalog.tier; unclassified and no-model are shown, never folded into economy',
    '# a mix-only provider (Copilot) meters money at DAY grain only — its band spend is 0 and its credits ride the unbanded_spend_usd row',
    'band,provider,spend_usd,consumption,unit,period_start',
  ]
  for (const arm of exposure.providers) {
    if (arm.availability === 'no-data-yet') {
      lines.push(
        `${csvEscape('(no data yet)')},${csvEscape(arm.provider)},,,${csvEscape(arm.unit)},${exposure.window.from}`,
      )
      continue
    }
    if (arm.unbandedSpendUsd > 0) {
      lines.push(
        `${csvEscape('(unbanded — day grain)')},${csvEscape(arm.provider)},${usd(arm.unbandedSpendUsd)},,${csvEscape(arm.unit)},${exposure.window.from}`,
      )
    }
    for (const band of arm.bands) {
      lines.push(
        `${csvEscape(TIER_BAND_LABELS[band.band])},${csvEscape(arm.provider)},${usd(band.spendUsd)},` +
          `${band.consumption === null ? '' : band.consumption},${csvEscape(arm.unit)},${exposure.window.from}`,
      )
    }
    for (const cell of arm.series) {
      lines.push(
        `${csvEscape(TIER_BAND_LABELS[cell.band])},${csvEscape(arm.provider)},${usd(cell.spendUsd)},` +
          `${cell.consumption === null ? '' : cell.consumption},${csvEscape(arm.unit)},${cell.day}`,
      )
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Spend per active developer → `day, spendUsd, activeDevelopers, perDeveloperUsd`
 * (04-prototype-delta.md §7).
 *
 * `perDeveloperUsd` is EMPTY on a day with no active developer — the same gap
 * the line draws. Writing `0.00` would assert a per-head figure for a day that
 * had no heads.
 *
 * The three deltas ride the header rather than becoming columns: they are one
 * statement about the whole series, not a property of any row, and a column
 * repeating them sixty times is how a reader ends up summing them.
 */
export function perDeveloperToCsv(
  series: PerDeveloperSeries,
  meta: { scopeLabel: string; asOfDate: string | null },
): string {
  // Explicitly SIGNED, matching the screen's `signedPct`. An unsigned "0.0%" in
  // a delta header reads as a value rather than as "no change", and an unsigned
  // rise and fall are indistinguishable at a glance.
  const pct = (v: number | null) =>
    v === null ? 'n/a' : `${v >= 0 ? '+' : '-'}${(Math.abs(v) * 100).toFixed(1)}%`
  const lines = [
    `# tokenscope spend per active developer · scope=${meta.scopeLabel} · window=${series.window.from}..${series.window.to} · as_of=${meta.asOfDate ?? 'n/a'}`,
    `# ${ACTIVE_DEVELOPERS_NOTE}`,
  ]
  if (series.deltas) {
    const d = series.deltas
    lines.push(
      `# last ${series.deltaDays}d vs the ${series.deltaDays}d before · per head ${pct(d.perDeveloperUsd.deltaPct)} · active developers ${pct(d.activeDevelopers.deltaPct)} · total spend ${pct(d.totalSpendUsd.deltaPct)}`,
    )
  } else {
    lines.push(
      `# deltas withheld — the window is shorter than the two ${series.deltaDays}-day halves they compare`,
    )
  }
  lines.push('day,spend_usd,active_developers,per_developer_usd')
  for (const p of series.points) {
    lines.push(
      `${p.day},${usd(p.spendUsd)},${p.activeDevelopers},${p.perDeveloperUsd === null ? '' : usd(p.perDeveloperUsd)}`,
    )
  }
  return lines.join('\n') + '\n'
}
