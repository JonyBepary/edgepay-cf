-- ============================================================
-- 0013 — Hierarchy FK columns on existing tables
--
-- Adds nullable foreign key columns. Nullability is intentional:
-- existing rows are backfilled in 0014, and enforcing NOT NULL
-- is deferred until Phase 6b when all writes populate them.
--
-- No REFERENCES clauses are added here because SQLite does not
-- support adding FK constraints via ALTER TABLE. Referential
-- integrity for these columns is enforced at the application
-- layer until a future table-recreation migration.
--
-- DDL Non-Restartability Note: see 0007/0008.
-- ============================================================

ALTER TABLE op_paired_devices   ADD COLUMN store_id INTEGER;
ALTER TABLE op_payment_intents  ADD COLUMN brand_id INTEGER;
ALTER TABLE op_payment_intents  ADD COLUMN store_id INTEGER;
ALTER TABLE op_payment_intents  ADD COLUMN gate_id  INTEGER;
ALTER TABLE op_transactions     ADD COLUMN brand_id INTEGER;
ALTER TABLE op_transactions     ADD COLUMN store_id INTEGER;
ALTER TABLE op_transactions     ADD COLUMN gate_id  INTEGER;
ALTER TABLE op_domains          ADD COLUMN brand_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_devices_store
  ON op_paired_devices(store_id) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_store
  ON op_payment_intents(store_id) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_gate
  ON op_payment_intents(gate_id) WHERE gate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_store
  ON op_transactions(store_id) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_gate
  ON op_transactions(gate_id) WHERE gate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_domains_brand
  ON op_domains(brand_id) WHERE brand_id IS NOT NULL;
