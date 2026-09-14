import type { Env } from '../types/env';
import type { EnforcementMode, PolicyEvaluationResult } from './device-policy';

export interface PolicyEvaluationEvent {
  merchantId: number;
  deviceId: number | null;
  context: 'pairing' | 'sms' | 'sms_batch';
  mode: EnforcementMode;
  requiredTier: string;
  result: PolicyEvaluationResult;
  /**
   * Number of evaluations this event represents. Defaults to 1 for
   * single-request contexts (pairing, sms). For sms_batch, pass the
   * batch message count so the daily rollup stores the true evaluation
   * count in one UPSERT rather than N writes on the hot path.
   */
  evaluationCount?: number;
}

/**
 * Emit a policy evaluation to Analytics Engine and update
 * the daily rollup. Never throws. Never blocks.
 */
export async function recordPolicyEvaluation(
  env: Env,
  event: PolicyEvaluationEvent,
): Promise<void> {
  if (event.mode === 'off') {
    return;
  }

  const count = event.evaluationCount ?? 1;

  try {
    // 1. Analytics Engine — 100% sample, zero hot-path D1 cost.
    env.ANALYTICS?.writeDataPoint({
      blobs: [
        event.context,
        event.mode,
        event.requiredTier,
        event.result.achievedTier,
        event.result.failureReason ?? '',
      ],
      doubles: [event.merchantId, event.deviceId ?? 0, event.result.compliant ? 1 : 0, count],
      indexes: [String(event.merchantId)],
    });
  } catch {
    // never throw
  }

  try {
    // 2. Daily rollup via UPSERT.
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO op_device_policy_daily_stats
         (merchant_id, day, context, required_tier, achieved_tier, compliant, evaluation_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(merchant_id, day, context, required_tier, achieved_tier, compliant)
       DO UPDATE SET evaluation_count = evaluation_count + excluded.evaluation_count`
    )
      .bind(
        event.merchantId,
        day,
        event.context,
        event.requiredTier,
        event.result.achievedTier,
        event.result.compliant ? 1 : 0,
        count,
      )
      .run();
  } catch {
    // never throw
  }
}
