-- ============================================================
-- 0006 — Transactional Outbox: DO becomes source of truth
--
-- Previously the DO wrote a D1 write-ahead row ('pending') on the
-- hot path, then committed locally, then wrote D1 audit
-- ('posted'). That coupling stalls the DO's single-threaded input
-- gate on every posting and makes D1 availability a payment-
-- confirmation blocker.
--
-- New protocol:
--   * The DO commits journal + balances + outbox_events in one
--     transactionSync() — no network RPC on the hot path.
--   * A DO alarm drains the outbox to D1 with exponential backoff.
--   * D1 is an async audit / read model. The DO SQLite is the
--     authoritative source.
--
-- Consequences for D1:
--   * op_ledger_postings is no longer written 'pending' from the
--     hot path. The drain writes only 'posted'. The 'pending' state
--     remains valid for legacy rows written before this migration.
--   * The 'rejected' poison guard moves to reconciliation (see
--     reconciliation-sweep.ts): if a DO posted_transaction exists
--     for a tx_id whose D1 row is 'rejected', page.
--
-- Reconciliation lag: outbox drain is eventual. The sweep must
-- ignore DO<->D1 gaps younger than OUTBOX_MAX_LAG (5 min). The new
-- columns below record the observed lag so on-call can see it.
-- ============================================================

ALTER TABLE op_reconciliation_runs ADD COLUMN outbox_lag_max_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE op_reconciliation_runs ADD COLUMN outbox_pending_total  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE op_reconciliation_runs ADD COLUMN outbox_stuck_total    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_postings_posted_at
  ON op_ledger_postings(posted_at);

ALTER TABLE op_ledger_entries ADD COLUMN entry_order INTEGER NOT NULL DEFAULT 0;

-- Backfill pre-existing rows with id sequence.
-- Note: Pre-entry_order rows are backfilled with id; original ordering is unrecoverable.
UPDATE op_ledger_entries
SET entry_order = id
WHERE entry_order = 0;

DROP INDEX IF EXISTS uq_ledger_entries_dedup;

CREATE UNIQUE INDEX uq_ledger_entries_dedup
  ON op_ledger_entries(ledger_transaction_id, entry_order);
