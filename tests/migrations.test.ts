/**
 * Migration verification test suite.
 *
 * Verifies:
 *   1. Fresh & full migration suite (0001 -> 0006) applies cleanly.
 *   2. uq_ledger_entries_dedup index uses strictly (ledger_transaction_id, entry_order).
 *   3. 0001_initial_schema.sql does NOT define entry_order (avoiding duplicate column error).
 *   4. Simulated upgrade path from pre-0006 state (backfills entry_order = id and drops old index).
 *   5. Preserves identical split legs in double-entry transactions.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { D1Database } from '../src/types/env';
import m1 from '../migrations/0001_initial_schema.sql?raw';
import m6 from '../migrations/0006_outbox_protocol.sql?raw';
import m7 from '../migrations/0007_device_attestation_and_sms_hardening.sql?raw';
import m8 from '../migrations/0008_device_attestation.sql?raw';
import m9 from '../migrations/0009_merchant_device_policies.sql?raw';
import m10 from '../migrations/0010_device_policy_modes.sql?raw';
import m11 from '../migrations/0011_device_policy_overrides.sql?raw';
import m12 from '../migrations/0012_hierarchy.sql?raw';
import m13 from '../migrations/0013_hierarchy_columns.sql?raw';
import m14 from '../migrations/0014_hierarchy_backfill.sql?raw';
import m15 from '../migrations/0015_repair_orphan_hierarchy.sql?raw';

const db = (env as unknown as { DB: D1Database }).DB;

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map(s => s.replace(/^\s*--[^\n]*$/gm, '').trim())
    .filter(s => s.length > 0);
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe('D1 Migration Protocol (0001 -> 0006)', () => {
  it('verifies 0001 does NOT declare entry_order to prevent ALTER TABLE collision', () => {
    // Regex check ensuring 0001 does not include entry_order in op_ledger_entries
    const opLedgerEntriesBlock = m1.slice(
      m1.indexOf('CREATE TABLE op_ledger_entries'),
      m1.indexOf('CREATE INDEX idx_ledger_entries_account'),
    );
    expect(opLedgerEntriesBlock).not.toContain('entry_order');
  });

  it('verifies 0006 migration file defines correct sequence of alter, backfill, and index operations', () => {
    expect(m6).toContain('ALTER TABLE op_ledger_entries ADD COLUMN entry_order INTEGER NOT NULL DEFAULT 0;');
    expect(m6).toContain('UPDATE op_ledger_entries\nSET entry_order = id\nWHERE entry_order = 0;');
    expect(m6).toContain('DROP INDEX IF EXISTS uq_ledger_entries_dedup;');
    expect(m6).toContain('CREATE UNIQUE INDEX uq_ledger_entries_dedup\n  ON op_ledger_entries(ledger_transaction_id, entry_order);');

    // Verify DROP INDEX precedes CREATE UNIQUE INDEX
    const dropIdx = m6.indexOf('DROP INDEX IF EXISTS uq_ledger_entries_dedup;');
    const createIdx = m6.indexOf('CREATE UNIQUE INDEX uq_ledger_entries_dedup');
    expect(dropIdx).toBeGreaterThan(0);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it('verifies current schema has entry_order and outbox columns after 0006', async () => {
    const tableInfo = await db
      .prepare(`PRAGMA table_info(op_ledger_entries)`)
      .all<TableInfoRow>();

    const entryOrderCol = tableInfo.results.find(c => c.name === 'entry_order');
    expect(entryOrderCol).toBeDefined();
    expect(entryOrderCol?.type).toBe('INTEGER');
    expect(entryOrderCol?.notnull).toBe(1);

    const reconInfo = await db
      .prepare(`PRAGMA table_info(op_reconciliation_runs)`)
      .all<TableInfoRow>();

    expect(reconInfo.results.some(c => c.name === 'outbox_lag_max_seconds')).toBe(true);
    expect(reconInfo.results.some(c => c.name === 'outbox_pending_total')).toBe(true);
    expect(reconInfo.results.some(c => c.name === 'outbox_stuck_total')).toBe(true);
  });

  it('verifies uq_ledger_entries_dedup indexes strictly (ledger_transaction_id, entry_order)', async () => {
    const indexInfo = await db
      .prepare(`PRAGMA index_info(uq_ledger_entries_dedup)`)
      .all<IndexInfoRow>();

    expect(indexInfo.results).toHaveLength(2);
    expect(indexInfo.results[0].name).toBe('ledger_transaction_id');
    expect(indexInfo.results[0].seqno).toBe(0);
    expect(indexInfo.results[1].name).toBe('entry_order');
    expect(indexInfo.results[1].seqno).toBe(1);
  });

  it('simulates upgrade from pre-0006 D1 state with backfill and old index replacement', async () => {
    // 1. Create a simulated pre-0006 table matching 0001's original schema
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS test_sim_ledger_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        merchant_id INTEGER NOT NULL,
        ledger_transaction_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        amount TEXT NOT NULL,
        currency TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    // Create an old unique index if present in earlier schemas
    await db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sim_entries_old
        ON test_sim_ledger_entries(ledger_transaction_id, account_id, direction, amount)
    `).run();

    // Insert legacy rows with specific IDs
    await db.batch([
      db.prepare(`
        INSERT INTO test_sim_ledger_entries (id, merchant_id, ledger_transaction_id, account_id, direction, amount, currency)
        VALUES (101, 1, 5001, 10, 'debit', '50.00', 'BDT')
      `),
      db.prepare(`
        INSERT INTO test_sim_ledger_entries (id, merchant_id, ledger_transaction_id, account_id, direction, amount, currency)
        VALUES (102, 1, 5001, 20, 'credit', '50.00', 'BDT')
      `),
      db.prepare(`
        INSERT INTO test_sim_ledger_entries (id, merchant_id, ledger_transaction_id, account_id, direction, amount, currency)
        VALUES (205, 1, 5002, 10, 'debit', '100.00', 'BDT')
      `),
    ]);

    // 2. Apply 0006 migration statements adapted to the simulation table
    await db.prepare(`ALTER TABLE test_sim_ledger_entries ADD COLUMN entry_order INTEGER NOT NULL DEFAULT 0`).run();
    await db.prepare(`UPDATE test_sim_ledger_entries SET entry_order = id WHERE entry_order = 0`).run();
    await db.prepare(`DROP INDEX IF EXISTS uq_sim_entries_old`).run();
    await db.prepare(`CREATE UNIQUE INDEX uq_sim_entries_dedup ON test_sim_ledger_entries(ledger_transaction_id, entry_order)`).run();

    // Verify backfill assigned entry_order = id
    const rows = await db
      .prepare(`SELECT id, entry_order FROM test_sim_ledger_entries ORDER BY id ASC`)
      .all<{ id: number; entry_order: number }>();

    expect(rows.results).toEqual([
      { id: 101, entry_order: 101 },
      { id: 102, entry_order: 102 },
      { id: 205, entry_order: 205 },
    ]);

    // Verify that duplicate (ledger_transaction_id, entry_order) violates unique constraint
    let dupFailed = false;
    try {
      await db.prepare(`
        INSERT INTO test_sim_ledger_entries (merchant_id, ledger_transaction_id, account_id, direction, amount, currency, entry_order)
        VALUES (1, 5001, 30, 'debit', '25.00', 'BDT', 101)
      `).run();
    } catch {
      dupFailed = true;
    }
    expect(dupFailed).toBe(true);

    // Verify that IDENTICAL split legs (same account, direction, amount) with distinct entry_order SUCCEED
    await db.batch([
      db.prepare(`
        INSERT INTO test_sim_ledger_entries (merchant_id, ledger_transaction_id, account_id, direction, amount, currency, entry_order)
        VALUES (1, 6001, 10, 'debit', '100.00', 'BDT', 1)
      `),
      db.prepare(`
        INSERT INTO test_sim_ledger_entries (merchant_id, ledger_transaction_id, account_id, direction, amount, currency, entry_order)
        VALUES (1, 6001, 10, 'debit', '100.00', 'BDT', 2)
      `),
      db.prepare(`
        INSERT INTO test_sim_ledger_entries (merchant_id, ledger_transaction_id, account_id, direction, amount, currency, entry_order)
        VALUES (1, 6001, 20, 'credit', '200.00', 'BDT', 3)
      `),
    ]);

    const splitRows = await db
      .prepare(`SELECT account_id, direction, amount, entry_order FROM test_sim_ledger_entries WHERE ledger_transaction_id = 6001 ORDER BY entry_order ASC`)
      .all<{ account_id: number; direction: string; amount: string; entry_order: number }>();

    expect(splitRows.results).toHaveLength(3);
    expect(splitRows.results[0]).toEqual({ account_id: 10, direction: 'debit', amount: '100.00', entry_order: 1 });
    expect(splitRows.results[1]).toEqual({ account_id: 10, direction: 'debit', amount: '100.00', entry_order: 2 });
    expect(splitRows.results[2]).toEqual({ account_id: 20, direction: 'credit', amount: '200.00', entry_order: 3 });

    // Cleanup simulation table
    await db.prepare(`DROP TABLE test_sim_ledger_entries`).run();
  });

  it('verifies 0007 migration file defines device attestation, nonces, and SMS audit columns', () => {
    expect(m7).toContain('ALTER TABLE op_paired_devices ADD COLUMN public_key TEXT;');
    expect(m7).toContain('ALTER TABLE op_paired_devices ADD COLUMN key_algorithm TEXT DEFAULT \'ES256\';');
    expect(m7).toContain('CREATE TABLE IF NOT EXISTS op_device_nonces');
    expect(m7).toContain('CREATE INDEX IF NOT EXISTS idx_device_nonces_created');
    expect(m7).toContain('ALTER TABLE op_sms_data ADD COLUMN raw_sender TEXT;');
    expect(m7).toContain('ALTER TABLE op_sms_data ADD COLUMN signature_verified INTEGER NOT NULL DEFAULT 0;');
    expect(m7).toContain('ALTER TABLE op_sms_data ADD COLUMN device_id INTEGER;');
  });

  it('verifies current schema has 0007 columns, op_device_nonces table and index', async () => {
    const deviceCols = await db
      .prepare(`PRAGMA table_info(op_paired_devices)`)
      .all<TableInfoRow>();

    expect(deviceCols.results.some(c => c.name === 'public_key')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'key_algorithm')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'attestation_statement')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'revoked_at')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'revocation_reason')).toBe(true);

    const smsCols = await db
      .prepare(`PRAGMA table_info(op_sms_data)`)
      .all<TableInfoRow>();

    expect(smsCols.results.some(c => c.name === 'raw_sender')).toBe(true);
    expect(smsCols.results.some(c => c.name === 'signature_verified')).toBe(true);
    expect(smsCols.results.some(c => c.name === 'device_id')).toBe(true);

    const nonceCols = await db
      .prepare(`PRAGMA table_info(op_device_nonces)`)
      .all<TableInfoRow>();

    expect(nonceCols.results.some(c => c.name === 'device_id')).toBe(true);
    expect(nonceCols.results.some(c => c.name === 'nonce')).toBe(true);
    expect(nonceCols.results.some(c => c.name === 'created_at')).toBe(true);

    const nonceIndices = await db
      .prepare(`PRAGMA index_list(op_device_nonces)`)
      .all<{ name: string; unique: number }>();

    expect(nonceIndices.results.some(i => i.name === 'idx_device_nonces_created')).toBe(true);
  });

  it('verifies 0008 migration file defines Android Key Attestation columns and index', () => {
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN attestation_verified_at TEXT;');
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN attestation_method TEXT;');
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN attestation_strong INTEGER NOT NULL DEFAULT 0;');
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN attestation_verified_boot INTEGER NOT NULL DEFAULT 0;');
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN attestation_raw_json TEXT;');
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN device_os_version INTEGER;');
    expect(m8).toContain('ALTER TABLE op_paired_devices ADD COLUMN device_patch_level TEXT;');
    expect(m8).toContain('CREATE INDEX IF NOT EXISTS idx_devices_attestation_verified');
  });

  it('verifies current schema has 0008 attestation columns and index on op_paired_devices', async () => {
    const deviceCols = await db
      .prepare(`PRAGMA table_info(op_paired_devices)`)
      .all<TableInfoRow>();

    expect(deviceCols.results.some(c => c.name === 'attestation_verified_at')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'attestation_method')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'attestation_strong')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'attestation_verified_boot')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'attestation_raw_json')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'device_os_version')).toBe(true);
    expect(deviceCols.results.some(c => c.name === 'device_patch_level')).toBe(true);

    const deviceIndices = await db
      .prepare(`PRAGMA index_list(op_paired_devices)`)
      .all<{ name: string; unique: number }>();

    expect(deviceIndices.results.some(i => i.name === 'idx_devices_attestation_verified')).toBe(true);
  });

  it('verifies 0009 migration file defines op_merchant_device_policies table and index', () => {
    expect(m9).toContain('CREATE TABLE IF NOT EXISTS op_merchant_device_policies');
    expect(m9).toContain('min_tier          TEXT NOT NULL DEFAULT \'basic\'');
    expect(m9).toContain('min_patch_level   TEXT');
    expect(m9).toContain('strict_pairing    INTEGER NOT NULL DEFAULT 0');
    expect(m9).toContain('CREATE INDEX IF NOT EXISTS idx_device_policies_tier');
  });

  it('verifies current schema has op_merchant_device_policies table and index', async () => {
    const policyCols = await db
      .prepare(`PRAGMA table_info(op_merchant_device_policies)`)
      .all<TableInfoRow>();

    expect(policyCols.results.some(c => c.name === 'merchant_id')).toBe(true);
    expect(policyCols.results.some(c => c.name === 'min_tier')).toBe(true);
    expect(policyCols.results.some(c => c.name === 'min_patch_level')).toBe(true);
    expect(policyCols.results.some(c => c.name === 'strict_pairing')).toBe(true);
    expect(policyCols.results.some(c => c.name === 'updated_at')).toBe(true);
    expect(policyCols.results.some(c => c.name === 'updated_by')).toBe(true);

    const policyIndices = await db
      .prepare(`PRAGMA index_list(op_merchant_device_policies)`)
      .all<{ name: string; unique: number }>();

    expect(policyIndices.results.some(i => i.name === 'idx_device_policies_tier')).toBe(true);
  });

  it('verifies 0010 migration file defines enforcement_mode and daily stats table', () => {
    expect(m10).toContain("enforcement_mode TEXT NOT NULL DEFAULT 'audit'");
    expect(m10).toContain('CREATE TABLE IF NOT EXISTS op_device_policy_daily_stats');
    expect(m10).toContain('CREATE INDEX IF NOT EXISTS idx_device_policies_mode');
    expect(m10).toContain('CREATE INDEX IF NOT EXISTS idx_dpds_day');
  });

  it('verifies current schema has 0010 enforcement_mode column and op_device_policy_daily_stats table', async () => {
    const policyCols = await db
      .prepare(`PRAGMA table_info(op_merchant_device_policies)`)
      .all<TableInfoRow>();

    expect(policyCols.results.some(c => c.name === 'enforcement_mode')).toBe(true);

    const modeIndexInfo = await db
      .prepare(`PRAGMA index_info(idx_device_policies_mode)`)
      .all<IndexInfoRow>();

    expect(modeIndexInfo.results.some(c => c.name === 'enforcement_mode')).toBe(true);

    const statsCols = await db
      .prepare(`PRAGMA table_info(op_device_policy_daily_stats)`)
      .all<TableInfoRow>();

    expect(statsCols.results.some(c => c.name === 'merchant_id')).toBe(true);
    expect(statsCols.results.some(c => c.name === 'day')).toBe(true);
    expect(statsCols.results.some(c => c.name === 'context')).toBe(true);
    expect(statsCols.results.some(c => c.name === 'required_tier')).toBe(true);
    expect(statsCols.results.some(c => c.name === 'achieved_tier')).toBe(true);
    expect(statsCols.results.some(c => c.name === 'compliant')).toBe(true);
    expect(statsCols.results.some(c => c.name === 'evaluation_count')).toBe(true);
  });

  it('0011_device_policy_overrides.sql creates op_device_policy_overrides table and idx_overrides_active index', async () => {
    expect(m11).toContain('CREATE TABLE IF NOT EXISTS op_device_policy_overrides');
    expect(m11).toContain('idx_overrides_active');

    const cols = await db
      .prepare(`PRAGMA table_info(op_device_policy_overrides)`)
      .all<TableInfoRow>();
    const colNames = (cols.results ?? []).map((c) => c.name);
    const expectedCols = [
      'id',
      'merchant_id',
      'device_id',
      'authorized_by',
      'authorized_at',
      'reason',
      'acknowledged_tier',
      'required_tier',
      'expires_at',
      'revoked_at',
      'revoked_by',
      'revocation_reason',
    ];
    for (const col of expectedCols) {
      expect(colNames).toContain(col);
    }

    const idxInfo = await db
      .prepare(`PRAGMA index_info(idx_overrides_active)`)
      .all<IndexInfoRow>();
    const idxCols = (idxInfo.results ?? []).map((i) => i.name);
    expect(idxCols).toEqual(['merchant_id', 'device_id', 'expires_at']);
  });

  it('0012 creates op_brands, op_stores, op_gates and six indexes', async () => {
    expect(m12).toContain('CREATE TABLE IF NOT EXISTS op_brands');
    expect(m12).toContain('CREATE TABLE IF NOT EXISTS op_stores');
    expect(m12).toContain('CREATE TABLE IF NOT EXISTS op_gates');
    expect(m12).toContain('idx_brands_merchant');
    expect(m12).toContain('idx_stores_brand');
    expect(m12).toContain('idx_stores_merchant');
    expect(m12).toContain('idx_gates_store');
    expect(m12).toContain('idx_gates_merchant');
    expect(m12).toContain('idx_gates_mfs');

    const brandCols = await db.prepare(`PRAGMA table_info(op_brands)`).all<TableInfoRow>();
    const brandColNames = (brandCols.results ?? []).map(c => c.name);
    for (const col of ['id', 'merchant_id', 'uuid', 'name', 'slug', 'status', 'brand_color', 'support_email']) {
      expect(brandColNames).toContain(col);
    }

    const storeCols = await db.prepare(`PRAGMA table_info(op_stores)`).all<TableInfoRow>();
    const storeColNames = (storeCols.results ?? []).map(c => c.name);
    for (const col of ['id', 'brand_id', 'merchant_id', 'uuid', 'name', 'slug', 'timezone', 'default_currency', 'status']) {
      expect(storeColNames).toContain(col);
    }

    const gateCols = await db.prepare(`PRAGMA table_info(op_gates)`).all<TableInfoRow>();
    const gateColNames = (gateCols.results ?? []).map(c => c.name);
    for (const col of ['id', 'store_id', 'merchant_id', 'gateway_id', 'label', 'mfs_number', 'currency', 'status']) {
      expect(gateColNames).toContain(col);
    }

    const gateIndices = await db.prepare(`PRAGMA index_list(op_gates)`).all<{ name: string }>();
    const gateIndexNames = (gateIndices.results ?? []).map(i => i.name);
    expect(gateIndexNames).toContain('idx_gates_mfs');
    expect(gateIndexNames).toContain('idx_gates_store');
    expect(gateIndexNames).toContain('idx_gates_merchant');
  });

  it('0013 adds store_id to op_paired_devices, gate_id/store_id/brand_id to op_transactions and op_payment_intents', async () => {
    expect(m13).toContain('ALTER TABLE op_paired_devices   ADD COLUMN store_id INTEGER;');
    expect(m13).toContain('ALTER TABLE op_payment_intents  ADD COLUMN brand_id INTEGER;');
    expect(m13).toContain('ALTER TABLE op_payment_intents  ADD COLUMN store_id INTEGER;');
    expect(m13).toContain('ALTER TABLE op_payment_intents  ADD COLUMN gate_id  INTEGER;');
    expect(m13).toContain('ALTER TABLE op_transactions     ADD COLUMN brand_id INTEGER;');
    expect(m13).toContain('ALTER TABLE op_transactions     ADD COLUMN store_id INTEGER;');
    expect(m13).toContain('ALTER TABLE op_transactions     ADD COLUMN gate_id  INTEGER;');
    expect(m13).toContain('ALTER TABLE op_domains          ADD COLUMN brand_id INTEGER;');

    const deviceCols = await db.prepare(`PRAGMA table_info(op_paired_devices)`).all<TableInfoRow>();
    expect((deviceCols.results ?? []).some(c => c.name === 'store_id')).toBe(true);

    const intentCols = await db.prepare(`PRAGMA table_info(op_payment_intents)`).all<TableInfoRow>();
    const intentColNames = (intentCols.results ?? []).map(c => c.name);
    expect(intentColNames).toContain('brand_id');
    expect(intentColNames).toContain('store_id');
    expect(intentColNames).toContain('gate_id');

    const txCols = await db.prepare(`PRAGMA table_info(op_transactions)`).all<TableInfoRow>();
    const txColNames = (txCols.results ?? []).map(c => c.name);
    expect(txColNames).toContain('brand_id');
    expect(txColNames).toContain('store_id');
    expect(txColNames).toContain('gate_id');

    const domainCols = await db.prepare(`PRAGMA table_info(op_domains)`).all<TableInfoRow>();
    expect((domainCols.results ?? []).some(c => c.name === 'brand_id')).toBe(true);
  });

  it('0014 is idempotent — running it twice does not duplicate Main brands, Main stores, or gates', async () => {
    const testMerchantId = 810001;
    const now = Date.now();
    const uuid = `mig-m14-uuid-${now}`;
    const slug = `mig-m14-${now}`;
    const email = `mig-m14-${now}@example.com`;

    await db.prepare(
      `INSERT OR IGNORE INTO op_merchants (id, uuid, name, slug, email, default_currency, status)
       VALUES (?, ?, ?, ?, ?, 'BDT', 'active')`
    ).bind(testMerchantId, uuid, 'Migration Test Merchant', slug, email).run();

    const gatewaySlug = `gw-m14-${now}`;
    await db.prepare(
      `INSERT INTO op_gateways (merchant_id, slug, name, type, status)
       VALUES (?, ?, 'bKash Personal', 'manual', 'active')`
    ).bind(testMerchantId, gatewaySlug).run();

    const m14Stmts = splitStatements(m14);
    for (const stmt of m14Stmts) {
      await db.prepare(stmt).run();
    }

    const brandsCount1 = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(testMerchantId).first<{ count: number }>();
    const storesCount1 = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(testMerchantId).first<{ count: number }>();
    const gatesCount1 = await db.prepare(`SELECT count(*) as count FROM op_gates WHERE merchant_id = ?`).bind(testMerchantId).first<{ count: number }>();

    expect(brandsCount1?.count).toBe(1);
    expect(storesCount1?.count).toBe(1);
    expect(gatesCount1?.count).toBe(1);

    // Second run
    for (const stmt of m14Stmts) {
      await db.prepare(stmt).run();
    }

    const brandsCount2 = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(testMerchantId).first<{ count: number }>();
    const storesCount2 = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(testMerchantId).first<{ count: number }>();
    const gatesCount2 = await db.prepare(`SELECT count(*) as count FROM op_gates WHERE merchant_id = ?`).bind(testMerchantId).first<{ count: number }>();

    expect(brandsCount2?.count).toBe(1);
    expect(storesCount2?.count).toBe(1);
    expect(gatesCount2?.count).toBe(1);
  });

  it('0015 repairs orphan merchants by backfilling Main brand and Main store idempotently', async () => {
    const orphanMerchantId = 810002;
    const now = Date.now();
    const uuid = `mig-m15-orphan-${now}`;
    const slug = `mig-m15-orphan-${now}`;
    const email = `mig-m15-${now}@example.com`;

    // Seed an orphan merchant without brand or store
    await db.prepare(
      `INSERT OR IGNORE INTO op_merchants (id, uuid, name, slug, email, default_currency, status)
       VALUES (?, ?, ?, ?, ?, 'BDT', 'active')`
    ).bind(orphanMerchantId, uuid, 'Orphan Test Merchant', slug, email).run();

    // Verify merchant is an orphan
    const brandsBefore = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(orphanMerchantId).first<{ count: number }>();
    const storesBefore = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(orphanMerchantId).first<{ count: number }>();
    expect(brandsBefore?.count).toBe(0);
    expect(storesBefore?.count).toBe(0);

    // Apply migration 0015
    const m15Stmts = splitStatements(m15);
    for (const stmt of m15Stmts) {
      await db.prepare(stmt).run();
    }

    // Verify orphan merchant is repaired with Main brand and Main store
    const brand = await db.prepare(`SELECT * FROM op_brands WHERE merchant_id = ? AND slug = 'main'`).bind(orphanMerchantId).first<{ id: number; name: string; slug: string }>();
    const store = await db.prepare(`SELECT * FROM op_stores WHERE merchant_id = ? AND slug = 'main'`).bind(orphanMerchantId).first<{ id: number; name: string; slug: string; brand_id: number; default_currency: string }>();

    expect(brand).toBeDefined();
    expect(brand?.name).toBe('Main');
    expect(brand?.slug).toBe('main');

    expect(store).toBeDefined();
    expect(store?.name).toBe('Main');
    expect(store?.slug).toBe('main');
    expect(store?.brand_id).toBe(brand?.id);
    expect(store?.default_currency).toBe('BDT');

    // Idempotency: re-running 0015 does not duplicate brands or stores
    for (const stmt of m15Stmts) {
      await db.prepare(stmt).run();
    }

    const brandsAfter = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(orphanMerchantId).first<{ count: number }>();
    const storesAfter = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(orphanMerchantId).first<{ count: number }>();
    expect(brandsAfter?.count).toBe(1);
    expect(storesAfter?.count).toBe(1);
  });
});

