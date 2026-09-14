-- ============================================================
-- 0009 — Per-merchant device trust policy
--
-- Non-restartability: this migration uses CREATE TABLE only.
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS op_merchant_device_policies (
  merchant_id       INTEGER PRIMARY KEY,
  min_tier          TEXT NOT NULL DEFAULT 'basic'
                    CHECK (min_tier IN ('basic','attested','strongbox')),
  min_patch_level   TEXT,                    -- 'YYYY-MM' or NULL
  strict_pairing    INTEGER NOT NULL DEFAULT 0,  -- 1 = reject pairing if tier insufficient
  updated_at        TEXT NOT NULL,
  updated_by        INTEGER,
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_policies_tier
  ON op_merchant_device_policies(min_tier);
