/**
 * Vitest configuration for Cloudflare Workers testing.
 *
 * v0.2.2 (audit P1): migrated from the legacy @cloudflare/vitest-pool-workers
 * `defineWorkersConfig({ poolOptions.workers })` API to the current
 * @cloudflare/vitest-plugin `cloudflareTest()` Vite plugin (per
 * https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/).
 *
 * The old `singleWorker: true, isolatedStorage: false` combo maps to Vitest's
 * native `maxWorkers: 1, isolate: false` (docs: "To make test files share the
 * same storage (for example, for integration tests that depend on shared
 * state), use --max-workers=1 --no-isolate"). Workflows require this: D1/DO
 * state must persist across test FILES. Tests isolate via unique merchant IDs
 * per file (910001+) and tx_id keys that embed the merchant id.
 *
 * Tests run INSIDE workerd with the real bindings from wrangler.jsonc — D1,
 * Durable Objects (the per-tenant LedgerDO), Workflows, Queues, KV,
 * Analytics Engine. D1 migrations are applied once per worker (see
 * tests/setup/migrations.ts).
 */

import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/migrations.ts'],
    // Replaces pool-workers singleWorker + isolatedStorage:false — all test
    // files share ONE workerd process and its storage.
    maxWorkers: 1,
    isolate: false,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        // v0.2.2 (audit P2): test value for the CORS allowlist — lets the
        // api-middleware tests exercise BOTH the allowed-origin path
        // (https://allowed.example) and the fail-closed path (everything
        // else). Production ships ALLOWED_ORIGINS="" (fail closed).
        bindings: {
          ALLOWED_ORIGINS: 'https://allowed.example',
        },
      },
    }),
  ],
});
