-- ============================================================
-- 0007 — Device Attestation, Per-Device Public Keys & SMS Trust Hardening
--
-- Adds hardware-backed per-device signing keys, Play Integrity
-- attestation storage, and nonce replay protection.
--
-- DDL Non-Restartability Note:
--   SQLite ALTER TABLE ADD COLUMN statements are not idempotent. If this
--   migration fails midway, re-running requires table recreation or
--   manual schema patching. For multi-column migrations in Phase 4+,
--   prefer the atomic create-copy-swap table replacement pattern.
-- ============================================================

-- 1. Extend paired devices with public keys and revocation metadata
ALTER TABLE op_paired_devices ADD COLUMN public_key TEXT;
ALTER TABLE op_paired_devices ADD COLUMN key_algorithm TEXT DEFAULT 'ES256';

-- attestation_statement: opaque token from Play Integrity / DeviceCheck.
--   Stored for future server-side verification (Phase 4). NOT validated
--   at pairing time. A device that submits a forged statement will pair
--   successfully today. Do not rely on this field for security until
--   the verification step is implemented.
ALTER TABLE op_paired_devices ADD COLUMN attestation_statement TEXT;
ALTER TABLE op_paired_devices ADD COLUMN revoked_at TEXT;
ALTER TABLE op_paired_devices ADD COLUMN revocation_reason TEXT;

-- 2. Nonce replay protection table
CREATE TABLE IF NOT EXISTS op_device_nonces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES op_paired_devices(id) ON DELETE CASCADE,
  UNIQUE (device_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_device_nonces_created
  ON op_device_nonces(created_at);

-- 3. Extend SMS data with cryptographic verification audit trail
ALTER TABLE op_sms_data ADD COLUMN raw_sender TEXT;
ALTER TABLE op_sms_data ADD COLUMN signature_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE op_sms_data ADD COLUMN device_id INTEGER;
