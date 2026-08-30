/**
 * Database row types — TypeScript mirrors of D1 tables.
 * Generated from migrations/0001_initial_schema.sql.
 * All `id` columns are INTEGER PRIMARY KEY (SQLite rowid).
 * All timestamps are ISO 8601 strings stored as TEXT.
 */

export interface Merchant {
  id: number;
  uuid: string;
  name: string;
  slug: string;
  email: string;
  phone: string | null;
  logo_path: string | null;
  color: string | null;
  initials: string | null;
  description: string | null;
  timezone: string;
  default_currency: string;
  webhook_secret: string | null;
  settings: string | null;            // JSON string
  status: 'active' | 'suspended' | 'pending';
  is_platform: number;                // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface Role {
  id: number;
  merchant_id: number;
  name: string;
  slug: string;
  description: string | null;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface Permission {
  id: number;
  slug: string;
  description: string | null;
  category: string;
}

export interface MerchantUser {
  id: number;
  merchant_id: number;
  uuid: string;
  name: string;
  email: string;
  email_hash: string;
  phone: string | null;
  phone_hash: string | null;
  password_hash: string;
  two_factor_secret: string | null;       // AES-256-GCM encrypted TOTP secret
  two_factor_enabled: number;
  role_id: number;
  status: 'active' | 'suspended' | 'pending';
  last_login_at: string | null;
  login_attempts: number;
  locked_until: string | null;
  language: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: number;
  merchant_id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string;       // JSON array as string
  status: 'active' | 'locked' | 'revoked';
  last_used_at: string | null;
  expires_at: string | null;
  created_by: number;
  created_at: string;
}

export interface Domain {
  id: number;
  merchant_id: number;
  domain: string;
  type: 'checkout' | 'api' | 'admin';
  status: 'pending' | 'active' | 'inactive';
  dns_verified: number;
  verification_token: string;
  redirect_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Gateway {
  id: number;
  merchant_id: number;
  slug: string;
  name: string;
  type: 'api' | 'manual' | 'express';
  status: 'active' | 'inactive';
  priority: number;
  logo_path: string | null;
  supported_currencies: string;  // JSON array
  created_at: string;
  updated_at: string;
}

export interface GatewayConfig {
  id: number;
  gateway_id: number;
  merchant_id: number;
  field_name: string;
  field_value: string;           // AES-256-GCM ciphertext (base64)
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: number;
  merchant_id: number;
  uuid: string;
  name_encrypted: string;
  email_hash: string | null;
  email_encrypted: string | null;
  phone_hash: string | null;
  phone_encrypted: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentIntent {
  id: number;
  merchant_id: number;
  uuid: string;
  token: string;
  amount: string;                // stored as TEXT (bcmath-style)
  currency: string;
  description: string | null;
  customer_id: number | null;
  gateway_id: number | null;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';
  original_amount: string | null;
  original_currency: string | null;
  exchange_rate: string | null;
  metadata: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: number;
  merchant_id: number;
  trx_id: string;
  payment_intent_id: number | null;
  gateway_id: number;
  gateway_trx_id: string | null;
  customer_id: number | null;
  amount: string;
  currency: string;
  fee: string;
  net_amount: string;
  original_amount: string | null;
  original_currency: string | null;
  exchange_rate: string | null;
  status: 'pending' | 'created' | 'processing' | 'callback_processing' |
          'completed' | 'failed' | 'cancelled' | 'expired' |
          'refunded' | 'disputed' | 'awaiting_verification' | 'pending_review';
  gateway_type: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface Refund {
  id: number;
  merchant_id: number;
  refund_id: string;
  transaction_id: number;
  gateway_refund_id: string | null;
  amount: string;
  currency: string;
  reason: string | null;
  status: 'pending' | 'completed' | 'failed';
  initiated_by: number;
  created_at: string;
  updated_at: string;
}

export interface Webhook {
  id: number;
  merchant_id: number;
  url: string;
  secret: string;
  events: string;                // JSON array as string
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: number;
  merchant_id: number;
  event: string;
  url: string;
  direction: 'inbound' | 'outbound';
  status_code: number;
  response_time_ms: number;
  attempt: number;
  status: 'delivered' | 'failed' | 'pending' | 'retrying';
  payload_hash: string;
  gateway: string;
  created_at: string;
}

export interface LedgerAccount {
  id: number;
  merchant_id: number;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  currency: string;
  parent_id: number | null;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface LedgerTransaction {
  id: number;
  merchant_id: number;
  uuid: string;
  reference_type: 'payment' | 'refund' | 'fee' | 'adjustment' | 'transfer';
  reference_id: string | null;
  description: string;
  status: 'posted' | 'reversed';
  posted_at: string;
  created_at: string;
}

export interface LedgerEntry {
  id: number;
  merchant_id: number;
  ledger_transaction_id: number;
  account_id: number;
  direction: 'debit' | 'credit';
  amount: string;
  currency: string;
  created_at: string;
}

export interface AuditLog {
  id: number;
  merchant_id: number;
  actor_id: number | null;
  actor_type: 'admin' | 'api_key' | 'system' | 'mobile';
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: string | null;
  new_values: string | null;
  ip_address: string | null;
  user_agent: string | null;
  signature: string;
  created_at: string;
}

export interface IdempotencyKey {
  id: number;
  merchant_id: number;
  key: string;
  request_body_hash: string;
  response_status: number;
  response_body: string;
  expires_at: string;
  created_at: string;
}

export interface RateLimit {
  id: number;
  bucket: string;            // e.g. "ip:1.2.3.4:route:/api/v1/payments"
  count: number;
  window_start: string;
  expires_at: string;
}
