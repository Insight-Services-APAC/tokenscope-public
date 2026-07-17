# Architecture

A tour of how TokenScope turns emitted telemetry into attributed, reconciled,
budgeted spend. For the *why*, see [PRINCIPLES.md](PRINCIPLES.md).

## Stack

- **App** — a Nuxt 3 (Nitro) server + Vue UI (`app/`, `server/`, `shared/`).
- **Data** — PostgreSQL (schema + migrations in `drizzle/`), Redis for
  ephemeral state.
- **Telemetry sink** — Azure Log Analytics (OTLP ingestion via a Data Collection
  Endpoint/Rule). AI tools emit OpenTelemetry directly to the workspace.
- **Read path** — a KQL "read-joiner" worker queries Log Analytics and writes
  priced `attribution_record` rows.
- **Workers** — a registry of scheduled jobs (`server/workers/registry.ts`),
  driven by an external scheduler over an HMAC-signed internal endpoint.

## The attribution hierarchy

```
teammate ──< instance ──< session ──< (project claim)
                                         └─ attribution_record (one row per
                                            instance × session × event × token-type × model)
```

- **Teammate** — the human (an identity from your directory). Who incurred the
  spend.
- **Instance** — a device/enrolment, minted once by the provisioning tool and
  bound to the teammate. Identified on the wire by a `tokenscope.instance_id`
  resource attribute — **server-minted and unspoofable**. This is the join key.
- **Session** — one tool run / conversation. The provider's own session id is
  captured; there is no finer grain than a session.
- **Project** — what the spend bills to, resolved *per record* from an emitted
  project claim, **membership-gated** ("tag proposes, membership disposes").
  Untagged spend is assigned per-session after the fact.
- **Attribution record** — the priced unit of usage, one row per (instance,
  session, event, token-type, model), costed by a rate card.

## §A vs §B — the two lenses

TokenScope separates two questions that cost tools usually blur:

| | §A — Usage completeness | §B — Billing / chargeback |
|---|---|---|
| Question | "What did this person actually consume?" | "What do we cross-charge, to whom?" |
| Nature | Attribution (display) | Cost-of-record (money) |
| Grain | Per teammate/day (from the provider's usage truth) | The grain the provider *bills* |
| Rule | Must never read below the provider's own total | Chargeable-vs-not decided in exactly one place |

**§A mechanism.** For each (teammate, day): `unaccounted = provider daily total −
Σ captured OTel`. Any gap surfaces as a taggable "unaccounted usage" record in
the same needs-tagging flow as a session — so a developer's "my usage" always
equals the provider's truth, enrolled or not.

**§B mechanism.** Charge at the provider's billing grain: some providers bill
per-user (charge the teammate); others bill a **pooled** allowance per
(org, SKU) (charge the *cost-centre* the org maps to). Per-user overage on a
pooled bill is deliberately **not** invented as a charge — it's shown (§A), not
billed. One ledger, two lenses: *showback* (managers: all genuine usage +
projected cost) and *chargeback* (finance: the single place exemptions apply).

## Emission → attribution flow

```
AI tool (Claude Code / Copilot CLI)
  → OpenTelemetry (api_request token events)
    → Azure Log Analytics (OTLP ingestion, DCE/DCR)
      → read-joiner worker (KQL, joined on tokenscope.instance_id)
        → attribution_record (priced by rate card)
          → reporting scopes (my usage / regional / finance / cost-centre)

  ⟂ in parallel: provider usage/billing API → reconciliation → completeness (§A) + billed cost (§B)
```

Provider specifics (how each tool emits, the zero-touch provisioning, the native
vs forwarded OTel paths) are in [PROVIDERS.md](PROVIDERS.md).

## Roles & reporting scopes

Roles (`shared/auth/roles.ts`): `developer`, `manager`, `admin`,
`global-finops`, `platform-admin` — plus `finance`, retired and unassignable
(kept in the enum for historical data, excluded from role assignment; still
present as a demo persona). Region-scoped `admin` up to cross-region
`platform-admin`; `global-finops` ("Global finance") is the live cross-region
finance super-role; row-level security scopes data by region/org path. Reporting
scopes map to personas: developer "my usage", manager regional budget-burn,
Global-finance chargeback, cost-centre-owner P&L.

## Deploy topology

One Bicep graph (`infra/`), two orthogonal switches:

- **`enablePrivateNetworking`** — VNet + private endpoints on every data plane
  (Key Vault, Postgres, Redis, ACR, monitoring), internal ingress, private Log
  Analytics query.
- **`enableFrontDoor`** — Azure Front Door Standard + WAF in front of the
  container app.

See [DEPLOY-AZURE.md](DEPLOY-AZURE.md) and [CONFIGURATION.md](CONFIGURATION.md).
