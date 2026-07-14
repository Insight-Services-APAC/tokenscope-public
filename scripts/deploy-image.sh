#!/usr/bin/env bash
#
# deploy-image.sh — local image-roll to a TokenScope environment.
#
# A from-the-laptop substitute for the `.github/workflows/deploy.yml`
# workflow_dispatch (used while the GitHub→Azure OIDC CD path is not yet
# wired). Mirrors that workflow's build → push → roll → verify → rollback
# exactly, so behaviour matches once GH CD lands.
#
# NO DOCKER REQUIRED: the image builds inside ACR via `az acr build`
# (server-side). The only prerequisite is an authenticated Azure CLI:
#     az login            # interactive (device code / browser)
#     az account set --subscription "<VS Enterprise sub id or name>"
#
# Migrations: drizzle/migrate.ts runs on container boot (entrypoint.sh),
# idempotently (tracked in _drizzle_migrations) — so this image roll
# applies any new migrations (e.g. 0043/0044) automatically on start.
#
# SCOPE: image roll ONLY. It does NOT apply infra/Bicep changes (env vars,
# scaling, networking). A change like CORE-4's NUXT_SECURITY_RATE_LIMITER_IP_HEADER
# lives in infra/modules/container-app.bicep and needs an infra deploy
# (`.github/workflows/infra.yml`, or `az deployment group create
# --template-file infra/main.bicep --parameters infra/parameters/<env>.bicepparam
# ...` with the PG/Entra/Anthropic/session/HMAC secrets) — see that workflow
# for the full parameter surface.
#
# Usage:
#   scripts/deploy-image.sh [sandbox|staging|production] [tag]
#     env  — default: sandbox
#     tag  — default: short git SHA of HEAD
#   DEPLOY_YES=1 scripts/deploy-image.sh sandbox   # skip the confirm prompt
#
# Naming convention (from infra/main.bicep):
#   RG  = rg-tokenscope-{env}-aue
#   APP = ca-tokenscope-{env}-aue
#   ACR = crtokenscope{env}aue   (no hyphens — ACR rule)
#   IMG = tokenscope
set -euo pipefail

ENVIRONMENT="${1:-sandbox}"
TAG_INPUT="${2:-}"

case "$ENVIRONMENT" in
  sandbox|staging|production) ;;
  *) echo "::error:: invalid environment '$ENVIRONMENT' (sandbox|staging|production)"; exit 1 ;;
esac

# Resolve + validate the tag (charset-locked to match deploy.yml / avoid injection).
TAG="$TAG_INPUT"
if [ -z "$TAG" ]; then TAG="$(git rev-parse --short HEAD)"; fi
if ! printf '%s' "$TAG" | grep -Eq '^[a-zA-Z0-9._-]+$'; then
  echo "::error:: invalid tag '$TAG' (must match ^[a-zA-Z0-9._-]+\$)"; exit 1
fi

RG="rg-tokenscope-${ENVIRONMENT}-aue"
APP="ca-tokenscope-${ENVIRONMENT}-aue"
ACR="crtokenscope${ENVIRONMENT}aue"
IMG="tokenscope"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Preflight: authenticated az + the right subscription ──
if ! az account show >/dev/null 2>&1; then
  echo "Not logged in. Run:  az login   (then: az account set --subscription <sub>)" >&2
  exit 1
fi
SUB_NAME="$(az account show --query name -o tsv)"
SUB_ID="$(az account show --query id -o tsv)"

echo "──────────────────────────────────────────────────────────────"
echo " Deploy image  →  ${ENVIRONMENT}"
echo "   subscription : ${SUB_NAME} (${SUB_ID})"
echo "   resource grp : ${RG}"
echo "   container app: ${APP}"
echo "   registry     : ${ACR}.azurecr.io"
echo "   image        : ${IMG}:${TAG}  (+ :latest)"
echo "──────────────────────────────────────────────────────────────"

if [ "${DEPLOY_YES:-}" != "1" ]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "aborted."; exit 0 ;; esac
fi

# ── Capture the current healthy revision so a bad roll can be wound back ──
PREV_REVISION="$(az containerapp show --name "$APP" --resource-group "$RG" \
  --query "properties.latestReadyRevisionName" -o tsv 2>/dev/null || echo "")"
echo "Previous healthy revision: ${PREV_REVISION:-none (first deploy)}"

# ── Build + push inside ACR (no local docker needed) ──
echo "▶ az acr build (server-side)…"
az acr build --registry "$ACR" \
  --image "${IMG}:${TAG}" \
  --image "${IMG}:latest" \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}"

# ── Roll the container app to the new image ──
echo "▶ rolling ${APP} → ${IMG}:${TAG}…"
az containerapp update --name "$APP" --resource-group "$RG" \
  --image "${ACR}.azurecr.io/${IMG}:${TAG}" >/dev/null

# ── Verify health, rolling back on failure ──
FQDN="$(az containerapp show --name "$APP" --resource-group "$RG" \
  --query "properties.configuration.ingress.fqdn" -o tsv)"
echo "▶ verifying https://${FQDN}/api/health …"
ok=0
for i in 1 2 3 4 5; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${FQDN}/api/health" || true)"
  if [ "$code" = "200" ]; then echo "✓ health 200 (attempt ${i})"; ok=1; break; fi
  echo "  attempt ${i}: HTTP ${code} — retrying in 30s…"; sleep 30
done

if [ "$ok" != "1" ]; then
  echo "::error:: health check failed after 5 attempts" >&2
  if [ -n "$PREV_REVISION" ]; then
    echo "↩ rolling back to ${PREV_REVISION}…"
    CUR="$(az containerapp show --name "$APP" --resource-group "$RG" \
      --query "properties.latestRevisionName" -o tsv 2>/dev/null || echo "")"
    if [ -n "$CUR" ] && [ "$CUR" != "$PREV_REVISION" ]; then
      az containerapp revision deactivate --name "$APP" --resource-group "$RG" --revision "$CUR" || true
    fi
    az containerapp revision activate --name "$APP" --resource-group "$RG" --revision "$PREV_REVISION" || true
    echo "↩ rollback complete — previous revision reactivated"
  fi
  exit 1
fi

echo "✅ deployed: https://${FQDN}  (${IMG}:${TAG})"
