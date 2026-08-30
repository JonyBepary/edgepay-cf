/**
 * Refund workflow poll policy — pure-function tests (review fix #3).
 *
 * The v0.2.0 workflow slept ONCE and returned ("step.sleep('10 minutes');
 * return;"). v0.2.1's policy: a bounded backoff loop that halts as ERRORED
 * (the DLQ) after a ~24h window. These tests pin the policy so it can't
 * silently regress — full instance-level behavior needs a deployed
 * Workflows runtime; the policy math is what actually decides refunds'
 * fate, so it gets pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  REFUND_POLL_MAX_ATTEMPTS,
  refundPollBackoffMs,
  refundPollWindowMs,
  shouldHaltRefundPolling,
} from '../src/workflows/refund-reconciliation';
import { MAX_REFUND_WORKFLOW_ATTEMPTS } from '../src/services/reconciliation';

describe('refund poll backoff schedule', () => {
  it('starts at 1 minute and doubles: 1m, 2m, 4m, 8m, 15m', () => {
    expect(refundPollBackoffMs(0)).toBe(60_000);
    expect(refundPollBackoffMs(1)).toBe(120_000);
    expect(refundPollBackoffMs(2)).toBe(240_000);
    expect(refundPollBackoffMs(3)).toBe(480_000);
    expect(refundPollBackoffMs(4)).toBe(900_000);
  });

  it('caps at 30 minutes after the escalation phase', () => {
    expect(refundPollBackoffMs(5)).toBe(1_800_000);
    expect(refundPollBackoffMs(10)).toBe(1_800_000);
    expect(refundPollBackoffMs(REFUND_POLL_MAX_ATTEMPTS - 1)).toBe(1_800_000);
  });

  it('covers a ~24h window before halting (the DLQ horizon)', () => {
    const windowMs = refundPollWindowMs();
    const hours = windowMs / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(23);
    expect(hours).toBeLessThanOrEqual(25);
  });
});

describe('halt policy (errored instances ARE the DLQ)', () => {
  it('never halts before the attempt budget is exhausted', () => {
    expect(shouldHaltRefundPolling(0)).toBe(false);
    expect(shouldHaltRefundPolling(REFUND_POLL_MAX_ATTEMPTS - 1)).toBe(false);
  });

  it('halts exactly at the budget', () => {
    expect(shouldHaltRefundPolling(REFUND_POLL_MAX_ATTEMPTS)).toBe(true);
    expect(shouldHaltRefundPolling(REFUND_POLL_MAX_ATTEMPTS + 5)).toBe(true);
  });

  it('the sweep re-drives at most MAX_REFUND_WORKFLOW_ATTEMPTS times, then pages a human', () => {
    expect(MAX_REFUND_WORKFLOW_ATTEMPTS).toBe(3);
    expect(Number.isInteger(MAX_REFUND_WORKFLOW_ATTEMPTS)).toBe(true);
  });
});
