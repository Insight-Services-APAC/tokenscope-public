# Deploy to Azure

TokenScope ships as a container to **Azure Container Apps**, with everything
else (Postgres, Redis, Key Vault, Log Analytics + OTLP ingestion, ACR, and
optionally VNet/private endpoints and Front Door) provisioned by **Bicep** in
`infra/`. One graph, two orthogonal switches — you pick the posture per
environment.

## The two switches

| Switch | Off | On |
|---|---|---|
| **`enablePrivateNetworking`** | Public data plane, RBAC-only (fast sandbox). | Full VNet: private endpoints on Key Vault / Postgres / Redis / ACR / monitoring, **internal** container-app ingress, private Log Analytics query. |
| **`enableFrontDoor`** | Direct container-app ingress. | Azure Front Door Standard + WAF in front, with `X-Azure-FDID` header enforcement so direct-to-origin requests are rejected. |

They are independent. The two common combinations ship as example parameter
files:

- **Sandbox** (`infra/parameters/example-sandbox.bicepparam`) — public
  networking, Front Door optional. Fast to stand up for a pilot.
- **Fully VNet-integrated** (`infra/parameters/example-vnetted.bicepparam`) —
  private endpoints throughout; front your own ingress (central WAF or Front
  Door).

Copy one, fill in your values, deploy.

## What gets provisioned (`infra/modules/`)

| Module | Provisions |
|---|---|
| `monitoring` | Log Analytics + App Insights + Azure Monitor Workspace, alert rules, **the OTLP ingest DCE/DCR**, MI RBAC (Metrics Publisher on the DCR, Reader on the LAW), optional AMPLS + private query. |
| `networking` | VNet, container-apps + private-endpoints subnets, private DNS zones. *Only when `enablePrivateNetworking`.* |
| `key-vault` + `keyvault-secrets` | Key Vault (RBAC, purge-protection) and the secret set (DB/Redis URLs built in-module, session/HMAC/OIDC/provider secrets — each behind an if-guard). |
| `container-registry` | ACR (Premium + PE when private, else Standard/Basic; pull via MI). |
| `postgresql` | PostgreSQL Flexible Server (`btree_gist`, `ltree`, `pgcrypto` allow-listed). |
| `redis` | Azure Cache for Redis. |
| `container-app` | The Container Apps environment + app, all env wiring, KV-ref secrets, ingress. |
| `front-door` | Front Door Standard + WAF. *Only when `enableFrontDoor`.* |
| `worker-jobs` | Container Apps Jobs (schedule-triggered) that drive the worker endpoint. *Only when `workerBaseUrl` is set.* |

The root also creates a **user-assigned managed identity** (used for ACR pull,
Key Vault, and Azure Monitor ingest/query) and its role assignments.

## Prerequisites

- An Azure subscription + resource group, and permission to create the above.
- The image published to a registry (or let the pipeline build to the ACR the
  Bicep creates).
- Secrets ready to pass at apply-time (never in the params file): `pgAdminLogin`,
  `pgAdminPassword`, `sessionSecret`, `hmacSessionKey`, `internalWorkerHmacKey`,
  and — for real sign-in — the Entra OIDC values.

## Deploy

```bash
# 1. Pick and edit a parameters file.
cp infra/parameters/example-sandbox.bicepparam infra/parameters/my.bicepparam
$EDITOR infra/parameters/my.bicepparam

# 2. Deploy (secrets passed at apply-time, not in the file).
az deployment group create \
  --resource-group <your-rg> \
  --template-file infra/main.bicep \
  --parameters infra/parameters/my.bicepparam \
  --parameters pgAdminPassword=<...> sessionSecret=<...> hmacSessionKey=<...> \
               internalWorkerHmacKey=<...>
```

`entrypoint.sh` migrates the database and runs idempotent seeds on boot.

## Front Door: the three-phase apply

Because the container-app FQDN and the Front Door id must be known to each other,
Front Door is applied in three passes (documented in `infra/main.bicep`):

1. `enableFrontDoor=false`, `frontDoorId=''` — the container app provisions;
   capture its FQDN.
2. `enableFrontDoor=true` — Front Door provisions against that origin; capture
   the Front Door instance id output.
3. Re-apply also passing `frontDoorId=<value>` — the app revision picks up
   `AZURE_FRONT_DOOR_ID` and the `require-front-door` middleware begins rejecting
   direct-to-origin traffic.

## After deploy

- Schedule the workers (see [CONFIGURATION.md](CONFIGURATION.md#workers--scheduler));
  the Container Apps Jobs from `worker-jobs` do this if `workerBaseUrl` is set.
- Onboard a developer (Claude Code or Copilot CLI) via the plugin — see
  [PROVIDERS.md](PROVIDERS.md).
- Configure providers + directory placement as needed
  ([CONFIGURATION.md](CONFIGURATION.md)).
