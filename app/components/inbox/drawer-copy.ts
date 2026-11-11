/*
 * What each inbox alert says in its drawer, and where its one button goes
 * (#573).
 *
 * Every kind the server writes (shared/inbox/categories.ts) is either drawn by
 * a bespoke body (over-budget, velocity, requests, conflicts, subscriptions,
 * escalations, budget nearly used) or by the sections below: what happened,
 * with the figures the alert carries; what it means for you; what to do. The
 * one primary button is `primaryAction`. tests/unit/components/inbox-drawer-copy
 * .test.ts reads KNOWN_INBOX_CATEGORIES and fails if a kind has no body or no
 * destination, or if a kind a developer receives points into /admin.
 *
 * Each sentence states only what the producer measured (the producer file is
 * named per kind). A field an older item lacks renders MISSING, never a blank
 * or "$0.00".
 */
import { fmtInstant, fmtUsd } from '../../composables/useFormat'
import { coverageStateWords } from '#shared/inbox/coverage-states'
import type { KnownInboxCategory } from '#shared/inbox/categories'
import type { InboxItem } from './types'

export const MISSING = 'not recorded on this alert'

export interface DrawerStep {
  text: string
  /** A command shown as code after the text. */
  code?: string
  after?: string
}
export interface DrawerSection {
  heading: 'What happened' | 'What it means' | 'What to do'
  text?: string
  steps?: DrawerStep[]
}
export interface DrawerCopy {
  sections: DrawerSection[]
  /** A closing line, e.g. that the alert closes by itself. */
  footnote?: string
  /** The producer's own operator note (admin kinds), shown under "Details from the check". */
  detail?: string
}
export interface DrawerAction {
  label: string
  to: string
}

/*
 * Where each kind's primary button lives. `footer`: `primaryAction` below.
 * `in-body`: the bespoke body carries it (it already linked the fix before
 * #573, from the item's own `actionHref` or project). `none`: TokenScope has
 * no screen that fixes it, and the body says so instead of pointing somewhere
 * that does not fix it (NO_FIX_SCREEN names why).
 */
export const NO_FIX_SCREEN: Partial<Record<KnownInboxCategory, string>> = {
  'sync-conflict':
    'A sync conflict is settled at the connector, not in TokenScope: no screen changes sync_conflict.resolution, and resolving the item does not either (server/workers/connector-health.ts re-raises it while it is pending).',
  'structural-conflict': 'No producer writes it (server/notifications/dispatch.ts); it shares the sync-conflict body.',
  'connector-health':
    'No admin page lists owed bills waiting to be placed: the governance-unresolved diagnostics route exists (server/api/v1/admin/diagnostics/governance-unresolved.get.ts) but no screen reads it.',
}
export const PRIMARY_DESTINATION: Record<KnownInboxCategory, 'footer' | 'in-body' | 'none'> = {
  'over-budget': 'footer',
  'budget-nearly-used': 'footer',
  'velocity-warning': 'footer',
  'project-request': 'in-body',
  'project-request-decided': 'in-body',
  'quota-request': 'in-body',
  'quota-request-decided': 'in-body',
  'project-ending-soon': 'footer',
  'project-ended-retag': 'footer',
  'untagged-backlog': 'footer',
  'sync-conflict': 'none',
  'structural-conflict': 'none',
  'over-attribution': 'footer',
  'reconciliation-gap': 'footer',
  'connector-health': 'none',
  'read-path-stale': 'footer',
  'joiner-selection-cap': 'footer',
  'attribution-gap': 'footer',
  'went-silent': 'footer',
  'github-coverage-gap': 'footer',
  'ops-alert': 'footer',
  'copilot-bill-unsettled': 'footer',
  'copilot-bill-unclassified': 'footer',
  'personal-subscription-prompt': 'in-body',
  'over-emission-escalated': 'in-body',
}

/*
 * The kinds the server routes to admins only (server/notifications/dispatch.ts
 * resolveRecipients). Their button may open an admin page; every other kind's
 * may not, because a developer receives it.
 */
export const ADMIN_ROUTED_KINDS: ReadonlySet<string> = new Set<KnownInboxCategory>([
  'sync-conflict',
  'structural-conflict',
  'connector-health',
  'read-path-stale',
  'joiner-selection-cap',
  'attribution-gap',
  'github-coverage-gap',
  'ops-alert',
  'copilot-bill-unsettled',
  'copilot-bill-unclassified',
  'project-request',
  'over-emission-escalated',
])

const DEVICES = '/account#your-devices'
const WORKLIST = '/#worklist'
const MY_USAGE = '/usage'
const DIAGNOSTICS = '/admin/diagnostics'
const PROVIDERS = '/admin/reconciliation?tab=providers'

function str(body: Record<string, unknown>, k: string): string | null {
  const v = body[k]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}
function num(body: Record<string, unknown>, k: string): number | null {
  const v = body[k]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
const usd = (v: number | null) => (v === null ? MISSING : fmtUsd(v))
const pct = (v: number | null) => (v === null ? MISSING : `${Math.round(v * 100)}%`)

/** A UTC day (a provider fact): never converted to the viewer's zone. */
function utcDay(raw: string | null): string {
  const m = raw ? /^(\d{4}-\d{2}-\d{2})/.exec(raw) : null
  if (!m) return MISSING
  const d = new Date(`${m[1]}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return MISSING
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d)
}
/** A month key ('2026-11' or '2026-11-01') as "November 2026", in UTC. */
function utcMonth(raw: string | null): string {
  const m = raw ? /^(\d{4})-(\d{2})/.exec(raw) : null
  if (!m) return MISSING
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  )
}
/** An instant: rendered in the viewer's zone. */
function instant(raw: string | null): string {
  if (!raw) return MISSING
  const s = fmtInstant(raw)
  return s === '—' ? MISSING : s
}
function shortDevice(id: string | null): string {
  return id ? id.slice(0, 8) : MISSING
}

/* Shared by every "your device is not sending usage" kind. */
const STATUS_STEPS: DrawerStep[] = [
  { text: "1. On that computer, check TokenScope's status. In Claude Code run", code: '/tokenscope:status', after: "; in GitHub Copilot CLI ask for the TokenScope status skill." },
  { text: '2. If it says the device is not connected, set it up again. In Claude Code run', code: '/tokenscope:setup', after: '; in GitHub Copilot CLI use the tokenscope-setup skill. Then restart the tool.' },
]
const STILL_COUNTED =
  "Where the provider reports your usage to TokenScope, it is still counted from that report, as whole days with no sessions. You cannot see which session or project it came from until the device sends again."

/**
 * The sections for a kind drawn from this table; null for a kind with a
 * bespoke body (InboxDrawer picks those by variant).
 */
export function drawerCopy(
  item: Pick<InboxItem, 'category' | 'body'> & Pick<Partial<InboxItem>, 'target_device_name'>,
): DrawerCopy | null {
  const b = item.body ?? {}
  // The recipient's own name for the device when it has one (#576), else its short id.
  const deviceName = item.target_device_name?.trim() || null
  switch (item.category) {
    // ── Developer kinds ────────────────────────────────────────────────────
    case 'project-ending-soon': {
      // server/notifications/project-lifecycle.ts notifyProjectEndingSoon
      const days = num(b, 'daysRemaining')
      return {
        sections: [
          {
            heading: 'What happened',
            text: `Project ${str(b, 'project') ?? MISSING} ends on ${utcDay(str(b, 'endDate'))} (UTC)${days !== null ? `, ${days} day${days === 1 ? '' : 's'} from when this alert was sent` : ''}.`,
          },
          {
            heading: 'What it means',
            text: 'Usage recorded after that day, and after any grace period your admins set, is not charged to this project. TokenScope will ask you to re-tag it.',
          },
          {
            heading: 'What to do',
            text: "If the work goes on, ask the project's manager whether it is being extended, or tag new sessions to the project that takes over.",
          },
        ],
      }
    }
    case 'project-ended-retag':
      // server/notifications/project-lifecycle.ts notifyProjectEndedRetag
      return {
        sections: [
          { heading: 'What happened', text: `Project ${str(b, 'project') ?? MISSING} has ended, and some of your usage was recorded against it after it ended.` },
          { heading: 'What it means', text: 'That usage is not charged to any project until you tag it.' },
          { heading: 'What to do', text: 'Tag those sessions to the project they belong to, in the worklist on your Home page.' },
        ],
      }
    case 'untagged-backlog':
      // server/workers/reconciliation.ts: Anthropic-reported spend with no
      // recorded session (tagged or not), this UTC month. Not untagged sessions.
      return {
        sections: [
          {
            heading: 'What happened',
            text: `Anthropic reports ${usd(num(b, 'anthropic_actual_usd'))} of Claude usage for you this month. Sessions from your devices account for ${usd(num(b, 'otel_attributed_usd'))} of it, so ${pct(num(b, 'gap_pct'))} is spend the provider reported that no session from your devices accounts for.`,
          },
          { heading: 'What it means', text: `Usually one of your devices is not sending usage; it can also be usage TokenScope does not record per session. ${STILL_COUNTED}` },
          { heading: 'What to do', steps: STATUS_STEPS },
        ],
      }
    case 'reconciliation-gap':
      // server/workers/reconciliation-gap.ts
      return {
        sections: [
          {
            heading: 'What happened',
            text: `${usd(num(b, 'gap_usd'))} (${pct(num(b, 'gap_pct'))}) of the Claude usage Anthropic reports for you in ${utcMonth(str(b, 'month'))} is spend that no session from your devices accounts for. Anthropic reports ${usd(num(b, 'anthropic_actual_usd'))}; sessions from your devices account for ${usd(num(b, 'otel_attributed_usd'))}.`,
          },
          { heading: 'What it means', text: `Usually one of your devices is not sending usage; it can also be usage TokenScope does not record per session. ${STILL_COUNTED}` },
          { heading: 'What to do', steps: STATUS_STEPS },
        ],
      }
    case 'went-silent':
      // server/workers/went-silent.ts: the device's emit credential was refused.
      return {
        sections: [
          {
            heading: 'What happened',
            text: `Your device ${deviceName ?? shortDevice(str(b, 'instanceId'))} stopped sending usage at ${instant(str(b, 'detectedAt'))}: TokenScope refused its sign-in.`,
          },
          { heading: 'What it means', text: STILL_COUNTED },
          { heading: 'What to do', steps: STATUS_STEPS },
        ],
        footnote: 'Nothing is blocked. This alert closes by itself when the device can send again.',
      }
    case 'over-attribution':
      // server/workers/reconciliation.ts: recorded session spend above Anthropic's report.
      return {
        sections: [
          {
            heading: 'What happened',
            text: `Your recorded sessions this month come to ${usd(num(b, 'otel_attributed_usd'))}, which is ${pct(num(b, 'over_pct'))} more than the ${usd(num(b, 'anthropic_actual_usd'))} Anthropic reports for you.`,
          },
          {
            heading: 'What it means',
            text: 'Recorded usage should not exceed what Anthropic reports, so some of it may not be yours, or may be on the wrong account.',
          },
          { heading: 'What to do', text: 'Look through My usage for sessions or devices you do not recognise. If you find one, revoke the device on your account page.' },
        ],
      }

    // ── Admin and pipeline kinds: one sentence each, and the page that fixes it ─
    case 'connector-health':
      // server/workers/connector-health.ts
      return admin(
        `${num(b, 'count') ?? MISSING} owed bill${num(b, 'count') === 1 ? ' has' : 's have'} waited more than ${num(b, 'grace_days') ?? MISSING} days to be placed.`,
        'Until a bill is placed it is not charged to a Business Unit. No screen in TokenScope lists the waiting bills yet.',
        null,
        b,
      )
    case 'read-path-stale':
      // server/workers/read-path-health.ts
      return admin(
        'TokenScope has stopped reading the usage that devices send.',
        'Usage that devices send is not recorded until the reading recovers. Diagnostics shows the reading worker and its last runs.',
        'This alert closes by itself when the reading is healthy again.',
        b,
      )
    case 'joiner-selection-cap':
      // server/workers/azure-monitor-reader.ts recordJoinerSelectionCap
      return admin(
        `More devices were due to be read than one run reads (${num(b, 'cap') ?? MISSING}).`,
        'Each run leaves out the least recently active devices, so their usage can be recorded late.',
        'This alert closes by itself when a run fits all due devices.',
        b,
      )
    case 'attribution-gap': {
      // server/workers/attribution-gap.ts. #587: the gap reads as a duration,
      // the device keeps only its short id (so two can be told apart), and the
      // producer's operator note (a repo path and runbook shorthand) is not
      // shown: the steps below are what an admin does.
      const copy = admin(
        `${str(b, 'teammate') ?? MISSING}'s device ${shortDevice(str(b, 'instance_id'))} took a new sending credential in the last day, but the newest usage recorded from it is ${roughDuration(num(b, 'gap_hours'))} older than that credential.`,
        "It may be sending usage that is not being read, which would then be missing from that person's usage and projects.",
        'This alert closes by itself when the gap is gone, which can also happen when the device stops sending.',
        b,
        { withDetail: false },
      )
      copy.sections.push({
        heading: 'What to do',
        steps: [
          { text: '1. Open Diagnostics, Attribution gaps, and press Diagnose on this device. It shows whether its usage is reaching TokenScope at all.' },
          { text: '2. If Diagnose shows usage arriving that was not recorded, re-read the device from the same panel. Re-reading needs the Admin role; a Region admin cannot.' },
          { text: '3. If Diagnose finds nothing arriving, the device is probably not sending: ask its owner to check TokenScope\'s status on that computer.' },
        ],
      })
      return copy
    }
    case 'ops-alert':
      // server/workers/ops-alert.ts
      return admin(
        `The service condition ${str(b, 'condition') ?? MISSING} is ${str(b, 'severity') ?? MISSING}.`,
        opsConditionMeaning(str(b, 'condition')),
        'This alert closes by itself when the condition recovers.',
        b,
      )
    case 'github-coverage-gap':
      // server/reconciliation/coverage-alerts.ts
      return admin(
        str(b, 'kind') === 'capability-loss'
          ? `TokenScope can no longer tell which organisations GitHub enterprise ${str(b, 'enterpriseExternalId') ?? MISSING} covers (${str(b, 'reason') ?? MISSING}).`
          : `GitHub organisation ${str(b, 'org') ?? MISSING} in enterprise ${str(b, 'enterpriseExternalId') ?? MISSING} is ${coverageStateWords(str(b, 'state'))}.`,
        str(b, 'kind') === 'capability-loss'
          ? 'TokenScope cannot check that every organisation in this enterprise is covered, so an organisation whose Copilot usage is not read would go unnoticed. Give the reconciliation app "Enterprise organization installations: read", or check its app key, then Recheck under Admin, Reconciliation, Providers.'
          : 'Copilot usage from an organisation that is not covered is not read. Fix it in the Coverage column under Admin, Reconciliation, Providers: edit, discover, delete or recheck the organisation there.',
        'This alert closes by itself when coverage is back.',
        b,
        // The stored hint is left out: alerts stored before #591 carry
        // "Reconciliation -> Providers (Edit / Discover / ...)", and the
        // meaning above already says where to fix it.
        { withDetail: false },
      )
    case 'copilot-bill-unsettled':
      // server/workers/copilot-pool-bill.ts
      if (str(b, 'kind') === 'org-name-mismatch') {
        return admin(
          `None of the organisation names on the Copilot bill for enterprise ${str(b, 'enterprise') ?? MISSING}, ${utcMonth(str(b, 'month'))}, match an organisation registered in TokenScope.`,
          'The bill cannot be split by organisation, so all of it waits as one unallocated remainder. Check the registered organisations under Reconciliation, Providers.',
          null,
          b,
        )
      }
      return admin(
        str(b, 'kind') === 'residual-unsettled'
          ? `The part of the Copilot bill for enterprise ${str(b, 'enterprise') ?? MISSING}, ${utcMonth(str(b, 'month'))}, that no registered organisation owns has usage but no licence charge TokenScope could read.`
          : `The Copilot bill for ${str(b, 'org') ?? str(b, 'enterprise') ?? MISSING}, ${utcMonth(str(b, 'month'))}, has usage but no licence charge TokenScope could read.`,
        'That month reads as unsettled until the bill is checked. Check the organisation under Reconciliation, Providers.',
        null,
        b,
      )
    case 'copilot-bill-unclassified':
      // server/workers/copilot-pool-bill.ts
      return admin(
        str(b, 'kind') === 'conservation-violation'
          ? `The Copilot bill for ${str(b, 'org') ?? str(b, 'enterprise') ?? MISSING}, ${utcMonth(str(b, 'month'))}, does not add up: its parts differ from its total by ${usd(num(b, 'deltaUsd'))}.`
          : `The Copilot bill for ${str(b, 'org') ?? str(b, 'enterprise') ?? MISSING}, ${utcMonth(str(b, 'month'))}, has ${usd(num(b, 'unclassifiedNetUsd'))} of spend TokenScope cannot classify.`,
        'Unclassified spend is counted and flagged, and never charged. Check the organisation under Reconciliation, Providers, then run the month again.',
        null,
        b,
      )
    default:
      return null
  }
}

/** Hours as a reader says them: "about 3 days", "about 5 hours", "under an hour". */
export function roughDuration(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return MISSING
  if (hours < 1) return 'under an hour'
  if (hours < 36) {
    const h = Math.round(hours)
    return `about ${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  const d = Math.round(hours / 24)
  return `about ${d} ${d === 1 ? 'day' : 'days'}`
}

function admin(
  happened: string,
  means: string,
  closes: string | null,
  b: Record<string, unknown>,
  opts: { withDetail?: boolean } = {},
): DrawerCopy {
  const hint = opts.withDetail === false ? null : (str(b, 'hint') ?? str(b, 'summary'))
  return {
    sections: [
      { heading: 'What happened', text: happened },
      { heading: 'What it means', text: means },
    ],
    footnote: closes ?? undefined,
    detail: hint ?? undefined,
  }
}

/**
 * The drawer's one primary button for footer kinds; null for in-body kinds,
 * and when the item carries nothing to go to.
 */
export function primaryAction(
  item: Pick<InboxItem, 'category' | 'target_allocation_id' | 'target_project_code'>,
): DrawerAction | null {
  const project = item.target_project_code ? `/projects/${encodeURIComponent(item.target_project_code)}` : null
  switch (item.category as KnownInboxCategory) {
    case 'over-budget':
    case 'budget-nearly-used':
      // Only to the editor this recipient can open; otherwise the header's
      // "Open project" link is the way forward and Resolve stays.
      return item.target_allocation_id
        ? { label: 'Add top-up', to: `/allocations/${item.target_allocation_id}?focus=topup` }
        : null
    case 'project-ending-soon':
      return project ? { label: 'Open project', to: project } : { label: 'Open My projects', to: '/projects' }
    case 'project-ended-retag':
      return { label: 'Re-tag in the worklist', to: WORKLIST }
    case 'untagged-backlog':
    case 'reconciliation-gap':
    case 'went-silent':
      return { label: 'Open my devices', to: DEVICES }
    case 'velocity-warning':
    case 'over-attribution':
      return { label: 'Open My usage', to: MY_USAGE }
    case 'read-path-stale':
    case 'joiner-selection-cap':
    case 'attribution-gap':
    case 'ops-alert':
      return { label: 'Open Diagnostics', to: DIAGNOSTICS }
    case 'github-coverage-gap':
    case 'copilot-bill-unsettled':
    case 'copilot-bill-unclassified':
      return { label: 'Open Providers', to: PROVIDERS }
    default:
      return null
  }
}

/*
 * What a service condition means for the admin reading it (#587): the
 * consequence, not a pointer. Keys from shared/ops-alert/conditions.ts.
 */
export function opsConditionMeaning(condition: string | null): string {
  switch (condition) {
    case 'telemetry-read':
      return 'TokenScope cannot read the usage devices send, so new sessions are not recorded until it can. Nothing already recorded is lost.'
    case 'attribution-stall':
      return 'Runs that should record usage against people and projects have recorded nothing for a while, although usage has reached TokenScope (or, when that cannot be measured, devices have recently signed in to send). Recent spend can be missing from their pages until this clears. When arrivals cannot be measured, this alert errs toward warning you.'
    case 'worker-fleet':
      return 'Several background jobs are failing at once, so alerts, rollups and provider reads can be late or missing.'
    case 'probe-network':
      return 'A service TokenScope depends on cannot be reached on the private network, so the jobs that use it fail until it can.'
    case 'worker-duration':
      return "Background jobs are taking close to, or longer than, the time their scheduled trigger waits for a reply. A job past it can still finish, but its run is reported as failed and may be retried, so the same work can run twice."
    case 'telemetry-cap':
      return "Device usage is close to the telemetry workspace's daily cap. Past the cap, usage sent that day is dropped and cannot be recovered."
    case 'channel-test':
      return 'This is the test message sent when TokenScope is deployed, to prove alerts reach you. Nothing is wrong.'
    default:
      if (condition?.startsWith('worker:')) {
        return `The background job ${condition.slice('worker:'.length)} keeps failing, so the work it does (an alert, a rollup or a provider read) is late or missing.`
      }
      return 'Part of the service is not working as it should, so some figures or alerts can be late or missing.'
  }
}
