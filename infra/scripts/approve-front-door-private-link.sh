#!/usr/bin/env bash
# Wait for a running TokenScope deployment to finish, approving Azure Front
# Door Premium's Private Link request on the Container Apps environment when it
# appears.
#
# Front Door's origin does not finish provisioning until that request is
# approved, so approval has to happen WHILE the apply runs. Start the apply with
# --no-wait, then run this:
#
#   az deployment group create -g "$RG" --template-file infra/main.bicep \
#     --parameters "$PARAMS" --no-wait
#   infra/scripts/approve-front-door-private-link.sh "$RG"
#
# Exits 0 when the deployment succeeded, non-zero (with the error) when it did
# not. With Private Link it then waits for the Front Door endpoint to serve the
# app, and fails if it never does. A deployment without Front Door Premium on a
# VNet just waits. Front Door
# can file more than one request; every pending one carrying this deployment's
# request message is approved. Uses the Container Apps API: the generic
# `az network private-endpoint-connection` commands report a stale status for
# this resource type.
set -euo pipefail

RG="${1:?usage: $0 <resource-group> [deployment-name]}"
DEPLOYMENT="${2:-main}"
API=2025-07-01
TIMEOUT_MIN=90

# Deployment state; empty while it does not exist yet. Any other CLI error
# (expired login, throttling, missing permission) is shown, not swallowed.
state() {
  local out
  if out=$(az deployment group show -g "$RG" -n "$DEPLOYMENT" --query properties.provisioningState -o tsv 2>&1); then
    printf '%s' "$out"
  elif printf '%s' "$out" | grep -q 'DeploymentNotFound'; then
    printf ''
  else
    echo "az error reading deployment $DEPLOYMENT: $out" >&2
    printf 'Error'
  fi
}
param() { az deployment group show -g "$RG" -n "$DEPLOYMENT" --query "properties.parameters.$1.value" -o tsv 2>/dev/null || true; }

# The deployment exists moments after `create --no-wait` returns.
for _ in $(seq 1 30); do s0=$(state); [ -n "$s0" ] && [ "$s0" != Error ] && break; sleep 5; done
[ -n "$s0" ] && [ "$s0" != Error ] || { echo "Deployment '$DEPLOYMENT' not readable in $RG" >&2; exit 1; }

PRIVATE_LINK=0
if [ "$(param enableFrontDoor)" = "true" ] && [ "$(param frontDoorSku)" = "Premium" ] \
   && [ "$(param enablePrivateNetworking)" = "true" ]; then
  PRIVATE_LINK=1
  echo "Front Door Premium over Private Link: approving its request when it appears."
fi

# Re-approve every approved connection carrying our message. Idempotent; a new
# endpoint has been seen to keep answering 404 until the connection was
# approved again.
reapprove() {
  local name
  while read -r name; do
    [ -n "$name" ] || continue
    az rest --method put \
      --url "https://management.azure.com$ENV_ID/privateEndpointConnections/$name?api-version=$API" \
      --body "{\"properties\":{\"privateLinkServiceConnectionState\":{\"status\":\"Approved\",\"description\":\"$MESSAGE\",\"actionsRequired\":\"None\"}}}" \
      -o none || true
  done < <(az rest --method get \
    --url "https://management.azure.com$ENV_ID/privateEndpointConnections?api-version=$API" \
    --query "value[?properties.privateLinkServiceConnectionState.description=='$MESSAGE'].name" -o tsv 2>/dev/null || true)
}

# Front Door answers its own 404 until the new configuration reaches its edge.
# Wait for the app to answer through it; fail if it has not after 30 minutes.
wait_for_endpoint() {
  local host code i
  host=$(az deployment group show -g "$RG" -n "$DEPLOYMENT" \
    --query properties.outputs.frontDoorEndpointFqdn.value -o tsv 2>/dev/null || true)
  [ -n "$host" ] || return 0
  reapprove
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "https://$host/api/health" || true)
    if [ "$code" = "200" ]; then echo "Front Door serves the app: https://$host"; return 0; fi
    [ $((i % 10)) -eq 0 ] && reapprove
    echo "Front Door endpoint: HTTP ${code:-none}; waiting for it to start routing..."
    sleep 30
  done
  echo "https://$host/api/health still does not answer 200 after 30 minutes: the deployment succeeded but Front Door is not serving the app. Check the route and origin, then run this script again." >&2
  return 1
}

approved=0
errors=0
sent=" "   # requests already approved; the listing can lag an approval by minutes
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
while :; do
  if [ "$PRIVATE_LINK" = 1 ]; then
    # The template's profile is fd-<project>-<env>-<region>; other Front Door
    # or CDN profiles in the group are ignored.
    PROFILE=$(az resource list -g "$RG" --resource-type Microsoft.Cdn/profiles --query "[?starts_with(name, 'fd-')] | [0].name" -o tsv 2>/dev/null || true)
    ENV_ID=$(az resource list -g "$RG" --resource-type Microsoft.App/managedEnvironments --query "[0].id" -o tsv 2>/dev/null || true)
    if [ -n "$PROFILE" ] && [ -n "$ENV_ID" ]; then
      MESSAGE="TokenScope Front Door $PROFILE"
      while IFS=$'\t' read -r name status; do
        [ -n "$name" ] || continue
        if [ "$status" = "Pending" ] && [[ "$sent" != *" $name "* ]]; then
          # Retried on the next poll if Azure refuses it transiently (409/429).
          if az rest --method put \
            --url "https://management.azure.com$ENV_ID/privateEndpointConnections/$name?api-version=$API" \
            --body "{\"properties\":{\"privateLinkServiceConnectionState\":{\"status\":\"Approved\",\"description\":\"$MESSAGE\",\"actionsRequired\":\"None\"}}}" \
            -o none; then
            echo "Approved Front Door's private endpoint request $name"
            sent="$sent$name "
          else
            echo "Approving $name failed; retrying on the next poll" >&2
          fi
        fi
        [ "$status" = "Approved" ] && approved=1
      done < <(az rest --method get \
        --url "https://management.azure.com$ENV_ID/privateEndpointConnections?api-version=$API" \
        --query "value[?properties.privateLinkServiceConnectionState.description=='$MESSAGE'].[name, properties.privateLinkServiceConnectionState.status]" \
        -o tsv 2>/dev/null || true)
    fi
  fi

  s=$(state)
  case "$s" in
    Succeeded)
      if [ "$PRIVATE_LINK" = 1 ] && [ "$approved" = 0 ]; then
        echo "Deployment succeeded but no approved Front Door Private Link was found" >&2; exit 1
      fi
      echo "Deployment $DEPLOYMENT succeeded."
      if [ "$PRIVATE_LINK" = 1 ]; then wait_for_endpoint || exit 1; fi
      exit 0 ;;
    Error)
      errors=$((errors + 1))
      [ "$errors" -lt 10 ] || { echo "Giving up after repeated errors reading the deployment" >&2; exit 1; } ;;
    Failed|Canceled)
      echo "Deployment $DEPLOYMENT $s:" >&2
      az deployment group show -g "$RG" -n "$DEPLOYMENT" --query properties.error -o json >&2 || true
      exit 1 ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "Timed out waiting for deployment $DEPLOYMENT" >&2; exit 1; }
  sleep 20
done
