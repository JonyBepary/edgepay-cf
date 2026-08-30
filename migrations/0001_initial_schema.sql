-- ============================================================
-- EdgePay-CF v0.1.0 — D1 (SQLite) Schema
-- Ported from the original PHP/MySQL schema (database/schema.sql).
-- Table prefix `op_` retained from the original schema for
-- backwards compatibility.
-- ============================================================
--
-- Mapping notes (MySQL → D1/SQLite):
--   - BIGINT UNSIGNED AUTO_INCREMENT → INTEGER PRIMARY KEY AUTOINCREMENT
--   - VARCHAR(n)                    → TEXT (SQLite ignores length)
--   - DATETIME(6)                   → TEXT (ISO 8601 strings)
--   - JSON                          → TEXT (parsed at app layer)
--   - ENUM('a','b')                 → TEXT CHECK (col IN ('a','b'))
--   - TINYINT(1)                    → INTEGER (0 or 1)
--   - ON UPDATE CURRENT_TIMESTAMP   → NOT SUPPORTED — app must set updated_at
--   - ENGINE=InnoDB                 → not applicable (SQLite single-file)
--
-- D1 limitations to be aware of:
--   - Max row size: 1MB (SQLite page size limit)
--   - No interactive transactions (BEGIN/COMMIT round-trips)
--     → Use D1 batch() — batches are atomic
--   - No foreign key enforcement by default (PRAGMA foreign_keys=ON)
--     → App layer must enforce referential integrity
--   - Single-writer model (writes go to primary, reads to replicas)
--   - Max 5GB on Free, 10GB on Paid
-- ============================================================

-- 1. Merchants & RBAC ------------------------------------------------

CREATE TABLE op_merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  logo_path TEXT,
  color TEXT,
  initials TEXT,
  description TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  default_currency TEXT NOT NULL DEFAULT 'BDT',
  webhook_secret TEXT,
  settings TEXT, -- JSON
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending')),
  is_platform INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_merchants_status ON op_merchants(status);

CREATE TABLE op_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, slug),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_roles_merchant ON op_roles(merchant_id);

CREATE TABLE op_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT NOT NULL
);

CREATE TABLE op_role_permissions (
  role_id INTEGER NOT NULL,
  permission_id INTEGER NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES op_roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES op_permissions(id) ON DELETE CASCADE
);

CREATE TABLE op_merchant_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  phone TEXT,
  phone_hash TEXT,
  password_hash TEXT NOT NULL,
  two_factor_secret TEXT, -- AES-256-GCM encrypted
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  role_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending')),
  last_login_at TEXT,
  login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES op_roles(id) ON DELETE SET NULL
);
CREATE INDEX idx_users_email_hash ON op_merchant_users(email_hash);
CREATE INDEX idx_users_merchant ON op_merchant_users(merchant_id);

CREATE TABLE op_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]', -- JSON array
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','revoked')),
  last_used_at TEXT,
  expires_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_api_keys_prefix ON op_api_keys(key_prefix);
CREATE INDEX idx_api_keys_merchant ON op_api_keys(merchant_id);

-- 2. Domains & Gateways ----------------------------------------------

CREATE TABLE op_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'checkout' CHECK (type IN ('checkout','api','admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','inactive')),
  dns_verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT NOT NULL,
  redirect_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_domains_status ON op_domains(status);

CREATE TABLE op_gateways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('api','manual','express')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  priority INTEGER NOT NULL DEFAULT 0,
  logo_path TEXT,
  supported_currencies TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, slug),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_gateways_merchant ON op_gateways(merchant_id);

CREATE TABLE op_gateway_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id INTEGER NOT NULL,
  merchant_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT NOT NULL, -- AES-256-GCM ciphertext (base64)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gateway_id, field_name),
  FOREIGN KEY (gateway_id) REFERENCES op_gateways(id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE TABLE op_manual_gateways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id INTEGER NOT NULL,
  merchant_id INTEGER NOT NULL,
  account_name TEXT,
  account_number TEXT,
  bank_name TEXT,
  branch_name TEXT,
  routing_number TEXT,
  qr_code_path TEXT,
  payment_number TEXT,
  instructions TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (gateway_id) REFERENCES op_gateways(id) ON DELETE CASCADE
);

-- 3. Currency & Exchange Rates ---------------------------------------

CREATE TABLE op_currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimal_places INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE op_exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base TEXT NOT NULL,
  target TEXT NOT NULL,
  rate TEXT NOT NULL, -- decimal string (avoid float drift)
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (base, target)
);

-- 4. System Settings ------------------------------------------------

CREATE TABLE op_system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Customers -------------------------------------------------------

CREATE TABLE op_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  name_encrypted TEXT NOT NULL,
  email_hash TEXT,
  email_encrypted TEXT,
  phone_hash TEXT,
  phone_encrypted TEXT,
  metadata TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_customers_email_hash ON op_customers(merchant_id, email_hash);
CREATE INDEX idx_customers_phone_hash ON op_customers(merchant_id, phone_hash);

-- 6. Payment Intents & Transactions ---------------------------------

CREATE TABLE op_payment_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,                -- decimal string
  currency TEXT NOT NULL,
  description TEXT,
  customer_id INTEGER,
  gateway_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','cancelled','expired')),
  original_amount TEXT,
  original_currency TEXT,
  exchange_rate TEXT,
  metadata TEXT, -- JSON
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES op_customers(id) ON DELETE SET NULL,
  FOREIGN KEY (gateway_id) REFERENCES op_gateways(id) ON DELETE SET NULL
);
CREATE INDEX idx_intents_merchant ON op_payment_intents(merchant_id);
CREATE INDEX idx_intents_status ON op_payment_intents(status);
CREATE INDEX idx_intents_expires ON op_payment_intents(expires_at);

CREATE TABLE op_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  trx_id TEXT NOT NULL UNIQUE,
  payment_intent_id INTEGER,
  gateway_id INTEGER NOT NULL,
  gateway_trx_id TEXT,
  customer_id INTEGER,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  fee TEXT NOT NULL DEFAULT '0.00',
  net_amount TEXT NOT NULL,
  original_amount TEXT,
  original_currency TEXT,
  exchange_rate TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','created','processing','callback_processing',
                      'completed','failed','cancelled','expired',
                      'refunded','disputed','awaiting_verification','pending_review')),
  gateway_type TEXT NOT NULL DEFAULT 'unknown',
  metadata TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_intent_id) REFERENCES op_payment_intents(id) ON DELETE SET NULL,
  FOREIGN KEY (gateway_id) REFERENCES op_gateways(id),
  FOREIGN KEY (customer_id) REFERENCES op_customers(id) ON DELETE SET NULL
);
CREATE INDEX idx_transactions_merchant ON op_transactions(merchant_id);
CREATE INDEX idx_transactions_status ON op_transactions(status);
CREATE INDEX idx_transactions_gateway_trx ON op_transactions(gateway_trx_id);

CREATE TABLE op_idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  request_body_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, key),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_idempotency_expires ON op_idempotency_keys(expires_at);

CREATE TABLE op_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  refund_id TEXT NOT NULL UNIQUE,
  transaction_id INTEGER NOT NULL,
  gateway_refund_id TEXT,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed')),
  initiated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES op_transactions(id) ON DELETE CASCADE
);

-- 7. Payment Links & Invoices ---------------------------------------

CREATE TABLE op_payment_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  amount TEXT,                          -- NULL = variable amount
  currency TEXT NOT NULL,
  min_amount TEXT,
  max_amount TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','expired')),
  usage_limit INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  success_url TEXT,
  cancel_url TEXT,
  custom_fields TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, slug),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE TABLE op_payment_link_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_link_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  options TEXT, -- JSON
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (payment_link_id) REFERENCES op_payment_links(id) ON DELETE CASCADE
);

CREATE TABLE op_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  invoice_number TEXT NOT NULL,
  customer_id INTEGER,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  tax_amount TEXT NOT NULL DEFAULT '0.00',
  discount_amount TEXT NOT NULL DEFAULT '0.00',
  total_amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','paid','overdue','cancelled')),
  issue_date TEXT,
  due_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, invoice_number),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES op_customers(id) ON DELETE SET NULL
);

CREATE TABLE op_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price TEXT NOT NULL,
  total TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES op_invoices(id) ON DELETE CASCADE
);

-- 8. Webhooks -------------------------------------------------------

CREATE TABLE op_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]', -- JSON array ('*' = all)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE TABLE op_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  gateway TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, gateway, event_id),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_webhook_events_lookup ON op_webhook_events(merchant_id, gateway, event_id);

CREATE TABLE op_webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  status_code INTEGER NOT NULL DEFAULT 0,
  response_time_ms INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed','retrying')),
  payload_hash TEXT NOT NULL DEFAULT '',
  gateway TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_webhook_deliveries_merchant ON op_webhook_deliveries(merchant_id, created_at);

-- 9. Ledger (double-entry) ------------------------------------------

CREATE TABLE op_ledger_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  currency TEXT NOT NULL,
  parent_id INTEGER,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, code, currency),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_ledger_accounts_code ON op_ledger_accounts(merchant_id, code);

CREATE TABLE op_ledger_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  reference_type TEXT NOT NULL
    CHECK (reference_type IN ('payment','refund','fee','adjustment','transfer')),
  reference_id TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted'
    CHECK (status IN ('posted','reversed')),
  posted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_ledger_tx_ref ON op_ledger_transactions(reference_type, reference_id);

CREATE TABLE op_ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  ledger_transaction_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount TEXT NOT NULL, -- decimal string
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (ledger_transaction_id) REFERENCES op_ledger_transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES op_ledger_accounts(id) ON DELETE RESTRICT
);
CREATE INDEX idx_ledger_entries_account ON op_ledger_entries(account_id);
CREATE INDEX idx_ledger_entries_tx ON op_ledger_entries(ledger_transaction_id);

-- 10. Disputes & Audit ---------------------------------------------

CREATE TABLE op_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  transaction_id INTEGER NOT NULL,
  dispute_id TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','under_review','won','lost','closed')),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  evidence TEXT, -- JSON
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES op_transactions(id)
);

CREATE TABLE op_fee_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER,
  gateway_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('flat','percentage','tiered')),
  amount TEXT,         -- flat amount or percentage value
  min_fee TEXT,
  max_fee TEXT,
  tiers TEXT, -- JSON array of {min_amount, fee}
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE TABLE op_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  actor_id INTEGER,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin','api_key','system','mobile')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_values TEXT, -- JSON
  new_values TEXT, -- JSON
  ip_address TEXT,
  user_agent TEXT,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);
CREATE INDEX idx_audit_logs_entity ON op_audit_logs(entity_type, entity_id);

-- 11. Auth & Security ----------------------------------------------

CREATE TABLE op_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER,
  email TEXT,
  ip_address TEXT,
  user_agent TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts_ip ON op_login_attempts(ip_address, created_at);

CREATE TABLE op_password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES op_merchant_users(id) ON DELETE CASCADE
);

CREATE TABLE op_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE op_sessions (
  id TEXT PRIMARY KEY, -- UUID
  merchant_id INTEGER,
  user_id INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  payload TEXT, -- JSON
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON op_sessions(user_id);

-- 12. Mobile Companion ---------------------------------------------

CREATE TABLE op_device_pairing_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE, -- 6-digit OTP
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES op_merchant_users(id) ON DELETE CASCADE
);

CREATE TABLE op_paired_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES op_merchant_users(id) ON DELETE CASCADE
);
CREATE INDEX idx_paired_devices_merchant ON op_paired_devices(merchant_id);

CREATE TABLE op_mobile_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES op_paired_devices(id) ON DELETE CASCADE
);
CREATE INDEX idx_notifications_device ON op_mobile_notifications(device_id, read_at);

-- 13. SMS Verification ---------------------------------------------

CREATE TABLE op_sms_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  gateway_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  regex_pattern TEXT,
  sample_sms TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE TABLE op_sms_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  parsed_amount TEXT,
  parsed_trx_id TEXT,
  parsed_at TEXT,
  match_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (match_status IN ('pending','parsed','matched','no_match','failed','needs_manual_review')),
  template_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES op_sms_templates(id) ON DELETE SET NULL
);
CREATE INDEX idx_sms_data_status ON op_sms_data(match_status);

CREATE TABLE op_sms_parsed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  sms_id INTEGER,
  sender TEXT,
  body TEXT,
  parsed_amount TEXT,
  parsed_trx_id TEXT,
  parsed_at TEXT,
  match_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sms_id) REFERENCES op_sms_data(id) ON DELETE SET NULL
);

-- 14. Plugin System -----------------------------------------------

CREATE TABLE op_plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  type TEXT NOT NULL CHECK (type IN ('gateway','theme','addon')),
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive')),
  is_system INTEGER NOT NULL DEFAULT 0,
  manifest TEXT NOT NULL, -- JSON
  installed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE op_brand_plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL,
  plugin_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  settings TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, plugin_id),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (plugin_id) REFERENCES op_plugins(id) ON DELETE CASCADE
);

CREATE TABLE op_plugin_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id INTEGER NOT NULL,
  migration_name TEXT NOT NULL,
  batch INTEGER NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plugin_id, migration_name),
  FOREIGN KEY (plugin_id) REFERENCES op_plugins(id) ON DELETE CASCADE
);

CREATE TABLE op_plugin_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id INTEGER NOT NULL,
  merchant_id INTEGER,
  key TEXT NOT NULL,
  value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plugin_id, merchant_id, key),
  FOREIGN KEY (plugin_id) REFERENCES op_plugins(id) ON DELETE CASCADE
);

-- 15. Misc --------------------------------------------------------

CREATE TABLE op_comm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER,
  channel TEXT NOT NULL, -- 'email', 'sms', 'webhook', 'push'
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  recipient TEXT,
  subject TEXT,
  body TEXT,
  status TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comm_log_merchant ON op_comm_log(merchant_id, created_at);

CREATE TABLE op_update_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  previous_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','failed','rolled_back')),
  backup_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE op_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  batch INTEGER NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);
