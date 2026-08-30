#!/usr/bin/env bash
# Bootstrap script — provisions all CF resources and applies schema.
# Run after `wrangler login` and after updating wrangler.jsonc with the
# IDs returned by the create commands below.

set -euo pipefail

echo "=== Provisioning Cloudflare resources ==="

# D1 database
echo "→ Creating D1 database 'edgepay-cf'..."
D1_OUT=$(npx wrangler d1 create edgepay-cf 2>&1 || true)
echo "$D1_OUT"
echo "→ Update wrangler.jsonc d1_databases database_id with the ID above"

# KV namespace
echo "→ Creating KV namespace 'KV'..."
KV_OUT=$(npx wrangler kv namespace create KV 2>&1 || true)
echo "$KV_OUT"
echo "→ Update wrangler.jsonc kv_namespaces id with the ID above"

KV_PREVIEW_OUT=$(npx wrangler kv namespace create KV --preview 2>&1 || true)
echo "$KV_PREVIEW_OUT"
echo "(preview KV namespace — optional, not used by the default config)"

# R2 bucket
echo "→ Creating R2 bucket 'edgepay-uploads'..."
npx wrangler r2 bucket create edgepay-uploads || true
npx wrangler r2 bucket create edgepay-uploads-preview || true

# Queues (requires Workers Paid plan)
echo "→ Creating Queues (requires Workers Paid plan $5/mo)..."
for q in webhook-out webhook-out-dlq email-out sms-parse; do
  npx wrangler queues create $q || true
done

echo ""
echo "=== Provisioning complete ==="
echo ""
echo "Next steps:"
echo "  1. Update wrangler.jsonc with the IDs printed above"
echo "  2. Set secrets: ./scripts/set-secrets.sh"
echo "  3. Apply schema: npm run db:migrate:local"
echo "  4. Seed database: npm run db:seed:local"
echo "  5. Run dev server: npm run dev"
