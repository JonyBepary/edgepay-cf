-- 0005_otp_hardening: store device-pairing OTPs as SHA-256 hashes only.
-- New rows write token_hash (hash of the 6-digit OTP); the plaintext OTP is
-- never persisted. The legacy `token` column is retained for rollback
-- compatibility but new code queries token_hash exclusively.

ALTER TABLE op_device_pairing_tokens ADD COLUMN token_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_pairing_token_hash ON op_device_pairing_tokens(token_hash);
