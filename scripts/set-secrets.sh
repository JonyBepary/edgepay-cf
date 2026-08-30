#!/usr/bin/env bash
# Set required secrets for the Worker.
# Run this once per environment (dev/staging/prod).

set -euo pipefail

ENV="${1:-}"

if [[ -n "$ENV" ]]; then
  ENV_FLAG="--env $ENV"
else
  ENV_FLAG=""
fi

echo "Setting secrets (input each value, or generate with openssl rand -hex 32)..."

JWT_SECRET=$(openssl rand -hex 32)
APP_KEY=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)

echo "→ Setting JWT_SECRET..."
echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET $ENV_FLAG

echo "→ Setting APP_KEY..."
echo "$APP_KEY" | npx wrangler secret put APP_KEY $ENV_FLAG

echo "→ Setting ENCRYPTION_KEY..."
echo "$ENCRYPTION_KEY" | npx wrangler secret put ENCRYPTION_KEY $ENV_FLAG

echo ""
echo "=== Secrets configured ==="
echo "JWT_SECRET:        $JWT_SECRET"
echo "APP_KEY:           $APP_KEY"
echo "ENCRYPTION_KEY:    $ENCRYPTION_KEY"
echo ""
echo "⚠️  Save these values securely. They are NOT retrievable from Cloudflare after setting."
