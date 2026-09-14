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
  echo "Error: Node.js 20+ is required to run the EdgePay installer." >&2
  echo "Install Node.js: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (detected $(node -v))." >&2
  exit 1
fi

# 3. Resolve project directory
# If executed inside an edgepay-cf clone, use current directory.
# Otherwise, clone the repository.
if [ -f "package.json" ] && grep -q '"name": "edgepay-cf"' "package.json" 2>/dev/null && [ -d "packages/init" ]; then
  REPO_DIR="$(pwd)"
else
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: git is required to clone EdgePay repository." >&2
    exit 1
  fi
  REPO_DIR="edgepay-cf"
  if [ ! -d "$REPO_DIR" ]; then
    echo "Cloning EdgePay repository..."
    git clone https://github.com/JonyBepary/edgepay-cf.git "$REPO_DIR"
  fi
  cd "$REPO_DIR"
fi

# 4. Ensure dependencies and installer build are present
if [ ! -d "node_modules" ] || [ ! -d "packages/init/node_modules" ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

if [ ! -d "packages/init/dist" ] || [ ! -f "packages/init/dist/index.js" ]; then
  echo "Building installer..."
  npm --prefix packages/init run build --silent
fi

# 5. Launch the installer
exec node packages/init/bin/edgepay-init.mjs "$@"
