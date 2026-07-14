#!/usr/bin/env bash
#
# validate-deployment.sh — smoke check against a deployed TokenScope env.
#
# Used by the sandbox-validation-playbook (docs/development/
# sandbox-validation-playbook.md §1). Operator runs this AFTER infra.yml
# + deploy.yml complete, to verify the deployed surface end-to-end.
#
# Usage:
#   bash scripts/validate-deployment.sh <env>
#   where <env> is one of: sandbox, staging, production
#
# Exit code 0 = all checks pass. Non-zero = at least one failure; the
# offending check is the last line printed.

set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  sandbox|staging|production) ;;
  *) echo "Usage: $0 <sandbox|staging|production>"; exit 2 ;;
esac

RG="rg-tokenscope-${ENV_NAME}-aue"
APP="ca-tokenscope-${ENV_NAME}-aue"

echo "── TokenScope deployment validation: ${ENV_NAME} ──"
echo "  RG:  ${RG}"
echo "  CA:  ${APP}"
echo

# ── 1. Resource-group present ────────────────────────────────────────
echo "[1/8] Resource group present..."
if ! az group show -n "$RG" >/dev/null 2>&1; then
  echo "  FAIL: resource group $RG does not exist"
  exit 1
fi
echo "  ok"

# ── 2. Container app present + running ───────────────────────────────
echo "[2/8] Container app running..."
RUNNING=$(az containerapp show -n "$APP" -g "$RG" --query "properties.runningStatus" -o tsv 2>/dev/null || echo "MISSING")
if [ "$RUNNING" != "Running" ]; then
  echo "  FAIL: container app runningStatus=$RUNNING (expected Running)"
  exit 1
fi
echo "  ok"

# ── 3. Container app FQDN resolves ───────────────────────────────────
echo "[3/8] Container app FQDN..."
FQDN=$(az containerapp show -n "$APP" -g "$RG" --query "properties.configuration.ingress.fqdn" -o tsv)
if [ -z "$FQDN" ]; then
  echo "  FAIL: no FQDN reported"
  exit 1
fi
echo "  ok (https://$FQDN)"

# ── 4. Direct-to-CA enforcement check ────────────────────────────────
# Probe `/` (NOT `/api/health`) — the require-front-door middleware has
# `/api/health` on the bypass list (ACA's internal LB probes hit it
# directly without going through AFD; enforcing it would loop-restart
# replicas). `/` is not on the bypass list, so it's the right path to
# detect enforcement state:
#
#   200 → middleware in no-op mode (pre-phase-3; AZURE_FRONT_DOOR_ID empty)
#   302 → no-op mode + global auth redirect (still no-op detected)
#   403 → enforcement ON (post-phase-3; matches the phase-3 contract)
#
# /api/health is ALSO probed below to confirm the bypass list still
# works after phase 3 — both 200 (no-op) and 200 (enforcing-but-bypassed)
# look the same on that path, so it doesn't distinguish state.
echo "[4/8] Direct-to-CA enforcement check..."
HTTP_ROOT=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://${FQDN}/" || true)
HTTP_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://${FQDN}/api/health" || true)
if [ "$HTTP_HEALTH" != "200" ]; then
  echo "  FAIL: /api/health on direct-to-CA returned $HTTP_HEALTH (expected 200, bypass list)"
  exit 1
fi
case "$HTTP_ROOT" in
  200|302)
    echo "  ok (/ → $HTTP_ROOT; AFD enforcement OFF; /api/health bypass = 200)"
    AFD_ENFORCING="false"
    ;;
  403)
    echo "  ok (/ → 403; AFD enforcement ON; /api/health bypass = 200)"
    AFD_ENFORCING="true"
    ;;
  *)
    echo "  FAIL: / on direct-to-CA returned $HTTP_ROOT (expected 200, 302, or 403)"
    exit 1
    ;;
esac

# ── 5. AFD endpoint (Wave-II phase 2+) ───────────────────────────────
echo "[5/8] Front Door endpoint..."
AFD_FQDN=$(az afd endpoint list --profile-name "fd-tokenscope-${ENV_NAME}-aue" -g "$RG" --query "[0].hostName" -o tsv 2>/dev/null || true)
if [ -z "$AFD_FQDN" ]; then
  if [ "$AFD_ENFORCING" = "true" ]; then
    echo "  FAIL: middleware enforces but AFD endpoint not found"
    exit 1
  fi
  echo "  skipped (Wave-II phase 1; AFD not provisioned yet)"
else
  echo "  endpoint: https://$AFD_FQDN"
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "https://${AFD_FQDN}/api/health" || true)
  if [ "$HTTP" != "200" ]; then
    echo "  FAIL: AFD-fronted /api/health returned $HTTP (expected 200)"
    exit 1
  fi
  echo "  ok (200 via AFD)"
fi

# ── 6. Key Vault present + has expected secrets ──────────────────────
echo "[6/8] Key Vault secrets..."
KV_NAME=$(az keyvault list -g "$RG" --query "[0].name" -o tsv)
if [ -z "$KV_NAME" ]; then
  echo "  FAIL: no Key Vault found in $RG"
  exit 1
fi
REQUIRED_SECRETS=("database-url" "redis-url" "session-secret" "hmac-session-key" "internal-worker-hmac-key")
for s in "${REQUIRED_SECRETS[@]}"; do
  if ! az keyvault secret show --vault-name "$KV_NAME" --name "$s" >/dev/null 2>&1; then
    echo "  FAIL: required secret '$s' missing from $KV_NAME"
    exit 1
  fi
done
echo "  ok ($KV_NAME: ${#REQUIRED_SECRETS[@]} required secrets present)"

# ── 7. Postgres ready ────────────────────────────────────────────────
echo "[7/8] Postgres server..."
PG_STATE=$(az postgres flexible-server show -n "pg-tokenscope-${ENV_NAME}-aue" -g "$RG" --query "state" -o tsv 2>/dev/null || echo "MISSING")
if [ "$PG_STATE" != "Ready" ]; then
  echo "  FAIL: PG server state=$PG_STATE (expected Ready)"
  exit 1
fi
echo "  ok (state=Ready)"

# ── 8. ACR has the image ────────────────────────────────────────────
echo "[8/8] ACR has tokenscope:latest..."
ACR_NAME="crtokenscope${ENV_NAME}aue"
if ! az acr repository show --name "$ACR_NAME" --image "tokenscope:latest" >/dev/null 2>&1; then
  echo "  FAIL: $ACR_NAME has no tokenscope:latest image"
  exit 1
fi
echo "  ok"

echo
echo "── All 8 checks passed. Deployment looks healthy. ──"
echo "  Direct-to-CA URL: https://$FQDN"
[ -n "${AFD_FQDN:-}" ] && echo "  AFD URL:          https://$AFD_FQDN"
echo "  AFD enforcement:  $AFD_ENFORCING"
