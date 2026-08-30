-- ============================================================
-- EdgePay-CF — Seed Data
-- Run via: wrangler d1 execute edgepay-cf --local --file=db/seeds.sql
-- ============================================================

-- Default permissions (RBAC catalog)
INSERT OR IGNORE INTO op_permissions (slug, description, category) VALUES
  ('payments.read', 'View payments and transactions', 'payments'),
  ('payments.write', 'Create and update payments', 'payments'),
  ('payments.refund', 'Issue refunds', 'payments'),
  ('customers.read', 'View customers', 'customers'),
  ('customers.write', 'Create and update customers', 'customers'),
  ('gateways.read', 'View gateways', 'gateways'),
  ('gateways.write', 'Configure gateways', 'gateways'),
  ('gateways.delete', 'Remove gateways', 'gateways'),
  ('webhooks.read', 'View webhook deliveries', 'webhooks'),
  ('webhooks.write', 'Manage webhook endpoints', 'webhooks'),
  ('reports.read', 'View financial reports', 'reports'),
  ('staff.read', 'View staff users', 'staff'),
  ('staff.write', 'Create and update staff', 'staff'),
  ('roles.read', 'View roles', 'staff'),
  ('roles.write', 'Create and update roles', 'staff'),
  ('domains.read', 'View custom domains', 'domains'),
  ('domains.write', 'Manage custom domains', 'domains'),
  ('plugins.read', 'View plugins', 'plugins'),
  ('plugins.write', 'Install and configure plugins', 'plugins'),
  ('themes.read', 'View themes', 'plugins'),
  ('themes.write', 'Activate and configure themes', 'plugins'),
  ('audit.read', 'View audit logs', 'system'),
  ('settings.read', 'View system settings', 'system'),
  ('settings.write', 'Update system settings', 'system'),
  ('api_keys.read', 'View API keys', 'developer'),
  ('api_keys.write', 'Manage API keys', 'developer');

-- Default currencies (subset — full list of 180+ currencies in EdgePay's seeds/currencies.sql)
INSERT OR IGNORE INTO op_currencies (code, name, symbol, decimal_places, status) VALUES
  ('USD', 'US Dollar', '$', 2, 'active'),
  ('EUR', 'Euro', '€', 2, 'active'),
  ('GBP', 'British Pound', '£', 2, 'active'),
  ('BDT', 'Bangladeshi Taka', '৳', 2, 'active'),
  ('INR', 'Indian Rupee', '₹', 2, 'active'),
  ('JPY', 'Japanese Yen', '¥', 0, 'active'),
  ('AUD', 'Australian Dollar', '$', 2, 'active'),
  ('CAD', 'Canadian Dollar', '$', 2, 'active'),
  ('SGD', 'Singapore Dollar', '$', 2, 'active'),
  ('AED', 'UAE Dirham', 'د.إ', 2, 'active'),
  ('BRL', 'Brazilian Real', 'R$', 2, 'active'),
  ('PKR', 'Pakistani Rupee', '₨', 2, 'active');

-- Default system settings
INSERT OR IGNORE INTO op_system_settings (key, value, category) VALUES
  ('app.name', 'EdgePay', 'general'),
  ('app.timezone', 'UTC', 'general'),
  ('app.default_currency', 'BDT', 'general'),
  ('payment.default_timeout_minutes', '15', 'payment'),
  ('payment.fee_default_percentage', '2.5', 'payment'),
  ('webhook.max_retries', '3', 'webhook'),
  ('webhook.backoff_seconds', '60', 'webhook'),
  ('api.rate_limit_per_minute', '120', 'api'),
  ('mobile.pairing_otp_ttl_seconds', '300', 'mobile'),
  ('security.password_min_length', '12', 'security'),
  ('security.session_timeout_seconds', '86400', 'security'),
  ('security.login_max_attempts', '5', 'security'),
  ('security.login_lockout_minutes', '15', 'security');

-- Built-in plugin registry entries (matches src/gateways/index.ts)
INSERT OR IGNORE INTO op_plugins (slug, name, version, description, author, type, status, is_system, manifest) VALUES
  ('stripe', 'Stripe', '1.0.0', 'Stripe payment gateway — global cards + wallets', 'EdgePay Core', 'gateway', 'inactive', 1, '{"capabilities":["refund","webhook","subscription"],"supported_currencies":["USD","EUR","GBP","CAD","AUD","JPY","BDT","INR","SGD"]}'),
  ('paypal', 'PayPal', '1.0.0', 'PayPal Orders API v2 integration', 'EdgePay Core', 'gateway', 'inactive', 1, '{"capabilities":["refund","webhook"],"supported_currencies":["USD","EUR","GBP","CAD","AUD","JPY","BRL"]}'),
  ('bkash-api', 'bKash API', '1.0.0', 'bKash tokenized checkout API integration', 'EdgePay Core', 'gateway', 'inactive', 1, '{"capabilities":["verification"],"supported_currencies":["BDT"]}'),
  ('razorpay', 'Razorpay', '1.0.0', 'Razorpay payment gateway integration', 'EdgePay Core', 'gateway', 'inactive', 1, '{"capabilities":["refund","webhook"],"supported_currencies":["INR","USD","EUR","GBP","SGD","AED","BDT"]}'),
  ('nagad-merchant-api', 'Nagad Merchant API', '1.0.0', 'Nagad merchant API integration with RSA signatures', 'EdgePay Core', 'gateway', 'inactive', 1, '{"capabilities":["verification"],"supported_currencies":["BDT"]}');

-- Default SMS templates (Bangladesh MFS patterns)
INSERT OR IGNORE INTO op_sms_templates (merchant_id, gateway_slug, name, regex_pattern, sample_sms, status) VALUES
  (0, 'bkash-api', 'bKash Payment Received',
   'You have received Tk (?<amount>[0-9,]+\.?[0-9]*) from .* TrxID: (?<trx_id>[A-Z0-9]+)',
   'You have received Tk 1,500.00 from 017XXXXXXXX. TrxID: 9X7Y2Z1A3B. Balance: Tk 5,234.50.',
   'active'),
  (0, 'nagad-merchant-api', 'Nagad Cash In',
   'Cash In of Tk (?<amount>[0-9,]+\.?[0-9]*) is successful\. .* TrxID: (?<trx_id>[A-Z0-9]+)',
   'Cash In of Tk 2,000.00 is successful. Fee: Tk 0.00. New Balance: Tk 7,654.32. TrxID: NG123456789.',
   'active'),
  (0, 'rocket', 'Rocket Cash In',
   'You have received Tk (?<amount>[0-9,]+\.?[0-9]*) .* TrxID: (?<trx_id>[0-9A-Z]+)',
   'You have received Tk 500.00 from 018XXXXXXXX. TrxID: 89AB12CD34.',
   'active');

-- Initial migration record
INSERT OR IGNORE INTO op_migrations (name, batch) VALUES ('0001_initial_schema', 1);
