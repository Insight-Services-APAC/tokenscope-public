# Changelog

Reader-facing release notes for TokenScope. Each entry is one line: what
changed, as a user of the product would describe it. Entries accumulate under
`Unreleased`; each dated section below is one public snapshot. (Maintainers:
the publish tooling stamps the heading and a pre-PR gate reminds you to add
the line — see the internal `tools/publish/README.md`, which is not part of
the public mirror.)

## 2026-09-02 (snapshot 39578d5f)

- Re-running setup in a repo tagged for a project no longer leaves that session
  quietly reporting the wrong device. The repo keeps its own copy of the
  enrolment, and it is only refreshed once the session has already started, so
  the session that set things up carried on emitting under the previous device
  until it was restarted — its usage still counted, but it never appeared
  against the new one. Claude Code now says so at session start and tells you to
  restart. Repos without a project tag were never affected.

- The status line no longer shows a device that has never recorded anything as
  healthy. A brand-new enrolment is still given time to settle before anything
  is claimed, but one that has gone hours without a single record now reads as
  not landing rather than as an untroubling neutral state.

- Ops alerts stop paging for things you cannot act on at 3am. Only critical
  conditions reach the phone now; warnings are recorded in Admin's inbox
  instead. The "attribution has stalled" alert no longer fires just because a
  machine is switched on, and Admin's diagnostics now show the evidence behind
  it.

- My usage loads considerably faster. The page was re-reading your full spend
  history several times per view; it now reads finished days from a pre-computed
  daily summary and only today from the live records. The page checks the summary
  is complete and up to date before trusting it, and falls back to the old path
  automatically when it is not, so the two agree wherever the fast path is used.
  Admin's diagnostics show whether the job that maintains the summary is
  healthy.

- Admin's database check now shows whether per-statement recording is actually
  switched on, and whether it is storing statement text it should not be. It
  could previously report the instrument as loaded while it was recording
  nothing.

- Admin's database check now shows how far back its counts reach and when each
  table's statistics were last refreshed. A table can be read end-to-end simply
  because the planner has no figures to work from, and that was previously
  indistinguishable from a scan it chose deliberately. Indexes that enforce a
  constraint are no longer listed as unused.

- Pages now start drawing sooner. The header used to wait on three background
  requests before anything appeared, including two it made only to decide
  whether to show the Reporting link; that decision now arrives with your
  sign-in, and the unread-mail count fills in on its own.
- Admin's database diagnostics now show when each table's statistics were last
  refreshed. A table can be scanned end-to-end simply because the planner has no
  figures to work from — which is what a major database upgrade leaves behind —
  and that was previously indistinguishable from a scan it chose on purpose.

- The needs-tagging list could hide a session from you entirely. Sessions were
  ordered by their last activity with no tiebreaker, so when several shared the
  same timestamp the list showed a different, arbitrary selection each time you
  loaded it — and a session that kept losing the tie never appeared at all. The
  order is now stable, so the same sessions appear in the same order every time.

- Admin → Diagnostics can now answer "which database queries are slow?" on
  demand. A new Database performance check reports the heaviest statements,
  tables being scanned without an index, cache behaviour, indexes nothing uses,
  and the relevant server settings — so a slow page can be diagnosed from the
  admin pages instead of needing access to the cloud logging workspace. It runs
  only when you press the button, never on page load.

- Your usage page counted every Claude Code conversation as harness overhead.
  The lane each request came from was being compared against a label Claude
  Code has never actually sent, so real conversation tokens were filed as
  "auxiliary" — which is why the page could claim 100% of your volume was
  overhead and offer a large, wrong saving. Lanes are now read from the values
  the client really emits, and the overhead insight stays quiet when there is
  no conversation-lane signal to compare against rather than reporting 100%.
  Historical figures correct themselves on the next page load.

- Ops alerts now say why they fired. An alert page records the specific reason
  (a probe that timed out, a query that was refused, a worker streak) alongside
  the condition, and Admin → Workers shows each worker's slowest run and lets
  you open any run to read what it recorded — so an alert can be answered from
  the admin pages instead of reconstructed from timestamps. Alerts also wait for
  a second consecutive observation before paging, which stops a single slow
  check from raising a false alarm.

- Admin pages now change the moment you click a link and show a loading state
  while their data arrives, instead of appearing to do nothing until the
  slowest request had finished. The Diagnostics page loads its quick checks
  first and brings in its network/telemetry probes and cost checks separately,
  so the page is readable before the slow parts land. The Audit log's default
  view (newest first, no filters) also no longer waits for the whole log to be
  sorted before showing its first page.

- The Diagnostics worker card no longer shows a worker an admin has switched
  off as "failing" on failures from before it was disabled: a skipped run ends
  the failure streak the same way a successful one does (as the pager already
  did), and the worker now reads "disabled" rather than ok or failing.

- Scheduled workers no longer jam when many fire at the same minute. Each
  dispatch used to pin one database connection for its run-lock and then wait
  for a second from the same small pool, so a top-of-the-hour batch could wedge
  every worker at once — the telemetry reader stopped, the "attribution has not
  landed data" banner went up, and nothing recovered until a restart. The lock
  now lives on its own connections, so a large batch simply queues and finishes.

- The Diagnostics network card stops reporting failures nobody can fix: it no
  longer probes the Log Analytics agent endpoint (we run no agent, and the
  private endpoint has no such address), and it only dials the Azure Monitor
  hosts the app actually calls — the rest share one private endpoint, so their
  DNS answer is the evidence and a dial only invented red rows. Those two rows
  were also paging the operator as criticals every 15 minutes.

- TokenScope no longer competes with other teams for the shared Azure Monitor
  private-DNS records: dev reads telemetry through corporate IT's private-link
  scope instead of running a rival one, removing the conflict that silently took
  the read path down for 28 hours in August. The Diagnostics network card also
  stops calling a zone "working" on evidence it does not have — it can prove a
  zone is linked, not that it points at our own endpoint, and it now says so,
  and it no longer reports all-clear when a record fails to resolve at all.

- The last slow read on the reports page is gone: the Top-drivers project
  breakdown (and the Business-Unit population count behind it) now reads the
  same continuously pre-aggregated table as the rest of the region figures
  instead of rescanning the whole usage history on every request.
- TokenScope now pages its operator when the service degrades, instead of
  waiting to be looked at: a watchdog checks every 15 minutes that telemetry
  can actually be read, that attribution is landing data, and that the
  background workers are running, and pushes criticals to the operator's
  phone and email on first detection — with Azure-side alerts that still fire
  when the app itself is down. The usage pages now say when the figures may
  be missing recent spend: the freshness dot no longer shows green on data it
  cannot vouch for, and a banner appears while attribution is stalled.
- The Diagnostics network card no longer paints the deliberately-unused Dev
  redis as a failure: it shows a neutral "not mapped / not implemented"
  state, stays out of the failure counts, and never enters the copy-paste IT
  report.
- API responses now tell you where their time went (a Server-Timing header
  your browser's network tab shows: database vs app vs cache), admins can
  see how long each background worker ran over the last day, page assets
  download compressed, and the reporting rollup does a fraction of its
  former background work.

- Region reports open much faster: their figures are now pre-aggregated
  continuously in the background instead of being recomputed from full history
  on every request, so a page shows up in the time it takes to read one small
  table.
- The usage page and the reports open noticeably faster: every request now
  makes far fewer database roundtrips, connections stay warm between clicks,
  and the activity list does far less work per page — it builds full rows for
  only the sessions the page shows instead of every session you have ever
  had.

## 2026-08-19 (snapshot 74cf5c7c)

- Copilot usage now counts the tokens spent in the Copilot app, not just the
  Copilot CLI, and reports them as their own surface rather than folding them
  into CLI totals.
- Your usage page now shows how your Copilot work splits between the CLI and the
  Copilot app, and says when IDE activity cannot be shown on the same measure.
- The Copilot engagement card shows its language mix again. It had been blank
  for everyone, because it was weighted on a figure GitHub does not send.

## 2026-08-18 (snapshot ecd23e5b)

- The open-source mirror now publishes the engineering wiki to its own GitHub
  Wiki tab, instead of leaving it empty while the same pages sat in the repo
  tree, and its test suite no longer fails on files the mirror deliberately
  withholds.

## 2026-08-18 (snapshot 1358d845)

- The published open-source snapshot no longer ships an agent configuration
  whose hook pointed at tooling that is not part of the public tree, so running
  a coding agent against a public clone no longer fails on its first command.

## 2026-08-18 (snapshot cbedba50)

- Opening Reporting no longer shows "You don't have access to any reports" to
  people who do have access, and the page loads in place of the long wait that
  used to precede it.

- Administrators can now see, on the Diagnostics page and in the boot log,
  exactly how much of the database's row-level security is actually in force —
  which connection the app is using, how many tables are enforced, and whether
  the deployment can create the restricted database account the enforcement
  needs. Read-only: it reports, and changes nothing.
- Copilot per-seat showback no longer deletes valid rows when GitHub returns a
  partial seat roster: a response that is short, malformed, or smaller than the
  count GitHub itself reports now skips the clean-up instead of treating the
  missing seats as removed.
- Re-pulling a Copilot bill for a month is now restricted to finance
  administrators. It was open to regional administrators, who could trigger it
  for any enterprise, not just their own region's.
- GitHub Copilot reporting now works for an enterprise that has moved from a
  personal access token to the GitHub App: per-seat Copilot showback populates
  again, and "Discover Copilot orgs" lists the enterprise's organisations
  instead of failing. Both used to call an endpoint only a token can read, so
  an App-mode enterprise saw no seats and no orgs to onboard.
- Reconciliation keeps going when one GitHub enterprise's credentials are not
  wired up: previously that single misconfiguration stopped the hourly run
  before it reached anybody else's data.
- Budgets can no longer be recorded against a scope the product does not
  recognise, and a per-developer cap can only sit on a project or business-unit
  budget.

## 2026-08-15 (snapshot cd9e2ff0)

- The published repository's own test suite and checks now pass on a fresh
  clone. Four of them read files that are internal-only and therefore absent
  here, so they failed on every published snapshot; they now skip where the
  source they check does not exist, and still fail wherever it does.

## 2026-08-15 (snapshot 8cafda19)

- Security hardening round 2: a manager can no longer reach another region's
  projects or write allocations against them; a deactivated teammate now loses
  their API tokens as well as their browser session; the worker kill-switch is
  restricted to org-wide admins, matching the door that runs those workers; a
  malicious repository can no longer steer the plugin into writing your
  credential where it can read it, nor redirect where your telemetry is sent,
  and it can no longer choose which `curl` or `sh` the credential-refresh helper
  runs; and the setup helper ignores attempts to point it at another server.
- Attribution now raises an admin alert when the telemetry joiner hits its
  per-run device cap, instead of silently attributing only the busiest devices.
- Global finance and Platform admin see the whole company's reports by their
  role again, with no grant needed (Region admins are unchanged — still their
  own region); and an admin can now revoke one person's report access
  entirely — the "administer, no data" case — without changing their role.

## 2026-08-12 (snapshot 3c430d2f)

- The project site's landing page shows the six product screenshots (they were
  README-only, and the site builds from the docs folder where they never
  appeared).

## 2026-08-11 (snapshot 71467f44)

- Reporting access is now a per-teammate grant: an admin can give any user
  operational (company-wide regions and Business Units) or finance reporting
  without making them a platform admin — and platform roles no longer imply
  report access. Grants are revocable, can expire, and are fully audited.
- Public snapshots now carry these release notes, and code PRs are gated on
  adding their synopsis line.
- The README shows the product: six screenshots captured from the synthetic
  demo estate, and the demo data now uses canonical fictitious client names
  (Northwind Bank, Woodgrove Bank, Contoso League) with realistic per-developer
  spend generated through the real ingestion pipeline.
