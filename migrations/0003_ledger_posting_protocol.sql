-- ============================================================
-- 0003 — v0.2.1 Ledger posting protocol + reconciliation
--
-- Implements the reviewed architecture:
--   1. Per-tenant LedgerDO (one Durable Object per merchant) owns
--      ALL of that merchant's accounts. Posting is a single DO
--      call — no cross-DO fan-out, no atomicity gap.
--   2. Two-phase D1 write: op_ledger_postings is the write-ahead
--      log (pending -> posted), the replay queue for reconciliation,
--      and the tx_id dedup registry.
--   3. Per-merchant balance snapshots (DO alarms, not global crons).
--   4. Reconciliation run audit trail.
--   5. Data-driven per-gateway webhook IP allowlists.
--
-- Money inside the DO is stored as INTEGER minor units so SQL
-- SUM()/ORDER BY are numerically correct (TEXT aggregation is
-- lexically wrong). The D1 audit mirror keeps TEXT Money strings
-- for backward compatibility with existing reporting.
-- ============================================================

-- ------------------------------------------------------------
-- Write-ahead ledger postings (the posting protocol's D1 side)
-- ------------------------------------------------------------
CREATE TABLE op_ledger_postings (
  tx_id          TEXT PRIMARY KEY,          -- globally unique: 'm{merchant_id}:{kind}:{reference}'
  merchant_id    INTEGER NOT NULL,
  reference_type TEXT NOT NULL
    CHECK (reference_type IN ('payment','refund','fee','adjustment','transfer')),
  reference_id   TEXT,
  currency       TEXT NOT NULL,
  payload_json   TEXT NOT NULL,             -- canonical replay payload (verbatim)
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','posted','rejected')),
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  posted_at      TEXT
);
CREATE INDEX idx_postings_status   ON op_ledger_postings(status, created_at);
CREATE INDEX idx_postings_merchant ON op_ledger_postings(merchant_id, created_at);

-- ------------------------------------------------------------
-- Per-merchant balance snapshots — written by LedgerDO alarms
-- (per-merchant scheduled work without global cron fan-out)
-- ------------------------------------------------------------
CREATE TABLE op_ledger_balance_snapshots (
  merchant_id  INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  currency     TEXT NOT NULL,
  balance_minor INTEGER NOT NULL,
  as_of        TEXT NOT NULL,
  PRIMARY KEY (merchant_id, account_code, as_of)
);

-- ------------------------------------------------------------
-- Reconciliation run audit (hourly replay + daily sweep)
-- ------------------------------------------------------------
CREATE TABLE op_reconciliation_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at             TEXT NOT NULL,
  trigger            TEXT NOT NULL CHECK (trigger IN ('hourly','daily','manual')),
  pending_replayed   INTEGER NOT NULL DEFAULT 0,
  pending_healed     INTEGER NOT NULL DEFAULT 0,
  pending_rejected   INTEGER NOT NULL DEFAULT 0,
  pending_failed     INTEGER NOT NULL DEFAULT 0,
  pending_remaining  INTEGER NOT NULL DEFAULT 0,
  merchants_checked  INTEGER NOT NULL DEFAULT 0,
  drift_count        INTEGER NOT NULL DEFAULT 0,
  refunds_retriggered INTEGER NOT NULL DEFAULT 0,
  details_json       TEXT
);
CREATE INDEX idx_recon_runs_ran_at ON op_reconciliation_runs(ran_at);

-- ------------------------------------------------------------
-- Per-gateway webhook IP allowlists (data-driven: update without
-- redeploying; gateway IP ranges change often)
-- ------------------------------------------------------------
CREATE TABLE op_gateway_ips (
  gateway_slug TEXT NOT NULL,
  cidr         TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (gateway_slug, cidr)
);

-- ------------------------------------------------------------
-- Refund workflow bookkeeping (instance-per-refund + sweep)
-- ------------------------------------------------------------
ALTER TABLE op_refunds ADD COLUMN workflow_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE op_refunds ADD COLUMN last_workflow_at  TEXT;
