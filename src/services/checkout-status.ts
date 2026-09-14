/**
 * Fast-path checkout status resolution.
 *
 * If D1's payment intent state is lagging (e.g. during D1 replication delay or
 * pending audit drain), queries the authoritative LedgerDO directly to determine
 * whether the double-entry transaction has already committed.
 */

import type { Env } from '../types/env';
import { getLedgerDO } from './ledger';
import { metric } from '../lib/observability';

export interface IntentStatusCandidate {
  id?: number;
  merchant_id?: number;
  status: string;
}

export async function resolveIntentStatus(
  env: Env,
  intent: IntentStatusCandidate,
): Promise<string> {
  if (intent.status === 'completed') return 'completed';
  if (!intent.merchant_id || !intent.id) return intent.status;

  try {
    const txId = `m${intent.merchant_id}:payment:${intent.id}`;
    const doStatus = await getLedgerDO(env, intent.merchant_id).getTransactionStatus(txId);
    if (doStatus.exists) {
      metric(env, 'checkout_status_fastpath_hit', { merchant_id: intent.merchant_id });
      return 'completed';
    }
    return intent.status;
  } catch (err) {
    metric(env, 'checkout_status_fastpath_failed', {
      merchant_id: intent.merchant_id,
      extra: err instanceof Error ? err.message : String(err),
    });
    return intent.status;
  }
}
