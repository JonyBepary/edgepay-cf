-- migrations/0015_repair_orphan_hierarchy.sql
-- Backfill Main brand/store for merchants created between Phase 6a
-- (migration 0014) and the provisionDefaultHierarchy fix (Phase 6d).
-- Idempotent: safe to re-run. Mirrors the 0014 backfill SQL.

INSERT INTO op_brands (merchant_id, uuid, name, slug, status)
SELECT m.id, lower(hex(randomblob(16))), 'Main', 'main', 'active'
FROM op_merchants m
WHERE NOT EXISTS (
  SELECT 1 FROM op_brands b WHERE b.merchant_id = m.id AND b.slug = 'main'
);

INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, default_currency, status)
SELECT b.id, b.merchant_id, lower(hex(randomblob(16))), 'Main', 'main',
       COALESCE(m.default_currency, 'BDT'), 'active'
FROM op_brands b
JOIN op_merchants m ON m.id = b.merchant_id
WHERE b.slug = 'main'
  AND NOT EXISTS (
    SELECT 1 FROM op_stores s WHERE s.brand_id = b.id AND s.slug = 'main'
  );
