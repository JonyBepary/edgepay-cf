-- ============================================================
-- 0008 — Android Key Attestation for Device Pairing
--
-- Adds hardware attestation metadata, verified boot status,
-- and hardware backing level (TEE/StrongBox) to op_paired_devices.
--
-- DDL Non-Restartability Note:
--   SQLite ALTER TABLE ADD COLUMN statements are not idempotent. If this
--   migration fails midway, re-running requires table recreation or
--   manual schema patching. For multi-column migrations in Phase 4+,
--   prefer the atomic create-copy-swap table replacement pattern.
-- ============================================================

ALTER TABLE op_paired_devices ADD COLUMN attestation_verified_at TEXT;
ALTER TABLE op_paired_devices ADD COLUMN attestation_method TEXT;
  -- 'android_key_attestation' | 'manual' | NULL (legacy)
ALTER TABLE op_paired_devices ADD COLUMN attestation_strong INTEGER NOT NULL DEFAULT 0;
ALTER TABLE op_paired_devices ADD COLUMN attestation_verified_boot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE op_paired_devices ADD COLUMN attestation_raw_json TEXT;
ALTER TABLE op_paired_devices ADD COLUMN device_os_version INTEGER;
ALTER TABLE op_paired_devices ADD COLUMN device_patch_level TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_attestation_verified
  ON op_paired_devices(attestation_verified_at);
