# Contributing to TokenScope

Thanks for your interest. TokenScope is open source under
[Apache-2.0](LICENSE), and contributions are welcome — code, docs, provider
adapters, and thoughtful issues.

## Before you start

TokenScope is **opinionated** (see [docs/PRINCIPLES.md](docs/PRINCIPLES.md)). The
most useful contributions align with the TokenSheets paradigm and the two-lens
(§A usage / §B billing) discipline. If you're proposing something that changes
that shape, open an issue to discuss it first — it's not that the idea is wrong,
it's that fit is a design goal.

## Development

```bash
npm install
npm run dev:stack && npm run dev     # local stack + app (see docs/RUN-LOCALLY.md)
npm run typecheck && npm run lint
npm run test:unit && npm run test:integration
```

## Pull requests

- Branch off `main`; keep PRs focused.
- Match the surrounding code's style, naming, and comment density.
- Add or update tests for behaviour changes. The suites are the contract.
- Keep the **§A/§B separation** clean — don't let usage logic invent billing, or
  vice-versa.
- Update the relevant `docs/` page if you change behaviour, config, or deploy.
- Make sure `typecheck`, `lint`, and the test suites pass.

## Adding a provider

The attribution pipeline is provider-generic. A new provider typically needs an
emission path (native OpenTelemetry is ideal), an identity join key (reuse
`tokenscope.instance_id`), and — for billing (§B) — a usage/billing API adapter.
See [docs/PROVIDERS.md](docs/PROVIDERS.md#adding-a-provider).

## Reporting bugs & security

- Bugs / features: open a GitHub issue (templates provided).
- Security vulnerabilities: **do not** open a public issue — see
  [SECURITY.md](SECURITY.md).

## Licence of contributions

By submitting a contribution you agree it is licensed under Apache-2.0, per
LICENSE §5.
