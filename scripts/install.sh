#!/usr/bin/env bash
# ============================================================
# EdgePay Self-Hosted Installer Bootstrapper
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JonyBepary/edgepay-cf/main/scripts/install.sh | bash
# ============================================================
set -euo pipefail

echo "============================================================"
echo "  EdgePay Self-Hosted Installer Bootstrapper"
echo "============================================================"
echo ""

# 1. Check prerequisites
echo "==> Checking prerequisites..."
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 22+ is required to run the EdgePay installer." >&2
  echo "Install Node.js: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js 22+ is required (detected $(node -v))." >&2
  exit 1
fi
echo "    ✓ Node.js $(node -v) detected"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required to run the EdgePay installer." >&2
  exit 1
fi
echo "    ✓ git $(git --version | awk '{print $3}') detected"
echo ""

# 2. Helper to launch the installer with TTY connected to Node
run_installer() {
  echo ""
  echo "==> Launching EdgePay installer..."
  if [ -t 1 ] && [ -r /dev/tty ]; then
    exec node packages/init/bin/edgepay-init.mjs "$@" < /dev/tty
  else
    exec node packages/init/bin/edgepay-init.mjs "$@"
  fi
}

# 3. Resolve project directory & handle unbuilt repositories
echo "==> Resolving workspace environment..."

# Case 1: Executed directly inside an edgepay-cf clone
if [ -f "package.json" ] && grep -q '"name": "edgepay-cf"' "package.json" 2>/dev/null && [ -d "packages/init" ]; then
  echo "    ✓ Running inside existing EdgePay repository: $(pwd)"
  if [ ! -f "packages/init/dist/index.js" ] || [ ! -d "node_modules" ]; then
    echo "==> Installing dependencies and compiling installer..."
    npm install --no-fund --no-audit
    npm run build:init
  fi
  run_installer "$@"
fi

# Case 2: Executed in parent directory where ./edgepay-cf already exists
if [ -d "edgepay-cf" ] && [ -f "edgepay-cf/package.json" ] && grep -q '"name": "edgepay-cf"' "edgepay-cf/package.json" 2>/dev/null && [ -d "edgepay-cf/packages/init" ]; then
  echo "    ✓ Found existing EdgePay clone in ./edgepay-cf. Entering directory..."
  cd edgepay-cf
  if [ ! -f "packages/init/dist/index.js" ] || [ ! -d "node_modules" ]; then
    echo "==> Installing dependencies and compiling installer..."
    npm install --no-fund --no-audit
    npm run build:init
  fi
  run_installer "$@"
fi

# Case 3: Current directory is non-empty and is NOT an edgepay-cf clone
if [ -n "$(ls -A . 2>/dev/null)" ]; then
  echo "" >&2
  echo "Error: current directory ($(pwd)) is not empty and is not an edgepay-cf clone." >&2
  echo "Either cd into an empty directory or clone edgepay-cf first:" >&2
  echo "  git clone https://github.com/JonyBepary/edgepay-cf.git && cd edgepay-cf" >&2
  exit 1
fi

# Case 4: Current directory is empty — clone and build
echo "    ✓ Current directory is empty. Cloning EdgePay repository..."
git clone https://github.com/JonyBepary/edgepay-cf.git .
echo "==> Installing dependencies and compiling installer..."
npm install --no-fund --no-audit
npm run build:init

run_installer "$@"
