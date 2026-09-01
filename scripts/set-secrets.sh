#!/usr/bin/env bash
# Set required secrets for the Worker.
# Run this once per environment (dev/staging/prod).

set -euo pipefail

ENV="${1:-}"

if [[ -n "$ENV" ]]; then
  ENV_ARGS=(--env "$ENV")
else
  ENV_ARGS=()
fi

echo "Setting secrets (input each value, or generate with openssl rand -hex 32)..."

JWT_SECRET=$(openssl rand -hex 32)
APP_KEY=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)

echo "→ Setting JWT_SECRET..."
echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET "${ENV_ARGS[@]}"

echo "→ Setting APP_KEY..."
echo "$APP_KEY" | npx wrangler secret put APP_KEY "${ENV_ARGS[@]}"

echo "→ Setting ENCRYPTION_KEY..."
echo "$ENCRYPTION_KEY" | npx wrangler secret put ENCRYPTION_KEY "${ENV_ARGS[@]}"

echo ""
echo "=== Secrets configured ==="
echo "Secrets have been set (values not echoed for security)."
echo ""
echo "⚠️  Save these values securely. They are NOT retrievable from Cloudflare after setting."
