-- ============================================================
-- 0010 — Device policy enforcement modes and compliance telemetry
--
-- Adds an enforcement_mode to the per-merchant policy so
-- merchants can run in audit-only mode before opting into
-- blocking. Adds a daily compliance rollup table for
-- dashboards.
--
-- DDL Non-Restartability Note: see 0007/0008.
-- ============================================================

ALTER TABLE op_merchant_device_policies
  ADD COLUMN enforcement_mode TEXT NOT NULL DEFAULT 'audit'
    CHECK (enforcement_mode IN ('off', 'audit', 'enforce'));

CREATE INDEX IF NOT EXISTS idx_device_policies_mode
  ON op_merchant_device_policies(enforcement_mode);

CREATE TABLE IF NOT EXISTS op_device_policy_daily_stats (
  merchant_id       INTEGER NOT NULL,
  day               TEXT    NOT NULL,
  context           TEXT    NOT NULL CHECK (context IN ('pairing','sms','sms_batch')),
  required_tier     TEXT    NOT NULL,
  achieved_tier     TEXT    NOT NULL,
  compliant         INTEGER NOT NULL,
  evaluation_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, day, context, required_tier, achieved_tier, compliant)
);

CREATE INDEX IF NOT EXISTS idx_dpds_day
  ON op_device_policy_daily_stats(day);
