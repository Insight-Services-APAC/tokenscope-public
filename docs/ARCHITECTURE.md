# Architecture

A tour of how TokenScope turns emitted telemetry into attributed, reconciled,
budgeted spend. For the *why*, see [PRINCIPLES.md](PRINCIPLES.md).

## Stack

- **App** — a Nuxt 4 (Nitro) server + Vue UI (`app/`, `server/`, `shared/`).
- **Data** — PostgreSQL (schema + migrations in `drizzle/`), Redis for
  ephemeral state.
- **Telemetry sink** — Azure Log Analytics. Devices send OTLP directly to an Azure
  Monitor Data Collection Endpoint (DCE), whose Data Collection Rule (DCR) routes
  it into the workspace; there is no collector in between. Claude Code sends its
  native `api_request` log events; the Copilot plugin's usage extension turns
  Copilot's `assistant.usage` events into the same shape of OTLP log records.
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
(org, SKU) (charge the *Business Unit* the org maps to). Per-user overage on a
pooled bill is deliberately **not** invented as a charge — it's shown (§A), not
billed. One ledger, two lenses: *showback* (managers: all genuine usage +
projected cost) and *chargeback* (finance: the single place exemptions apply).

## Emission → attribution flow

```
AI tool (Claude Code native events / Copilot usage extension)
  → OTLP log records (api_request token events), sent directly by the device
    → Azure Monitor DCE/DCR → Log Analytics
      → read-joiner worker (KQL, joined on tokenscope.instance_id)
        → attribution_record (priced by rate card)
          → reporting scopes (my usage / regional / finance / Business Unit)

  ⟂ in parallel: provider usage/billing API → reconciliation → completeness (§A) + billed cost (§B)
```

Provider specifics (how each tool emits and the zero-touch provisioning) are in
[PROVIDERS.md](PROVIDERS.md).

## Roles & reporting scopes

Roles (`shared/auth/roles.ts`): four assignable — `developer`, `manager`,
`admin`, `platform-admin` — plus TWO retired, unassignable enum members,
`finance` and `global-finops`, kept only so historical rows still render a label
(both excluded from `SELECTABLE_ROLES`). Region-scoped `admin` up to cross-region
`platform-admin`, which is the only org-wide role. Scoping by region/org path is
enforced IN THE APPLICATION, by the scope predicates on each query — not by
row-level security, whose policies do not execute under the owner connection the
app uses (`docs/wiki/Security-Overview.md`). RLS is defence in depth
that is currently dormant, so reading it as the boundary would credit a control
that is not running. Reporting reach is no longer a role: the company-wide finance
lens is a per-teammate `report_access_grant`, which is what allowed
`global-finops` to be retired. Reporting scopes map to personas: developer "my
usage", manager regional budget-burn, granted-finance chargeback,
Business Unit owner P&L.

## Deploy topology

One Bicep graph (`infra/`), two switches:

- **`enablePrivateNetworking`** — VNet, private endpoints on Key Vault, Postgres,
  Redis and ACR, internal ingress on the Container Apps environment, private
  registry. Making the Log Analytics **query** path private as well is a separate
  opt-in, `monitorQueryPrivateOnly`; ingestion stays public either way. By
  default it also splits the platform's own logs into a portal-readable ops
  workspace (`separateOpsWorkspace`).
- **`enableFrontDoor`** + **`frontDoorSku`** — Azure Front Door with a WAF in front
  of the app. `Standard` fronts a public app (the sandbox posture). `Premium`
  reaches an internal (VNet) environment over Private Link and adds the managed
  WAF rule sets; it is the recommended production setup. The template refuses
  `Standard` together with `enablePrivateNetworking`. Without Front Door, put your
  own WAF or application gateway in front of the internal app.

See [DEPLOY-AZURE.md](DEPLOY-AZURE.md) and [CONFIGURATION.md](CONFIGURATION.md).
