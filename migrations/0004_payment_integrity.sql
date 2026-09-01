-- ============================================================
-- 0004 — Payment integrity: refund sweep index + integrity guards
--
-- Adds composite index for sweepStuckRefunds hot query:
--   SELECT ... WHERE status='pending' AND created_at < ? AND workflow_attempts < ?
-- Without this, the daily/hourly sweep scans the full refunds table.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_op_refunds_status_created_workflow
  ON op_refunds(status, created_at, workflow_attempts);
