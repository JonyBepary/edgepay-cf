-- ============================================================
-- 0011 — Device-level policy overrides
--
-- A merchant admin can explicitly authorize an existing device
-- to bypass the tier requirement (min_tier) when the device
-- cannot meet policy (e.g., legacy handset, custom ROM).
--
-- The override bypasses ONLY the tier gate. It never bypasses:
--   - hardware signature verification
--   - nonce replay protection
--   - timestamp freshness
--   - carrier shortcode validation
--   - SIGNATURE_REQUIRED enforcement
--
-- Overrides are expiring (max 90 days), attributable (person-level
-- accountability), reasoned (free text), and revocable.
--
-- DDL Non-Restartability Note: see 0007/0008.
-- ============================================================

CREATE TABLE IF NOT EXISTS op_device_policy_overrides (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id       INTEGER NOT NULL,
  device_id         INTEGER NOT NULL,
  authorized_by     INTEGER NOT NULL,
  authorized_at     TEXT NOT NULL,
  reason            TEXT NOT NULL,
  acknowledged_tier TEXT NOT NULL,
  required_tier     TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  revoked_by        INTEGER,
  revocation_reason TEXT,
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES op_paired_devices(id) ON DELETE CASCADE,
  FOREIGN KEY (authorized_by) REFERENCES op_merchant_users(id)
);

-- Partial index: only active overrides matter on the hot path.
CREATE INDEX IF NOT EXISTS idx_overrides_active
  ON op_device_policy_overrides(merchant_id, device_id, expires_at)
  WHERE revoked_at IS NULL;
