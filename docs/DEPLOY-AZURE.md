# Deploy to Azure

TokenScope runs as one container on **Azure Container Apps**. Bicep in `infra/`
provisions everything around it: PostgreSQL, Redis, Key Vault, Container
Registry, Log Analytics with the OTLP ingest endpoint, a user-assigned managed
identity, scheduled worker jobs, and optionally a VNet with private endpoints
and Front Door.

Pick a posture. Each has an example parameter file:

| | **Sandbox** | **VNet-integrated** (dev / production posture) |
|---|---|---|
| Parameters | `infra/parameters/example-sandbox.bicepparam` | `infra/parameters/example-vnetted.bicepparam` |
| Data plane | Public endpoints. Postgres admits any Azure-hosted client (the "Allow Azure services" rule) plus its password; Redis is public with its access key | Private endpoints on Key Vault, Postgres, Redis, ACR |
| App ingress | Public (optionally behind Front Door) | Internal only, behind your own WAF / proxy |
| You provide | An Azure subscription and an Entra app registration | That, plus address space, DNS, a public entry point and a build machine inside the network |
| Time to first sign-in | About an hour | A day or more, mostly network and DNS coordination |

Every apply command below is the same for both. The VNet section only adds
steps.

## 1. Prerequisites

### Tools

- Azure CLI 2.60+ with a current Bicep (`az bicep install` or `az bicep upgrade`), signed in with `az login`
- `openssl` (to generate secrets)
- VNet posture only: Docker, on a machine that can reach the private registry

### Azure

- A subscription and an empty resource group in the target region.
- **Owner** (or Contributor + User Access Administrator) on that resource group.
  The template assigns the app's managed identity its roles, which needs
  permission to create role assignments.
- These resource providers registered on the subscription:

  ```bash
  for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights \
            Microsoft.Monitor Microsoft.KeyVault Microsoft.ContainerRegistry \
            Microsoft.DBforPostgreSQL Microsoft.Cache Microsoft.ManagedIdentity \
            Microsoft.Network Microsoft.Cdn; do
    az provider register --namespace "$ns"
  done
  ```

  If your organisation will not register `Microsoft.Monitor`, set
  `deployAzureMonitorWorkspace = false` (nothing reads that workspace today).
  `Microsoft.Cdn` is only needed for Front Door.
- **Unique names.** Key Vault, Container Registry, Postgres and Redis names are
  derived from `projectName-env-region` and must be globally unique. Change
  `projectName` if the default is taken. Short region codes exist only for
  `australiaeast` and `westus3`; other regions use the full name, and the Key
  Vault name is truncated to 24 characters.

### Entra ID app registration

One app registration serves both sign-in and the directory lookups (people
picker, manager chain). Create it in **Entra ID → App registrations → New
registration**:

1. **Supported account types:** single tenant.
2. **Redirect URI:** leave empty for now. You add it once you know the app's
   public host (sandbox step 5, VNet step 7).
3. **Certificates & secrets:** create a client secret. Note its value; you
   pass it as `entraIdClientSecret`.
4. **API permissions** (Microsoft Graph):
   - Delegated: `openid`, `profile`, `email`, `offline_access`. `User.Read` is
     added by default; keep it.
   - Application: `User.Read.All`. The server calls Graph app-only with this
     registration's credentials to search users and read managers. Deployed
     environments always use real Graph, so this is not optional.
   - **Grant admin consent** for the tenant. `User.Read.All` requires it, and
     tenants that restrict user consent need it for the delegated scopes too.
     Without consent the deployment still works; what fails is visible:
     sign-in stops at Entra's "Need admin approval" page when users may not
     consent themselves, and without `User.Read.All` the people picker and
     manager lookups return errors. Developer enrolment, telemetry and
     reporting do not depend on it.
5. **Token configuration:** add the optional claim `email` to the ID token.
   Sign-in needs an email, and the bootstrap admin is matched on it.
6. Note the **Directory (tenant) ID** and **Application (client) ID**.

If "Assignment required" is on for the enterprise application, assign the
users or groups who should sign in. Conditional Access policies apply as for
any other web app. TokenScope has no Entra app roles: roles live in its own
database, and the first admin is bootstrapped by email (below).

Nothing needs registering for the developer plugins. The MCP and device OAuth
clients are created by the server itself.

### Secrets

Generate these once per environment, keep them in a gitignored file (the
repo ignores `*secrets.env`), and load the same file for every apply. Changing
them later signs everyone out or, for the Postgres password, rotates the
database login.

```bash
SECRETS=.azure-sandbox-secrets.env      # one file per environment
cat > "$SECRETS" <<EOF
PG_ADMIN_LOGIN='tsadmin'
PG_ADMIN_PASSWORD='$(openssl rand -base64 24)Aa1!'
SESSION_SECRET='$(openssl rand -base64 48)'
HMAC_SESSION_KEY='$(openssl rand -base64 48)'
INTERNAL_WORKER_HMAC_KEY='$(openssl rand -base64 48)'
OIDC_SESSION_SECRET='$(openssl rand -base64 36)'
OIDC_AUTH_SESSION_SECRET='$(openssl rand -base64 36)'
OIDC_TOKEN_KEY='$(openssl rand -base64 32)'
EOF
chmod 600 "$SECRETS"
```

Then add the client secret from the app registration to the file,
single-quoted: `ENTRA_CLIENT_SECRET='<value>'`.

The example parameter files read every secret from these environment
variables (`readEnvironmentVariable`), so secrets never appear on a command
line, and an apply without the file loaded stops with an error naming the
missing variable. Keep the file out of anything you share: `.gitignore` and
`.dockerignore` both exclude `*secrets.env`.

The session and HMAC keys must be at least 32 high-entropy characters; weaker
values make the app reject sign-ins and worker calls. The three `OIDC_*` values keep sign-in sessions valid
across restarts and replicas: without them every roll signs users out and
sign-in can loop.

### Optional provider credentials

Each is a variable in the same secrets file, read by the parameter file;
remove it from the file and the next apply unhooks it from the app.

- **Anthropic** (Claude spend reconciliation): an Admin API key or an
  Enterprise Analytics key. Add `ANTHROPIC_API_KEY='<key>'` to the secrets file
  and uncomment `anthropicApiEndpoint` in the parameter file. The app reads it
  under the credential name
  `insight`: use that name when you register the organisation under
  **Admin → Reconciliation**.
- **GitHub** (Copilot usage and billing): a classic PAT with
  `manage_billing:enterprise` and `read:org`, or a GitHub App private key
  (base64-encoded PEM). The template has fixed slots, each tied to the
  credential name you then use when registering the enterprise:

  | Secrets-file variable | Credential name |
  |---|---|
  | `GITHUB_PAT_PARTNER_DEMO` | `partner-demo` |
  | `GITHUB_PAT_PRODUCTION` | `production` |
  | `GITHUB_PAT_APAC_NFR` | `enterprise-nfr` |
  | `GITHUB_APP_KEY_PARTNER_DEMO` (App key) | `partner-demo` |

  Any other credential name needs a template change
  (`infra/modules/container-app.bicep`). See [PROVIDERS.md](PROVIDERS.md).

Both can be added later: add the value and apply again.

## 2. The apply command

Every step that says "apply" runs this (swap in the VNet parameter file for
that posture):

```bash
RG=<your-resource-group>
PARAMS=infra/parameters/my.bicepparam
SECRETS=./.azure-sandbox-secrets.env
set -a; . "$SECRETS"; set +a

az deployment group create --resource-group "$RG" \
  --template-file infra/main.bicep --parameters "$PARAMS"
```

Preview any apply with `az deployment group what-if` and the same arguments.

## 3. Sandbox

1. **Copy and edit the parameters.**

   ```bash
   cp infra/parameters/example-sandbox.bicepparam infra/parameters/my.bicepparam
   ```

   Set `location`, a unique `projectName`, `entraIdTenantId`,
   `entraIdClientId` and `bootstrapAdminEmail` (your own email; the first
   sign-in with it becomes `platform-admin`). Leave `entraIdRedirectUri`,
   `appPublicOrigin` and `workerBaseUrl` empty for now.

2. **First apply.** It creates every resource. The Container App is **expected
   to fail** with `MANIFEST_UNKNOWN`, because the new registry has no image
   yet. Every other resource succeeds.

3. **Build the image into the new registry.**

   ```bash
   ACR=$(az acr list -g "$RG" --query "[0].name" -o tsv)
   az acr build --registry "$ACR" --image tokenscope:latest \
     --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" --file Dockerfile .
   ```

   This builds in Azure (no local Docker). Never pass
   `NUXT_OIDC_AUTH_DEV_MODE` to a build: it disables real sign-in in the image.

4. **Apply again.** The Container App now provisions. Its public host is the
   `containerAppUrl` deployment output:

   ```bash
   az deployment group show -g "$RG" -n main \
     --query properties.outputs.containerAppUrl.value -o tsv
   ```

5. **Wire the public host, sign-in and the workers.** In `my.bicepparam` set:

   ```
   param appPublicOrigin = 'https://<containerAppUrl>'
   param entraIdRedirectUri = 'https://<containerAppUrl>/auth/entra/callback'
   param workerBaseUrl = 'https://<containerAppUrl>'
   ```

   `appPublicOrigin` is what the app puts in developer enrolments; without it
   (and without Front Door) it refuses to enrol devices.

   In the app registration, add two **Web** redirect URIs:
   `https://<containerAppUrl>/auth/entra/callback` and
   `https://<containerAppUrl>/login` (the post-logout page).

6. **Apply again.** The worker jobs are created and sign-in is live.

7. **Check it.** `curl https://<containerAppUrl>/api/health` returns 200. Sign
   in with the bootstrap email; you land as platform-admin.

### Optional: Front Door

Front Door (Standard + WAF) goes in front of the public app in three applies,
because each side needs the other's identity:

1. With `enableFrontDoor = false`: done above.
2. Set `enableFrontDoor = true` and apply. Note the `frontDoorEndpointFqdn` and
   `frontDoorInstanceId` outputs.
3. Set `frontDoorId = '<frontDoorInstanceId>'` and move the public host to Front
   Door: `appPublicOrigin`, `entraIdRedirectUri` and `workerBaseUrl` use
   `https://<frontDoorEndpointFqdn>`, and the two redirect URIs in Entra change
   to match. Devices enrolled before this point hold the old address; re-run
   setup on them. Apply. The app now
   rejects any request that did not come through Front Door (except
   `/api/health`), which is why the workers must call Front Door too.

## 4. VNet-integrated (dev / production posture)

This is the shape of the project's own Dev environment. The app, its jobs and
all data planes live in your VNet; nothing is reachable from the internet
except through the entry point you put in front of it.

### Additional prerequisites

- **Address space** from your IPAM: at least a /24 carved into a Container Apps
  subnet (/27 minimum), a private-endpoint subnet (/28) and, if you make Log
  Analytics query private, an AMPLS subnet (/28).
- **A public entry point you operate:** an Application Gateway, WAF or reverse
  proxy that can reach the VNet and forwards to the Container App's internal
  FQDN. This template's Front Door (Standard) cannot reach internal ingress, so
  it stays off. Decide the public hostname now (for example
  `tokenscope.example.com`) and set `appPublicOrigin` and `entraIdRedirectUri`
  to it.
- **DNS.** By default the template creates and links the privatelink zones for
  Key Vault, Postgres, Redis and ACR and registers every record. You must
  create one more zone yourself after the first apply (step 4). If a central
  team owns private DNS in a hub subscription, use the commented "central DNS"
  variant in the parameter file and give that team the record list.
- **A build machine inside the network.** The registry is private, so images
  are built with Docker on a machine (or CI runner) that resolves and reaches
  the ACR private endpoint. `az acr build` cannot push to it.

### Steps

1. **Copy and edit the parameters.**

   ```bash
   cp infra/parameters/example-vnetted.bicepparam infra/parameters/my.bicepparam
   ```

   Fill in `env`, `location`, `projectName`, the subnet prefixes,
   `appPublicOrigin`, `entraIdRedirectUri`, `entraIdTenantId`,
   `entraIdClientId` and `bootstrapAdminEmail`. Leave `workerBaseUrl` empty.
   Generate a separate secrets file for this environment and set `SECRETS` to
   it in the apply command.

2. **Register the redirect URIs now.** Your public hostname is already known:
   add `https://<public-host>/auth/entra/callback` and
   `https://<public-host>/login` as Web redirect URIs.

3. **First apply.** The VNet, private endpoints, zones and data planes are
   created. The Container App fails, as in the sandbox, because the registry
   is empty.

4. **Create the Container Apps environment DNS zone.** Internal ingress
   resolves only through a private zone named after the environment's default
   domain, which the template does not create:

   ```bash
   ENV_NAME=$(az containerapp env list -g "$RG" --query "[0].name" -o tsv)
   DOMAIN=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.defaultDomain -o tsv)
   IP=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.staticIp -o tsv)
   VNET=$(az network vnet list -g "$RG" --query "[0].id" -o tsv)
   az network private-dns zone create -g "$RG" -n "$DOMAIN"
   az network private-dns record-set a add-record -g "$RG" -z "$DOMAIN" -n '*' -a "$IP"
   az network private-dns record-set a add-record -g "$RG" -z "$DOMAIN" -n '@' -a "$IP"
   az network private-dns link vnet create -g "$RG" -z "$DOMAIN" -n app-vnet \
     -v "$VNET" -e false
   ```

   Also link this zone to the networks of your entry point and your build
   machine, and link `privatelink.azurecr.io` to the build machine's network.

5. **Build and push the image** from the build machine:

   ```bash
   ACR=$(az acr list -g "$RG" --query "[0].name" -o tsv)
   az acr login --name "$ACR"
   docker build --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" \
     -t "$ACR.azurecr.io/tokenscope:latest" .
   docker push "$ACR.azurecr.io/tokenscope:latest"
   ```

6. **Apply again.** The Container App provisions. Its internal host is the
   `containerAppUrl` output.

7. **Point the entry point and the workers at it.** Configure your WAF or proxy
   to forward `https://<public-host>` to `https://<containerAppUrl>`, sending
   the internal FQDN as the backend host header. In `my.bicepparam` set
   `workerBaseUrl = 'https://<containerAppUrl>'`: the worker jobs run inside
   the environment and usually cannot reach the public host. Apply again.

8. **Check it.** `https://<public-host>/api/health` returns 200 through your
   entry point, and the bootstrap email signs in as platform-admin.

**Private Log Analytics query** (`monitorQueryPrivateOnly`, off in the example)
routes the app's telemetry reads through an Azure Monitor Private Link Scope.
Before turning it on, create the `privatelink.monitor.azure.com`,
`privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com`
and `privatelink.blob.core.windows.net` zones with the AMPLS endpoint's
records. Turning it on without them cuts the app off from its own telemetry.

### Check that telemetry arrives

Once a developer has enrolled (next section) and run one Claude Code turn, the
rows appear in Log Analytics within a few minutes, and in the app after the next
`azure-monitor-read` run (every 5 minutes):

```bash
WS=$(az monitor log-analytics workspace list -g "$RG" --query "[0].customerId" -o tsv)
az monitor log-analytics query -w "$WS" -o table --analytics-query \
  "OTelLogs | where TimeGenerated > ago(1h)
   | project TimeGenerated, event=tostring(Attributes['event.name']),
             instance=tostring(ResourceAttributes['tokenscope.instance_id'])"
```

`az containerapp job execution list -g "$RG" -n caj-ts-azure-monitor-read`
shows the join job's runs.

## 5. After the first sign-in

- **Workers.** `workerBaseUrl` creates the scheduled jobs (Container Apps
  Jobs). They join telemetry every 5 minutes and roll up dashboards every 15.
  An empty value means dashboards stay at $0.
- **People.** New sign-ins are created as `developer`, unplaced, in the
  alphabetically first region. Place them into Business Units under **Admin**.
- **Developers.** Onboard Claude Code or Copilot CLI through the plugin: see
  [PROVIDERS.md](PROVIDERS.md). Telemetry goes from each device straight to the
  deployment's OTLP ingest endpoint; no collector runs anywhere.
- **Providers and settings:** [CONFIGURATION.md](CONFIGURATION.md).

### Deploying with GitHub Actions

The repository's workflows deploy the maintainers' own environment and are not
part of the public repository. To automate your deployment, wrap the commands in
this guide in your own pipeline: an OIDC federated credential for an identity
with Owner on the resource group, the secrets file's variables as pipeline
secrets exported into the apply step, `az acr build` (sandbox) or a runner inside
the network (VNet) for the image, and `az containerapp update` to roll it.

## 6. Shipping a new version

Build the new image under a unique tag **and** `latest`: the worker jobs, and
every re-apply, use `tokenscope:latest`. Then roll the app to the unique tag.

```bash
TAG=$(git rev-parse --short HEAD)
ACR=$(az acr list -g "$RG" --query "[0].name" -o tsv)

# Sandbox: build in Azure
az acr build --registry "$ACR" --image "tokenscope:$TAG" --image tokenscope:latest \
  --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" --file Dockerfile .

# VNet: build on the build machine instead
az acr login --name "$ACR"
docker build --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" \
  -t "$ACR.azurecr.io/tokenscope:$TAG" -t "$ACR.azurecr.io/tokenscope:latest" .
docker push "$ACR.azurecr.io/tokenscope:$TAG"
docker push "$ACR.azurecr.io/tokenscope:latest"

# Both: roll the app
APP=$(az containerapp list -g "$RG" --query "[0].name" -o tsv)
az containerapp update -g "$RG" -n "$APP" --image "$ACR.azurecr.io/tokenscope:$TAG"
```

On boot the container migrates the database and applies its idempotent seeds.
Re-run the apply command only when parameters or infrastructure change.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container App `Failed` with `MANIFEST_UNKNOWN` | No image in the registry yet. Build it, then apply again. |
| Revision fails pulling the image (401) or resolving secrets (403) | `deployRbac` is false, or the deploying identity cannot create role assignments. |
| Key Vault name conflict on a redeploy | A soft-deleted vault with that name exists. Set `keyVaultCreateMode = 'recover'`, or change `projectName`. |
| Sign-in redirects back to the login page, or signs out on every deploy | The `OIDC_*` secrets changed between applies, or `OIDC_TOKEN_KEY` is not base64 of 32 bytes. |
| Apply stops with `Environment variable "…" does not exist` | The secrets file was not loaded into this shell, or lacks that variable. |
| Developer enrolment fails with an error asking for `APP_PUBLIC_ORIGIN` | `appPublicOrigin` is empty on a deployment without Front Door. |
| Sign-in error about the redirect URI | The URI in `entraIdRedirectUri` is not registered on the app registration, or the `/login` one is missing. |
| People picker / manager lookups fail | `User.Read.All` (Application) is missing or not admin-consented. |
| Dashboards stay at $0 while developers are enrolled | `workerBaseUrl` is empty, or points at a host the jobs cannot reach. |
| VNet: the app FQDN does not resolve | The Container Apps environment zone (step 4) is missing or not linked to the querying network. |
