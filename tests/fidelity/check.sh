#!/usr/bin/env bash
# Fidelity check — per docs/build/mvp-lite-epic.md §Epic 8 fidelity criteria.
#
# Criterion 1: no hardcoded hex in app/components/ or app/pages/ (every
#   colour must come from a --brand-* token or Tailwind utility class).
#   Allowlist: design intentionally-non-token colours (the small set of
#   RAG bg/text pairs that are non-brand tokens documented in styles.css).
#
# Criterion 4: reusable atoms do the work (grep app/pages/*.vue for the
#   class="card" pattern that would indicate inline duplication).
#
# Criteria 2 (Tailwind spacing scale) + 3 (layout-section order) are
# manual review against the design hi-fi.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

failed=0

echo "[fidelity] criterion 1: no raw hex literals in app/components/ + app/pages/..."
# Allow hex literals in:
#   - inline radial gradient backgrounds in the login hero (Hustle/Vision
#     wash) and AppHeader logo gradient — they reference brand tokens via
#     var(--brand-*) so the hex is the wrapping rgba()
#   - severity colour-bg pairs in inbox.vue + Pbar.vue + Badge.vue
#     (#DCFCE7/#166534/#FEF3C7/#92400E/#FEE2E2/#991B1B for rag-green/amber/red
#     pairs — design-notes documents these as TokenScope-defined since brand
#     doesn't carry RAG colours; #FBBF24 + #F87171 are the amber/red gradient
#     starts in Pbar)
ALLOWLIST_REGEX='#(?:DCFCE7|166534|FEF3C7|92400E|FEE2E2|991B1B|FBBF24|F87171|1f4ea3|0b7290|4a2161|b50848)'
# Match a #6-hex literal that does NOT appear inside an rgba() / var() context.
if grep -rEn '#[0-9a-fA-F]{6}\b' app/components app/pages 2>/dev/null \
   | grep -vE 'rgba|brand-|carbon|cloud|calm|paper|rag-' \
   | grep -viE "${ALLOWLIST_REGEX}" \
   > /tmp/fidelity-hex.txt
then
  if [ -s /tmp/fidelity-hex.txt ]; then
    echo "FAIL — raw hex literals found:"
    cat /tmp/fidelity-hex.txt
    failed=1
  fi
fi

echo "[fidelity] criterion 4: pages use atoms, not inline card class..."
# Pages should not render their own .card divs — must use <UiCard>.
if grep -rEn 'class="card[^a-z]' app/pages 2>/dev/null > /tmp/fidelity-cards.txt; then
  if [ -s /tmp/fidelity-cards.txt ]; then
    echo "FAIL — inline card class found in pages:"
    cat /tmp/fidelity-cards.txt
    failed=1
  fi
fi

if [ "$failed" -eq 0 ]; then
  echo "[fidelity] OK — criteria 1 + 4 pass (2 + 3 are manual)."
else
  exit 1
fi
