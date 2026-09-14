#!/usr/bin/env bash
# ============================================================
# EdgePay Self-Hosted Installer Bootstrapper
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JonyBepary/edgepay-cf/main/scripts/install.sh | bash
# ============================================================
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required to run the EdgePay installer." >&2
  echo "Install Node.js: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (detected $(node -v))." >&2
  exit 1
fi

exec npx --yes @edgepay/init@latest "$@"
