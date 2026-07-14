#!/usr/bin/env bash
# it-dev-handoff.sh — render the IT network-team handoff report for the
# dev environment as markdown on stdout. Called by infra.yml after every
# dev apply (even failed ones — the FIRST apply is EXPECTED to fail at
# the container-app step, and the report is the go-signal that lets IT
# unblock the next one). Runnable locally against the real RG by anyone
# with read access, which is also how it gets tested.
#
# Reads LIVE state, never deployment outputs (outputs vanish on a failed
# apply). Three rules learned the hard way:
#   1. Never swallow an az failure into "resource not there yet" — a
#      broken query stalls the IT loop a full round-trip. Failures are
#      rendered as loud ⚠ QUERY FAILED sections.
#   2. Never `[0]` an unfiltered list in an IT-governed RG — filter by
#      the expected resource name.
#   3. Spell out zone + record NAME for every A record. The ACR data
#      endpoint (<acr>.<region>.data.azurecr.io) is the classic trap:
#      it has no zone of its own — it is a multi-label record INSIDE
#      privatelink.azurecr.io. Mis-filed, docker push fails mid-upload.
#
# Inputs (env vars):
#   AZURE_RESOURCE_GROUP   required — the dev RG
#   VNET_NAME_EXPECTED     optional — default vnet-tokenscope-example
#   ACA_ENV_NAME_EXPECTED  optional — default cae-tokenscope-dev-wus3
set -uo pipefail

RG="${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
VNET_EXPECTED="${VNET_NAME_EXPECTED:-vnet-tokenscope-example}"
ACA_EXPECTED="${ACA_ENV_NAME_EXPECTED:-cae-tokenscope-dev-wus3}"

# az containerapp is extension-delivered; make non-interactive installs
# deterministic instead of relying on the runner image's defaults.
az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors 2>/dev/null || true

QUERY_ERRORS=()

# run_az <var-name> <fallback> -- <az args...>
# Success → stdout into var. Genuine failure → fallback into var AND the
# error recorded for the ⚠ section — never silent. A *NotFound* error is
# legitimate absence (e.g. ACA env before the second apply), not a
# failure: fallback, no error recorded.
run_az() {
  local __var="$1" __fallback="$2"; shift 2; [ "$1" = "--" ] && shift
  local out errfile err
  errfile=$(mktemp)
  if out=$(az "$@" 2>"$errfile"); then
    printf -v "$__var" '%s' "$out"
  else
    err=$(head -c 300 "$errfile")
    # Resource-level NotFound = legitimate absence (e.g. the ACA env
    # before the second apply). Scope-level NotFound (RG/subscription)
    # is a GENUINE failure — wrong RG name / wrong subscription would
    # otherwise render as "not provisioned yet" and stall the IT loop.
    if grep -qiE "ResourceGroupNotFound|SubscriptionNotFound" "$errfile" \
       || ! grep -qiE "NotFound|could not be found|does not exist" "$errfile"; then
      QUERY_ERRORS+=("\`az $1 $2 …\` failed: ${err}")
    fi
    printf -v "$__var" '%s' "$__fallback"
  fi
  rm -f "$errfile"
}

run_az VNET_FOUND "" -- network vnet list -g "$RG" --query "[?name=='${VNET_EXPECTED}'] | [0].name" -o tsv --only-show-errors
run_az VNET_ALL "" -- network vnet list -g "$RG" --query "[].name" -o tsv --only-show-errors
run_az PE_RECORDS "[]" -- network private-endpoint list -g "$RG" --query "[].customDnsConfigs[].{fqdn:fqdn, ip:ipAddresses[0]}" -o json --only-show-errors
run_az ACA_ENV "null" -- containerapp env show -g "$RG" -n "$ACA_EXPECTED" --query "{domain:properties.defaultDomain, ip:properties.staticIp}" -o json --only-show-errors

ACA_DOMAIN=$(echo "$ACA_ENV" | jq -r '.domain // empty' 2>/dev/null || echo "")
ACA_IP=$(echo "$ACA_ENV" | jq -r '.ip // empty' 2>/dev/null || echo "")
PE_COUNT=$(echo "$PE_RECORDS" | jq 'length' 2>/dev/null || echo 0)

# Map a public FQDN to (central privatelink zone, record name). The
# record name is the FQDN minus the zone's public suffix — multi-label
# for the ACR data endpoint.
zone_and_record() {
  local fqdn="$1"
  case "$fqdn" in
    *.vault.azure.net)              echo "privatelink.vaultcore.azure.net|${fqdn%.vault.azure.net}" ;;
    *.postgres.database.azure.com)  echo "privatelink.postgres.database.azure.com|${fqdn%.postgres.database.azure.com}" ;;
    *.redis.cache.windows.net)      echo "privatelink.redis.cache.windows.net|${fqdn%.redis.cache.windows.net}" ;;
    *.azurecr.io)                   echo "privatelink.azurecr.io|${fqdn%.azurecr.io}" ;;
    *)                              echo "UNKNOWN — match by suffix|$fqdn" ;;
  esac
}

echo "## IT network-team handoff (send to Tricia)"
echo
echo "RG: \`$RG\` · generated from live state $(date -u +%Y-%m-%dT%H:%MZ 2>/dev/null || true)"
echo

if [ ${#QUERY_ERRORS[@]} -gt 0 ]; then
  echo "### ⚠ QUERY FAILURES — report is INCOMPLETE, do not send until resolved"
  echo
  for e in "${QUERY_ERRORS[@]}"; do echo "- $e"; done
  echo
fi

echo "### 1. VNet — create hub peerings + link the four central privatelink zones to it"
echo
if [ -n "$VNET_FOUND" ]; then
  echo "- **VNet:** \`${VNET_FOUND}\`"
elif [ -n "$VNET_ALL" ]; then
  echo "- ⚠ Expected VNet \`${VNET_EXPECTED}\` NOT found. VNets present in the RG: $(echo "$VNET_ALL" | tr '\n' ' ')— check the deploy log before sending."
else
  echo "- ⚠ No VNet found in the RG — check the deploy log."
fi
echo "- Please ALSO link \`privatelink.azurecr.io\` to the **enterprise GitHub runner's network** (ubuntu-latest-azureuswest3-4core) — image push happens from the runner and must resolve the ACR private endpoint."
echo

echo "### 2. A records to create in the central privatelink zones (your-subscription / rg-hub-network-example)"
echo
if [ "$PE_COUNT" -gt 0 ]; then
  echo "| Zone | Record name | IP | (resolves) |"
  echo "|---|---|---|---|"
  echo "$PE_RECORDS" | jq -r '.[] | "\(.fqdn)\t\(.ip)"' | while IFS=$'\t' read -r fqdn ip; do
    zr=$(zone_and_record "$fqdn"); zone="${zr%%|*}"; rec="${zr##*|}"
    echo "| \`$zone\` | \`$rec\` | \`$ip\` | $fqdn |"
  done
  echo
  echo "> Note the ACR **data endpoint** row (record \`crtokenscopeexample.westus3.data\`): it is a multi-label record INSIDE \`privatelink.azurecr.io\`, not a separate zone. Both ACR records are needed or \`docker push\` fails mid-upload."
else
  echo "_No private endpoints found${QUERY_ERRORS:+ (see query failures above)} — check the deploy log._"
fi
echo

echo "### 3. ACA-env private DNS zone — create in the same central RG, with records + VNet links"
echo
if [ -n "$ACA_DOMAIN" ]; then
  echo "- **Zone to create:** \`${ACA_DOMAIN}\`"
  echo "- **Records:** \`*\` and \`@\` → A \`${ACA_IP}\` (TTL 300)"
  echo "- **VNet links:** the app VNet above AND the enterprise runner network (deploys health-check the internal FQDN from the runner)."
elif [ ${#QUERY_ERRORS[@]} -gt 0 ]; then
  echo "_ACA environment state unknown — resolve the query failures above first._"
else
  echo "_ACA environment not provisioned yet — EXPECTED on the first apply. Re-run infra.yml after IT wires section 1+2; this section will then populate._"
fi
