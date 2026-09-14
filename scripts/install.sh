#!/usr/bin/env bash
# ============================================================
# EdgePay Self-Hosted Installer Bootstrapper
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JonyBepary/edgepay-cf/main/scripts/install.sh | bash
# ============================================================
set -euo pipefail

# 1. Reconnect stdin to TTY only if stdout is a terminal (interactive human session)
# and non-interactive flags (--yes, --help, etc.) are not passed
IS_INTERACTIVE=true
for arg in "$@"; do
  if [ "$arg" = "--yes" ] || [ "$arg" = "-y" ] || [ "$arg" = "--help" ] || [ "$arg" = "-h" ] || [ "$arg" = "--version" ] || [ "$arg" = "-v" ]; then
    IS_INTERACTIVE=false
    break
  fi
done

if [ "$IS_INTERACTIVE" = true ] && [ ! -t 0 ] && [ -t 1 ] && [ -r /dev/tty ]; then
  exec < /dev/tty
fi

# 2. Check prerequisites
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

# 3. Resolve project directory & handle unbuilt repositories
# Case 1: Executed directly inside an edgepay-cf clone
if [ -f "package.json" ] && grep -q '"name": "edgepay-cf"' "package.json" 2>/dev/null && [ -d "packages/init" ]; then
  if [ ! -f "packages/init/dist/index.js" ] || [ ! -d "node_modules" ]; then
    echo "Building installer..."
    npm install
    npm run build:init
  fi
  exec node packages/init/bin/edgepay-init.mjs "$@"
fi

# Case 2: Executed in parent directory where ./edgepay-cf already exists
if [ -d "edgepay-cf" ] && [ -f "edgepay-cf/package.json" ] && grep -q '"name": "edgepay-cf"' "edgepay-cf/package.json" 2>/dev/null && [ -d "edgepay-cf/packages/init" ]; then
  echo "Found EdgePay clone in ./edgepay-cf, entering directory..."
  cd edgepay-cf
  if [ ! -f "packages/init/dist/index.js" ] || [ ! -d "node_modules" ]; then
    echo "Building installer..."
    npm install
    npm run build:init
  fi
  exec node packages/init/bin/edgepay-init.mjs "$@"
fi

# Case 3: Current directory is non-empty and is NOT an edgepay-cf clone
if [ -n "$(ls -A . 2>/dev/null)" ]; then
  echo "Error: current directory is not empty and is not an edgepay-cf clone." >&2
  echo "Either cd into an empty directory or clone edgepay-cf first:" >&2
  echo "  git clone https://github.com/JonyBepary/edgepay-cf.git && cd edgepay-cf" >&2
  exit 1
fi

# Case 4: Current directory is empty — clone and build
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required to clone EdgePay repository." >&2
  exit 1
fi

echo "Cloning EdgePay repository..."
git clone https://github.com/JonyBepary/edgepay-cf.git .
echo "Installing dependencies..."
npm install
echo "Building installer..."
npm run build:init

exec node packages/init/bin/edgepay-init.mjs "$@"
