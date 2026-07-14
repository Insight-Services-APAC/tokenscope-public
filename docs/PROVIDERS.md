# Providers

TokenScope attributes any AI-coding tool that can emit OpenTelemetry token usage
(or expose a usage/billing API). Two are supported today; more follow as OTel and
provider APIs allow. Both onboard through **one OAuth-2.1 MCP server** and follow
the same **zero-touch, emit-now-attribute-later** principle.

## Claude Code

**Plugin:** `plugin/`.

- **Onboarding** — an MCP server (`/api/v1/mcp`) plus prompts (`tokenscope-setup`,
  `project`, `tag`, `usage`) and local commands (`/tokenscope:status`,
  `statusline`, `backfill`). One OAuth consent.
- **Emission** — **native OpenTelemetry**. Claude Code emits OTLP `api_request`
  log events (the token counts per API call) directly to the telemetry sink. The
  setup step mints a one-time handoff that is redeemed for a durable emit
  credential and points Claude's OTel exporter at your workspace.
- **Identity** — the setup step injects the server-minted `tokenscope.instance_id`
  resource attribute, so every emitted record joins to a teammate unspoofably.

## GitHub Copilot

**Plugin:** `copilot-plugin/`.

- **Onboarding** — the same MCP server plus skills (`tokenscope-setup`,
  `project`, `usage`).
- **Emission** — GitHub Copilot emits OpenTelemetry under the OTel **GenAI
  semantic conventions** (`gen_ai.usage.*`, `gen_ai.request.model`). TokenScope's
  read-side ingests that shape and joins on the same `tokenscope.instance_id`
  key, so a device's Claude and Copilot usage unify. (The design for the native
  managed-OTLP export path is in the repo; see the code comments in
  `server/azure/reader.ts` around the GenAI read-side, gated by
  `NUXT_COPILOT_NATIVE_OTEL`.)
- **Billing (§B)** — GitHub Copilot bills a **pooled** allowance per (org, SKU),
  which TokenScope charges **per cost-centre** via a configured GitHub-org →
  cost-owning-unit map — read from the bill, not inferred from seats. Per-user
  Copilot usage is *shown* (§A), not charged.

## Reconciliation (both providers)

Alongside the streaming OTel signal, a batch **truth-poller** reads the
provider's usage/billing API and reconciles:

- **§A completeness** — fills the gap between the provider's per-user/day total
  and what OTel captured, so "my usage" is never under the provider's truth.
- **§B billing** — the authoritative cost-of-record, at the provider's billing
  grain.

Per-organisation **reconciliation lanes** decide whether a provider's spend is
*reconciled* (billable) or *indicative* (tracked-only) in a given environment.

## Adding a provider

The attribution pipeline (`attribution_record`, the read-joiner, rate cards, the
reconciliation engine) is provider-generic — it branches on a `tool`/source and
carries provider-specific operands (e.g. token counts vs credits) as first-class
fields. A new provider needs: an emission path (native OTel is ideal), an
identity join key (reuse `tokenscope.instance_id`), and — for §B — a usage/billing
API adapter. Contributions welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).
