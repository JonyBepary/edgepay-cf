-- ============================================================
-- 0014 — Default brand, store, and gates for existing merchants
--
-- Creates one 'Main' brand per merchant, one 'Main' store per
-- brand, and one gate per existing (merchant, gateway) pair.
-- Backfills FK columns added in 0013.
--
-- All statements are guarded by WHERE NOT EXISTS so this file
-- can be safely re-run if a previous attempt failed partway.
-- ============================================================

-- 1. Default brand per merchant
INSERT INTO op_brands (merchant_id, uuid, name, slug, status)
SELECT m.id, lower(hex(randomblob(16))), 'Main', 'main', 'active'
FROM op_merchants m
WHERE NOT EXISTS (
  SELECT 1 FROM op_brands b
  WHERE b.merchant_id = m.id AND b.slug = 'main'
);

-- 2. Default store per brand
INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, default_currency, status)
SELECT b.id, b.merchant_id, lower(hex(randomblob(16))), 'Main', 'main',
       COALESCE(m.default_currency, 'BDT'), 'active'
FROM op_brands b
JOIN op_merchants m ON m.id = b.merchant_id
WHERE b.slug = 'main'
  AND NOT EXISTS (
    SELECT 1 FROM op_stores s
    WHERE s.brand_id = b.id AND s.slug = 'main'
  );

-- 3. One gate per existing (merchant, gateway)
INSERT INTO op_gates (store_id, merchant_id, gateway_id, label, currency, status)
SELECT s.id, g.merchant_id, g.id,
       COALESCE(g.name, g.slug, 'Gate ' || g.id),
       COALESCE(m.default_currency, 'BDT'),
       'active'
FROM op_gateways g
JOIN op_merchants m ON m.id = g.merchant_id
JOIN op_brands  b ON b.merchant_id = g.merchant_id AND b.slug = 'main'
JOIN op_stores  s ON s.brand_id = b.id AND s.slug = 'main'
WHERE NOT EXISTS (
  SELECT 1 FROM op_gates pg WHERE pg.gateway_id = g.id
);

-- 4. Backfill op_paired_devices.store_id
UPDATE op_paired_devices
SET store_id = (
  SELECT s.id FROM op_stores s
  WHERE s.merchant_id = op_paired_devices.merchant_id AND s.slug = 'main'
  LIMIT 1
)
WHERE store_id IS NULL;

-- 5. Backfill op_payment_intents
UPDATE op_payment_intents
SET store_id = (
  SELECT s.id FROM op_stores s
  WHERE s.merchant_id = op_payment_intents.merchant_id AND s.slug = 'main'
  LIMIT 1
)
WHERE store_id IS NULL;

UPDATE op_payment_intents
SET brand_id = (
  SELECT b.id FROM op_brands b
  WHERE b.merchant_id = op_payment_intents.merchant_id AND b.slug = 'main'
  LIMIT 1
)
WHERE brand_id IS NULL;

UPDATE op_payment_intents
SET gate_id = (
  SELECT pg.id FROM op_gates pg
  WHERE pg.merchant_id = op_payment_intents.merchant_id
    AND pg.gateway_id = op_payment_intents.gateway_id
  LIMIT 1
)
WHERE gate_id IS NULL AND gateway_id IS NOT NULL;

-- 6. Backfill op_transactions
UPDATE op_transactions
SET store_id = (
  SELECT s.id FROM op_stores s
  WHERE s.merchant_id = op_transactions.merchant_id AND s.slug = 'main'
  LIMIT 1
)
WHERE store_id IS NULL;

UPDATE op_transactions
SET brand_id = (
  SELECT b.id FROM op_brands b
  WHERE b.merchant_id = op_transactions.merchant_id AND b.slug = 'main'
  LIMIT 1
)
WHERE brand_id IS NULL;

UPDATE op_transactions
SET gate_id = (
  SELECT pg.id FROM op_gates pg
  WHERE pg.merchant_id = op_transactions.merchant_id
    AND pg.gateway_id = op_transactions.gateway_id
  LIMIT 1
)
WHERE gate_id IS NULL AND gateway_id IS NOT NULL;

-- 7. Backfill op_domains.brand_id
UPDATE op_domains
SET brand_id = (
  SELECT b.id FROM op_brands b
  WHERE b.merchant_id = op_domains.merchant_id AND b.slug = 'main'
  LIMIT 1
)
WHERE brand_id IS NULL;
