#!/usr/bin/env bash
# Full gateway-port pipeline: analyze -> catalog -> generate -> clean -> fix -> repair -> finalize.
# Usage: bash scripts/port-gateways/build-all.sh [plugin_repo_dir]
set -euo pipefail
REPO="${1:-/home/z/my-project/edgepay-gateway-plugin}"
cd "$(dirname "$0")/../.."
python3 scripts/port-gateways/analyze.py "$REPO" scripts/port-gateways/analysis.json scripts/port-gateways/analysis-report.txt > /dev/null
python3 scripts/port-gateways/build-catalog.py scripts/port-gateways/analysis.json src/gateways/catalog.data.ts 0.3.0
rm -rf src/gateways/generated
python3 scripts/port-gateways/generate.py scripts/port-gateways/analysis.json "$REPO" src/gateways/generated
python3 scripts/port-gateways/cleanup.py
# fixer/repair converge; finalize bakes the recurring surgical fixes
for i in 1 2 3 4; do
  python3 scripts/port-gateways/fix-ts.py > /dev/null 2>&1 || true
  python3 scripts/port-gateways/repair.py > /dev/null 2>&1 || true
done
python3 scripts/port-gateways/finalize.py > /dev/null 2>&1 || true
for i in 1 2; do
  python3 scripts/port-gateways/fix-ts.py > /dev/null 2>&1 || true
done
echo "pipeline complete"
