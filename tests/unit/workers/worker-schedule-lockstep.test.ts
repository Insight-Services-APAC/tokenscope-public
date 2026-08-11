/*
 * Every registry worker MUST have a cron entry in worker-jobs.bicep.
 *
 * WHY: a worker registered in registry.ts but missing from the bicep `workers`
 * array gets no `caj-ts-*` Container Apps job — so it is never dispatched and
 * silently does nothing. Nothing fails; the feature just quietly does not exist.
 * This has bitten this project repeatedly and expensively:
 *
 *   - placement-sync unscheduled → pending_placement never drained, no
 *     bill-sourced teammates were minted, and reconciliation reported only
 *     pre-existing users (the Dev "only Phil" defect, PR #118).
 *   - the same trap is called out by name in the bicep comments for
 *     copilot-pool-bill and placement-sync, which is evidence it keeps recurring
 *     and that comments alone do not prevent it.
 *   - attribution-gap (this branch) is a DETECTOR: unscheduled, the silent
 *     outage class it exists to catch would stay undetected exactly as before,
 *     and the branch would look complete while delivering nothing.
 *
 * Comments cannot enforce this; a test can. Parsing bicep with a regex is crude,
 * but the alternative is trusting a human to diff two lists forever.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKERS } from '../../../server/workers/registry'
import { UNSCHEDULED_WORKERS } from '../../../shared/workers/unscheduled'

// Resolved from the repo root (vitest cwd), not import.meta.url: this file imports
// server/workers/registry, and under the nuxt vitest environment that transform
// leaves import.meta.url as a non-file scheme.
const bicep = readFileSync(resolve(process.cwd(), 'infra/modules/worker-jobs.bicep'), 'utf8')

/** Worker names with a scheduled Container Apps job, from the bicep `workers` array. */
function scheduledWorkerNames(): string[] {
  const arrayBlock = /var workers = \[([\s\S]*?)\n\]/.exec(bicep)
  expect(arrayBlock, 'could not find the `var workers = [...]` array in worker-jobs.bicep').toBeTruthy()
  return [...arrayBlock![1]!.matchAll(/\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]!)
}

/**
 * The ACA job name each entry derives, honouring an optional `jobName` override.
 * Azure caps Container Apps job names at 32 chars; exceeding it fails the whole
 * module deployment in ARM, not in CI — so the length is asserted below.
 */
function derivedJobNames(): Array<{ worker: string; jobName: string }> {
  const arrayBlock = /var workers = \[([\s\S]*?)\n\]/.exec(bicep)!
  const out: Array<{ worker: string; jobName: string }> = []
  for (const m of arrayBlock[1]!.matchAll(/\{\s*name:\s*'([^']+)'[^}]*\}/g)) {
    const entry = m[0]
    const override = /jobName:\s*'([^']+)'/.exec(entry)
    out.push({ worker: m[1]!, jobName: `caj-ts-${override ? override[1]! : m[1]!}` })
  }
  return out
}

/**
 * Cron expressions keyed by worker name.
 *
 * The trailing `[^}]*` matters: an earlier version required `}` IMMEDIATELY after
 * the cron, so any entry carrying a further property (e.g. the `jobName` override
 * on privileged-identity-cleanup) silently failed to match and was never
 * shape-checked at all. A guard that quietly skips its hardest case is worse than
 * no guard, so match the same way derivedJobNames() does.
 */
function scheduledCrons(): Map<string, string> {
  const arrayBlock = /var workers = \[([\s\S]*?)\n\]/.exec(bicep)!
  const out = new Map<string, string>()
  for (const m of arrayBlock[1]!.matchAll(/\{\s*name:\s*'([^']+)',\s*cron:\s*'([^']+)'[^}]*\}/g)) {
    out.set(m[1]!, m[2]!)
  }
  return out
}

/*
 * Registered workers deliberately NOT scheduled, each with a tracked reason.
 *
 * This started (PR #185) as a seven-entry DEFECT list — the guard found seven
 * workers that declared a recommendedCron yet had never been wired into a cron.
 * Six were scheduled; the one that remains is blocked for a concrete reason, not
 * oversight.
 *
 * The list now lives in shared/ because the RUNTIME needs it too: the admin
 * worker-controls card was rendering a cron beside a worker that has no job,
 * which reads to an operator as "this runs monthly" when it never runs at all.
 * One source, enforced here in both directions.
 *
 * Rules: never add an entry to silence a failure — an entry means "we know, and
 * it is tracked, and here is the blocker". Removing one (by scheduling the
 * worker) must also remove it here.
 */
const KNOWN_UNSCHEDULED = UNSCHEDULED_WORKERS

describe('worker schedule lockstep (registry ↔ worker-jobs.bicep)', () => {
  it('EVERY registered worker has a Container Apps cron entry (or is a KNOWN gap)', () => {
    const scheduled = new Set(scheduledWorkerNames())
    const unscheduled = WORKERS.map((w) => w.name).filter((n) => !scheduled.has(n) && !(n in KNOWN_UNSCHEDULED))
    expect(
      unscheduled,
      `these workers are registered but have NO cron in infra/modules/worker-jobs.bicep, so they will NEVER run and will fail silently: ${unscheduled.join(', ')}`,
    ).toEqual([])
  })

  it('the known-gap list only ever SHRINKS (a scheduled worker must be removed from it)', () => {
    // Stops the list becoming a dumping ground: once a worker is actually
    // scheduled, leaving it here would silently re-permit a future regression.
    const scheduled = new Set(scheduledWorkerNames())
    const staleEntries = Object.keys(KNOWN_UNSCHEDULED).filter((n) => scheduled.has(n))
    expect(
      staleEntries,
      `these are now scheduled — delete them from KNOWN_UNSCHEDULED: ${staleEntries.join(', ')}`,
    ).toEqual([])
  })

  it('every known-gap entry still refers to a real registered worker', () => {
    const registered = new Set(WORKERS.map((w) => w.name))
    const ghosts = Object.keys(KNOWN_UNSCHEDULED).filter((n) => !registered.has(n))
    expect(ghosts, `KNOWN_UNSCHEDULED references workers that no longer exist: ${ghosts.join(', ')}`).toEqual([])
  })

  it('every scheduled job corresponds to a real registered worker', () => {
    // The other direction: a cron for a worker that no longer exists dispatches
    // to a 404 every tick — noise that erodes trust in the job list.
    const registered = new Set(WORKERS.map((w) => w.name))
    const orphaned = scheduledWorkerNames().filter((n) => !registered.has(n))
    expect(orphaned, `these bicep jobs reference workers that are not registered: ${orphaned.join(', ')}`).toEqual([])
  })

  it('every derived ACA job name fits Azure\'s 32-char limit', () => {
    // Learned the hard way: 'caj-ts-privileged-identity-cleanup' is 34 chars, so
    // the module would have been REJECTED BY ARM at deploy — after CI went green
    // — taking the whole "schedule the stranded workers" change down with it.
    // A `jobName` override keeps the ACA name short while WORKER_NAME stays the
    // real registry key.
    for (const { worker, jobName } of derivedJobNames()) {
      expect(jobName.length, `${worker} derives ACA job name "${jobName}" (${jobName.length} chars) — Azure caps at 32; add a jobName override`).toBeLessThanOrEqual(32)
    }
  })

  it('every ACA job name is a valid Azure resource name (lowercase alnum + hyphens)', () => {
    for (const { worker, jobName } of derivedJobNames()) {
      expect(jobName, `${worker} derives an invalid ACA job name "${jobName}"`).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
    }
  })

  it('every cron expression is well-formed (5 fields)', () => {
    for (const [name, cron] of scheduledCrons()) {
      expect(cron.trim().split(/\s+/), `${name} has a malformed cron: "${cron}"`).toHaveLength(5)
    }
  })

  it('the registry cron EQUALS the deployed cron for every scheduled worker', () => {
    /*
     * recommendedCron is no longer a doc string. The admin worker-controls card
     * shows it to operators as the live schedule, so a mismatch means the UI
     * states a cadence the job does not run on.
     *
     * This is not hypothetical: budget-alert shipped with a registry cadence of
     * every 15 minutes against a deployed hourly cron. The ratified design says
     * hourly (its threshold is month-grain), so the card was quoting a cadence
     * that had been deliberately rejected — and nothing failed.
     */
    const deployed = scheduledCrons()
    const drift = WORKERS.filter((w) => deployed.has(w.name))
      .map((w) => ({ name: w.name, registry: w.recommendedCron, bicep: deployed.get(w.name)! }))
      .filter((d) => d.registry !== d.bicep)
    expect(
      drift,
      `registry recommendedCron disagrees with the deployed cron in worker-jobs.bicep — the admin card would show a schedule that is not in force: ${drift
        .map((d) => `${d.name} (registry '${d.registry}' vs bicep '${d.bicep}')`)
        .join(', ')}`,
    ).toEqual([])
  })

  it('no UNSCHEDULED worker is presented with a schedule', () => {
    // The runtime guard's premise: anything in UNSCHEDULED_WORKERS has no job, so
    // the enablement API must suppress its cron rather than imply one.
    const deployed = scheduledCrons()
    const contradictions = Object.keys(UNSCHEDULED_WORKERS).filter((n) => deployed.has(n))
    expect(
      contradictions,
      `these are marked unscheduled but DO have a cron job: ${contradictions.join(', ')}`,
    ).toEqual([])
  })

  it('the detector for the silent-attribution outage class is scheduled', () => {
    // Named explicitly, not just covered by the sweep above: this one exists
    // BECAUSE an outage went undetected for 19 days. If it is ever dropped from
    // the schedule, that must fail loudly and by name.
    expect(scheduledWorkerNames()).toContain('attribution-gap')
  })
})
