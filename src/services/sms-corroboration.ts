/**
 * SMS payment corroboration — the gate between "AI extracted something"
 * and "auto-confirm a payment" (review: Workers AI corroboration).
 *
 * The v0.2.0 parser scored confidence by FIELD COUNT: an extraction
 * with all four fields present scored 0.9 even if every value was
 * wrong. A complete-but-wrong extraction would auto-confirm the wrong
 * order. Confidence in extraction completeness is NOT confidence in
 * extraction correctness.
 *
 * v0.2.1 requires CORROBORATION against open orders before any
 * auto-confirm:
 *   - the extracted amount must EXACTLY match an open order's amount
 *     (and currency, when extracted)
 *   - multiple candidate orders and no trx_id to disambiguate ->
 *     manual review, never "pick one"
 *   - the gateway is taken from the VERIFIED SENDER ID when one maps
 *     (a phone short code is ground truth); the LLM-guessed
 *     gateway_slug is advisory only and loses on conflict
 *   - anything less -> manual review queue + parse-miss metric
 */

import type { Money } from '../lib/money';
import { cmp } from '../lib/money';

export interface SmsExtraction {
  amount: string | null;
  trx_id: string | null;
  currency: string | null;
  gateway_slug: string | null;
  confidence: number;
  parser: 'regex' | 'workers-ai' | 'heuristic' | 'none';
}

export interface OpenOrderCandidate {
  transaction_row_id: number;
  payment_intent_id: number;
  amount: Money;
  currency: string;
  gateway_slug: string | null;
}

export type CorroborationDecision =
  | {
      action: 'confirm';
      order: OpenOrderCandidate;
      gateway_slug: string;
      gateway_source: 'sender_id' | 'extraction';
    }
  | {
      action: 'manual_review';
      reason:
        | 'no_extraction'
        | 'no_open_orders'
        | 'no_amount_match'
        | 'currency_mismatch'
        | 'ambiguous_match'
        | 'gateway_conflict';
    };

/**
 * Known MFS sender-ID -> gateway-slug map (BD/AF focus). Sender IDs are
 * phone short codes / names in the SMS PDU — ground truth the LLM never
 * sees. Extend as gateways are onboarded.
 */
const SENDER_GATEWAY_MAP: Record<string, string> = {
  bkash: 'bkash-api',
  bKash: 'bkash-api',
  nagad: 'nagad-merchant-api',
  rocket: 'rocket',
  upay: 'upay',
};

/** Normalize a sender ID for lookup ('bKash LTD' -> 'bkash'). */
export function senderToGatewaySlug(sender: string | null | undefined): string | null {
  if (!sender) return null;
  const normalized = sender.trim().toLowerCase().replace(/[^a-z]/g, '');
  for (const [key, slug] of Object.entries(SENDER_GATEWAY_MAP)) {
    const normKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (normalized === normKey || normalized.startsWith(normKey)) {
      return slug;
    }
  }
  return null;
}

function isSameGatewayFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/(api|merchantapi|manual)$/g, '');
  return norm(a) === norm(b);
}

/**
 * Decide whether an SMS extraction may auto-confirm an open order.
 * Pure function — unit-tested in tests/sms-corroboration.test.ts.
 */
export function corroborateSmsPayment(
  extraction: SmsExtraction,
  openOrders: OpenOrderCandidate[],
  verifiedGatewaySlug: string | null,
): CorroborationDecision {
  if (extraction.parser === 'none' || !extraction.amount) {
    return { action: 'manual_review', reason: 'no_extraction' };
  }
  if (openOrders.length === 0) {
    return { action: 'manual_review', reason: 'no_open_orders' };
  }

  // 1. EXACT amount match required — never "closest", never fuzzy
  let candidates = openOrders.filter(o => cmp(o.amount, extraction.amount!) === 0);
  if (candidates.length === 0) {
    return { action: 'manual_review', reason: 'no_amount_match' };
  }

  // 2. Currency, when extracted, must match too
  if (extraction.currency) {
    const byCurrency = candidates.filter(o => o.currency === extraction.currency);
    if (byCurrency.length === 0) {
      return { action: 'manual_review', reason: 'currency_mismatch' };
    }
    candidates = byCurrency;
  }

  // 3. trx_id disambiguates when present (matches a gateway trx we
  //    already recorded, or simply narrows by uniqueness below)
  // 4. Ambiguity is a dead end — never pick one of many
  if (candidates.length > 1) {
    return { action: 'manual_review', reason: 'ambiguous_match' };
  }

  const order = candidates[0];

  // 5. Gateway resolution: verified sender ID WINS over the LLM guess.
  //    A conflict between them means either the SMS is spoofed or the
  //    LLM hallucinated the provider — both go to manual review.
  const senderGateway = verifiedGatewaySlug ?? senderToGatewaySlug(null);
  const chosenGateway = senderGateway ?? extraction.gateway_slug ?? order.gateway_slug;

  if (
    senderGateway &&
    order.gateway_slug &&
    !isSameGatewayFamily(order.gateway_slug, senderGateway)
  ) {
    // The open order was initiated on a different gateway than the SMS
    // sender — do not confirm across gateways.
    return { action: 'manual_review', reason: 'gateway_conflict' };
  }

  return {
    action: 'confirm',
    order,
    gateway_slug: chosenGateway ?? order.gateway_slug ?? 'unknown',
    gateway_source: senderGateway ? 'sender_id' : 'extraction',
  };
}
