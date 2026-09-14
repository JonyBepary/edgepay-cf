#!/usr/bin/env bash
# ============================================================
# EdgePay Self-Hosted Installer Bootstrapper Forwarder
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JonyBepary/edgepay-cf/main/scripts/install.sh | bash
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/install.sh" ]; then
  exec "${SCRIPT_DIR}/install.sh" "$@"
else
  exec npx --yes @edgepay/init@latest "$@"
fi
