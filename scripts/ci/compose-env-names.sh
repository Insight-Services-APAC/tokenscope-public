#!/usr/bin/env bash
# compose-env-names.sh — single source of truth for environment → Azure
# resource names, shared by .github/workflows/infra.yml and deploy.yml.
# (Third sibling: main.bicep's regionShortMap, keyed by LOCATION there;
# keep the three in sync when adding an environment or region.)
#
# Inputs (env vars):
#   ENVIRONMENT   required — sandbox | dev | staging | production
#   RG_OVERRIDE   optional — overrides the resource-group name.
#                 HONORED FOR dev ONLY: dev's RG is IT-named (GBS
#                 standard) and may be renamed by IT; every other env
#                 derives its RG from our own convention, and silently
#                 retargeting those (e.g. via a repo-level var that the
#                 GH vars fallback chain leaks into all environments)
#                 has deployed full stacks into the wrong RG before it
#                 was guarded. Non-dev: warn + ignore.
#
# Output: KEY=VALUE lines appended to $GITHUB_ENV (or stdout when run
# locally without it), so workflow steps after this see the names.
set -euo pipefail

case "${ENVIRONMENT:-}" in
  sandbox|staging|production) REGION_SHORT="aue" ;;
  dev)                        REGION_SHORT="wus3" ;;
  *) echo "::error::Invalid environment: '${ENVIRONMENT:-}' (must be sandbox, dev, staging, or production)"; exit 1 ;;
esac

if [ "$ENVIRONMENT" = "dev" ]; then
  # IT-named RG (confirmed live in your-subscription, 2026-06-11).
  AZURE_RESOURCE_GROUP="${RG_OVERRIDE:-rg-tokenscope-example}"
else
  if [ -n "${RG_OVERRIDE:-}" ]; then
    echo "::warning::AZURE_RESOURCE_GROUP var ('${RG_OVERRIDE}') is only honored for environment=dev — ignoring it for ${ENVIRONMENT}."
  fi
  AZURE_RESOURCE_GROUP="rg-tokenscope-${ENVIRONMENT}-aue"
fi

OUT="${GITHUB_ENV:-/dev/stdout}"
{
  echo "ENVIRONMENT=${ENVIRONMENT}"
  echo "REGION_SHORT=${REGION_SHORT}"
  echo "AZURE_RESOURCE_GROUP=${AZURE_RESOURCE_GROUP}"
  # Child resources keep OUR naming scheme in every env (only the RG
  # follows the IT/GBS standard) — see main.bicep §Naming Convention.
  echo "CONTAINER_APP_NAME=ca-tokenscope-${ENVIRONMENT}-${REGION_SHORT}"
  echo "ACR_NAME=crtokenscope${ENVIRONMENT}${REGION_SHORT}"
  echo "IMAGE_NAME=tokenscope"
  echo "VNET_NAME_EXPECTED=$([ "$ENVIRONMENT" = "dev" ] && echo 'vnet-tokenscope-example' || echo "vnet-tokenscope-${ENVIRONMENT}-${REGION_SHORT}")"
} >> "$OUT"
echo "::notice::Names composed for ${ENVIRONMENT}: RG=${AZURE_RESOURCE_GROUP}, region=${REGION_SHORT}"
