/**
 * D1 migration bootstrap for vitest-pool-workers (referenced by
 * vitest.config.ts setupFiles).
 *
 * Imports the migration SQL directly (vite `?raw`) and applies it to the
 * test D1 exactly once per worker. Setup files run once per test FILE, so
 * the op_ledger_postings marker table (created by 0003, the LAST migration)
 * guards against double application across files.
 */

import { beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import type { D1Database } from '../../src/types/env';
import m1 from '../../migrations/0001_initial_schema.sql?raw';
import m2 from '../../migrations/0002_cf_native_v2.sql?raw';
import m3 from '../../migrations/0003_ledger_posting_protocol.sql?raw';

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)                 // statement separator: ; at line end
    .map(s => s.replace(/^\s*--[^\n]*$/gm, '').trim()) // strip full-line comments
    .filter(s => s.length > 0);
}

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;

  const marker = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'op_ledger_postings'`,
    )
    .first<{ name: string }>();

  if (marker) return; // already migrated by an earlier test file

  const statements = [m1, m2, m3]
    .flatMap(sql => splitStatements(sql))
    .map(sql => db.prepare(sql));

  await db.batch(statements);
});
