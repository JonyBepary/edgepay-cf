-- ============================================================
-- 0012 — Merchant → Brand → Store → Gate hierarchy (tables)
--
-- Three new tables representing the domain hierarchy above
-- existing merchants:
--   Merchant 1:N Brand 1:N Store 1:N Gate
--
-- A "Gate" is a concrete payment endpoint: one MFS number or
-- gateway account bound to a specific store. Multiple gates
-- per store allow a shop to receive on multiple bKash/Nagad
-- accounts simultaneously.
--
-- Backward compatibility: no changes to existing tables in
-- this migration. Nullable FK columns and backfill are in
-- migrations 0013 and 0014 respectively.
--
-- DDL Non-Restartability Note: see 0007/0008.
-- ============================================================

CREATE TABLE IF NOT EXISTS op_brands (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   INTEGER NOT NULL,
  uuid          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived')),
  logo_path     TEXT,
  brand_color   TEXT,
  support_email TEXT,
  support_phone TEXT,
  terms_url     TEXT,
  privacy_url   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, slug),
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_brands_merchant
  ON op_brands(merchant_id, status);

CREATE TABLE IF NOT EXISTS op_stores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id          INTEGER NOT NULL,
  merchant_id       INTEGER NOT NULL,
  uuid              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  default_currency  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','archived')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (brand_id, slug),
  FOREIGN KEY (brand_id)    REFERENCES op_brands(id)   ON DELETE CASCADE,
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stores_brand
  ON op_stores(brand_id, status);
CREATE INDEX IF NOT EXISTS idx_stores_merchant
  ON op_stores(merchant_id, status);

-- A Gate is a physical payment endpoint.
-- mfs_number carries the receiving phone number for MFS gateways
-- (e.g. "01712345678" for bKash personal). NULL for API-only
-- gateways (Stripe, etc.) that have no phone.
CREATE TABLE IF NOT EXISTS op_gates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL,
  merchant_id  INTEGER NOT NULL,
  gateway_id   INTEGER NOT NULL,
  label        TEXT NOT NULL,
  mfs_number   TEXT,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','archived')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id)    REFERENCES op_stores(id)    ON DELETE CASCADE,
  FOREIGN KEY (merchant_id) REFERENCES op_merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (gateway_id)  REFERENCES op_gateways(id)
);

CREATE INDEX IF NOT EXISTS idx_gates_store
  ON op_gates(store_id, status);
CREATE INDEX IF NOT EXISTS idx_gates_merchant
  ON op_gates(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_gates_mfs
  ON op_gates(mfs_number) WHERE mfs_number IS NOT NULL;
