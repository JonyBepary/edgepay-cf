-- ============================================================
-- Migration 0002: Cloudflare-native v2 schema changes
-- ============================================================

-- Add Custom Hostnames API integration columns to op_domains.
-- Replaces the DNS TXT verification pipeline:
--   - cf_hostname_id: ID returned by POST /zones/{zone}/custom_hostnames
--   - ssl_status: mirrors the Cloudflare-returned SSL status
--   - cname_target: where the merchant points their hostname
-- The verification_token column is kept for backward compatibility
-- but is no longer used — Custom Hostnames API handles ownership verification.
ALTER TABLE op_domains ADD COLUMN cf_hostname_id TEXT;
ALTER TABLE op_domains ADD COLUMN ssl_status TEXT DEFAULT 'pending_validation';
ALTER TABLE op_domains ADD COLUMN cname_target TEXT;

-- Add index for fast domain lookups (used by DomainMiddleware)
CREATE INDEX IF NOT EXISTS idx_domains_domain_active ON op_domains(domain, status, ssl_status);
