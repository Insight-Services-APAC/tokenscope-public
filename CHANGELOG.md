# Changelog

Reader-facing release notes for TokenScope. Each entry is one line: what
changed, as a user of the product would describe it. Entries accumulate under
`Unreleased`; each dated section below is one public snapshot. (Maintainers:
the publish tooling stamps the heading and a pre-PR gate reminds you to add
the line — see the internal `tools/publish/README.md`, which is not part of
the public mirror.)

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
