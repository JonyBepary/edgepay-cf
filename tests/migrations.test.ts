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

const db = (env as unknown as { DB: D1Database }).DB;

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
});

