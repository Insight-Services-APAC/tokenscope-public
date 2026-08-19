# Changelog

Reader-facing release notes for TokenScope. Each entry is one line: what
changed, as a user of the product would describe it. Entries accumulate under
`Unreleased`; each dated section below is one public snapshot. (Maintainers:
the publish tooling stamps the heading and a pre-PR gate reminds you to add
the line — see the internal `tools/publish/README.md`, which is not part of
the public mirror.)

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
