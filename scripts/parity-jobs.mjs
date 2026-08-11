/*
 * parity-jobs — WHAT the parity gate shoots. Pure; no browser, no clock, no env.
 *
 * Split out from the capture driver for one reason: the gate's own coverage is
 * now a property worth testing. Fix-sprint D29 exists because the capture shot a
 * single width, mid-month, and therefore could not see S3 (the hero tiles become
 * two-up below `xl`) or S4 (every hero spark is replaced by prose for the first
 * six days of every month). Both defects were found by the owner on Dev instead.
 * `tests/unit/scripts/parity-gate.test.ts` (T29) asserts the matrix covers a
 * narrow width and a day-1 clock, so removing either goes red here rather than
 * on Dev six weeks later.
 *
 * TWO AXES, MULTIPLIED.
 *
 *   width — 1600 (as before) AND 1120. The hero rows auto-fit at
 *           `minmax(168px,1fr)`; 1600 is above every breakpoint in the product,
 *           so a row that silently becomes two-up looks perfect at 1600 and
 *           wrong on a laptop. The prototype says so in as many words
 *           (`prototype.html` note `tiles`: "shoot parity narrow (1120px) or the
 *           gate cannot see it").
 *
 *   state — `mid` and `d1`. The developer-pages prototype already draws both
 *           (`#…&st=mid|d1`); only the APP side was missing. The app reaches d1
 *           through `?clock=` — the demo-env-only pin (`server/utils/clock-pin.ts`)
 *           that seeds the F1 request clock. That is a REAL day 1: the server
 *           resolves `today`, `settledThrough` and every window from it, so the
 *           month-start spark, the one-column burn chart and the withheld deltas
 *           are the genuine article, not a CSS trick.
 *
 * THE CLOCK IS AN ARGUMENT, NEVER A READ. `buildJobs` takes `today` and derives
 * the day-1 instant from it. A `new Date()` in here would be the fifteenth
 * browser clock (`clock-rot-audit.md` §B) wearing a build-script hat.
 */

/** The widths the gate shoots. Narrow first: it is the one that regressed. */
export const DEFAULT_WIDTHS = [1120, 1600]

/** The period states. `mid` is whatever the clock says; `d1` is pinned. */
export const DEFAULT_STATES = ['mid', 'd1']

/** Scopes that live on the developer-pages prototype (the second drawing). */
const DEVELOPER_SCOPES = new Set(['usage', 'projects', 'project', 'teammate'])

/**
 * Prototype viewer per developer arm, matching what the DEFAULT persona sees in
 * the app: self depth for usage/projects, reports depth for the project detail
 * and the drill (the default persona is not a project member, and the drill
 * exists only for reports viewers — self redirects, pm 403s).
 */
const PROTO_VIEWER = { usage: 'self', projects: 'self', project: 'cou', teammate: 'cou' }

/**
 * The instant a `d1` shot pins the app to: the 1st of `today`'s own month, at
 * 09:00Z.
 *
 * The MONTH IS TODAY'S, deliberately. A fixed historical month would shoot a
 * page with no data in it and prove nothing; the 1st of the current month is a
 * day the seeded estate genuinely has spend either side of. 09:00Z rather than
 * 00:00Z so the shot is a day-1 *morning* — the state S4 is about, where the
 * month holds a few hours of spend and the spark has one point.
 */
export function dayOnePin(today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`today must be YYYY-MM-DD: ${today}`)
  return `${today.slice(0, 7)}-01T09:00:00.000Z`
}

/** `?clock=` (and any other pairs) appended to a URL that may already have a query. */
function withParams(url, params) {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '')
  if (entries.length === 0) return url
  const [base, hash = ''] = url.split('#')
  const sep = base.includes('?') ? '&' : '?'
  const qs = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `${base}${sep}${qs}${hash ? `#${hash}` : ''}`
}

/** The app URL for one scope, before the clock pin is applied. */
function appPath(scope, o) {
  switch (scope) {
    case 'region':
      return '/reporting'
    case 'cost-centres':
      return '/reporting?scope=cost-centre'
    case 'finance':
      return '/reporting?scope=finance'
    case 'usage':
      return '/usage'
    case 'projects':
      return '/projects'
    case 'project':
      return `/projects/${encodeURIComponent(o.projectCode)}`
    /*
     * BOTH operands or nothing: a grant-holding persona AND an `?src=` scope
     * frame. A frameless drill DELIBERATELY renders a no-frame card and never
     * fetches — a bare `teammate_id` is the thing the scope contract forbids —
     * so settle() would burn its whole timeout on a page behaving correctly.
     */
    case 'teammate':
      return o.teammateId
        ? `/reporting/teammate/${o.teammateId}?src=${encodeURIComponent(o.drillSrc)}`
        : null
    default:
      return null
  }
}

/**
 * The full shot matrix.
 *
 * @param {object} o
 * @param {string[]} o.scopes           scopes asked for on the command line
 * @param {string}   o.today            `YYYY-MM-DD` — the ONLY clock input
 * @param {string}   o.appBase          e.g. `http://localhost:3450`
 * @param {string}   o.protoBase        reporting prototype origin
 * @param {string}   o.proto2Base       developer-pages prototype origin
 * @param {number[]} [o.widths]
 * @param {string[]} [o.states]
 * @param {string}   [o.projectCode]
 * @param {string}   [o.teammateId]
 * @param {string}   [o.drillSrc]
 * @param {string}   [o.protoViewer]    override the per-arm viewer
 * @param {string}   [o.clockMid]       pin the `mid` state too (default: unpinned)
 * @returns {{name:string,url:string,width:number,state:string,file:string,settle:boolean,skipped?:string}[]}
 */
export function buildJobs(o) {
  const widths = o.widths ?? DEFAULT_WIDTHS
  const states = o.states ?? DEFAULT_STATES
  const scopes = o.scopes ?? []
  const drillSrc = o.drillSrc ?? 'across'
  const projectCode = o.projectCode ?? 'tokenscope-public'
  const wantDevPages = scopes.some((s) => DEVELOPER_SCOPES.has(s))

  const jobs = []
  const push = (name, url, width, state, settle) =>
    jobs.push({ name, url, width, state, settle, file: `${name}-${width}-${state}.png` })

  // ── The reporting prototype: one drawing, no period state of its own ───────
  // Shot per WIDTH only. Multiplying it by a state it does not draw would file
  // two byte-identical images and invite the reader to compare them.
  for (const width of widths) {
    push('proto-full', `${o.protoBase}/prototype.html`, width, 'static', true)
  }
  if (wantDevPages) {
    for (const width of widths) {
      push('proto-devpages', `${o.proto2Base}/prototype.html`, width, 'static', true)
    }
  }

  for (const state of states) {
    // A static drawing takes `st=`; the app takes a real pinned clock.
    const clock = state === 'd1' ? dayOnePin(o.today) : (o.clockMid ?? null)

    for (const width of widths) {
      // ── The developer-pages prototype, one deep-linked image per arm ────────
      if (wantDevPages) {
        const p2 = `${o.proto2Base}/prototype.html`
        for (const scope of scopes) {
          if (!DEVELOPER_SCOPES.has(scope)) continue
          /*
           * `?a=` is a cache-buster, not a parameter: a goto that changes only
           * the fragment is a same-document navigation, so the hash reader
           * (which runs once, on load) would never see the new deep link and
           * every arm would shoot the same page.
           */
          const viewer = o.protoViewer ?? PROTO_VIEWER[scope]
          push(
            `proto-devpages-${scope}`,
            `${p2}?a=${scope}-${state}#p=${scope}&v=${viewer}&st=${state}`,
            width,
            state,
            true,
          )
        }
      }

      // ── The app, its counterpart shot at the same width and same state ─────
      for (const scope of scopes) {
        const path = appPath(scope, { projectCode, teammateId: o.teammateId, drillSrc })
        if (path == null) {
          jobs.push({
            name: `app-${scope}`,
            url: null,
            width,
            state,
            settle: false,
            file: `app-${scope}-${width}-${state}.png`,
            skipped:
              scope === 'teammate'
                ? 'needs PARITY_TEAMMATE=<seeded teammate uuid>'
                : `unknown scope: ${scope}`,
          })
          continue
        }
        push(`app-${scope}`, withParams(`${o.appBase}${path}`, { clock }), width, state, true)
      }
    }
  }
  return jobs
}
