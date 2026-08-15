# Changelog

Reader-facing release notes for TokenScope. Each entry is one line: what
changed, as a user of the product would describe it. Entries accumulate under
`Unreleased`; each dated section below is one public snapshot. (Maintainers:
the publish tooling stamps the heading and a pre-PR gate reminds you to add
the line — see the internal `tools/publish/README.md`, which is not part of
the public mirror.)

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
