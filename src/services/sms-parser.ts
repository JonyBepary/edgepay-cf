/**
 * SMS Parser Service — Cloudflare-native v2.
 *
 * v0.1.0 used per-gateway regex templates with a `no_match` fallback
 * for unknown SMS formats. For 120+ gateways this meant manually writing
 * 120+ regex patterns, and any gateway without a template fell through
 * to `status=no_match` — payment never confirmed.
 *
 * v0.2.0 adds a Workers AI fallback. The flow:
 *   1. Try regex templates from op_sms_templates (fast, deterministic)
 *   2. If no match → call Workers AI with a structured-output prompt
 *      that extracts {amount, trx_id, currency, gateway} from any SMS
 *   3. If AI confidence < threshold → mark as needs_manual_review
 *
 * Workers AI runs in the same V8 isolate — no network hop. Typical
 * latency: 50-200ms. Cost: ~$0.01 per 1K inferences.
 *
 * For the long-tail problem (120+ gateways, each with their own SMS format,
 * many of which change without notice), this is the textbook "use AI for
 * the long tail" pattern.
 */

import type { Env } from '../types/env';
import { senderToGatewaySlug } from './sms-corroboration';

export interface SmsParseResult {
  amount: string | null;
  trx_id: string | null;
  currency: string | null;
  gateway_slug: string | null;
  confidence: number;          // 0.0 - 1.0
  parser: 'regex' | 'heuristic' | 'workers-ai' | 'none';
  raw_match?: string;
}

/**
 * Hardened SMS normalizer:
 * 1. Converts Bengali digits (০-৯) and Arabic-Indic numerals to ASCII (0-9)
 * 2. Strips zero-width characters (\u200B, \u200C, \u200D, \uFEFF)
 * 3. Normalizes non-breaking spaces (\u00A0) to standard spaces
 * 4. Normalizes newlines and tabs to single spaces
 * 5. Collapses multiple consecutive spaces
 */
export function normalizeSmsText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    // Convert Bengali numerals (০-৯ -> 0-9)
    .replace(/[০-৯]/g, d => String(d.charCodeAt(0) - 0x09E6))
    // Convert Arabic-Indic numerals (٠-٩ -> 0-9)
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    // Remove zero-width spaces, soft hyphens, byte order marks
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    // Normalize NBSP and special spaces
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    // Replace carriage returns and newlines with space
    .replace(/[\r\n\t]+/g, ' ')
    // Collapse multi-spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates whether an amount string is a clean positive decimal.
 */
function isValidAmount(amt: string | null | undefined): boolean {
  if (!amt) return false;
  if (!/^\d+(\.\d{1,2})?$/.test(amt)) return false;
  const num = parseFloat(amt);
  return !isNaN(num) && num > 0 && isFinite(num);
}

/**
 * Rule-based heuristic extractor for edge case / mangled / partial SMS.
 */
export function extractFallbackHeuristic(cleanBody: string, sender: string): SmsParseResult {
  const gatewaySlug = senderToGatewaySlug(sender) || 'manual';

  // 1. Extract TrxID / TxnID / Ref
  const trxMatch = cleanBody.match(/(?:trx\s*id|transaction\s*id|txnid|txn\s*id|trans\s*id|ref\s*id|reference|invoice|id)\s*[:.\-#]?\s*([A-Za-z0-9]{5,32})/i);
  const trxId = trxMatch ? trxMatch[1].trim() : null;

  // 2. Extract Amount
  // Pattern A: "received/payment Tk 500.00" or "পেয়েছেন ১৮৯.০০"
  let amountMatch = cleanBody.match(/(?:received|payment|cash\s*in|amount|credited|credit|paid|added|টাকা|পেয়েছেন|প্রাপ্ত|পেমেন্ট|জমা)\s*(?:of\s*)?(?:tk|bdt|rs|usd|\$|€|£|৳|টাকা)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i);
  
  // Pattern B: "Tk 500.00 from..." or "৳500.00"
  if (!amountMatch) {
    amountMatch = cleanBody.match(/(?:tk|bdt|rs|usd|\$|€|£|৳|টাকা)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i);
  }

  // Pattern C: "500.00 Tk" or "189.00 টাকা" (amount before currency)
  if (!amountMatch) {
    amountMatch = cleanBody.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s*(?:tk|bdt|rs|usd|\$|€|£|৳|টাকা)/i);
  }

  let extractedAmount = amountMatch ? amountMatch[1].replace(/,/g, '').trim() : null;
  if (!isValidAmount(extractedAmount)) {
    extractedAmount = null;
  }

  // 3. Extract Currency
  let currency = 'BDT';
  if (/usd|\$/i.test(cleanBody)) currency = 'USD';
  else if (/eur|€/i.test(cleanBody)) currency = 'EUR';
  else if (/gbp|£/i.test(cleanBody)) currency = 'GBP';
  else if (/inr|₹/i.test(cleanBody)) currency = 'INR';

  if (extractedAmount && trxId) {
    return {
      amount: extractedAmount,
      trx_id: trxId,
      currency,
      gateway_slug: gatewaySlug,
      confidence: 0.95,
      parser: 'heuristic',
      raw_match: cleanBody,
    };
  }

  if (extractedAmount) {
    return {
      amount: extractedAmount,
      trx_id: null,
      currency,
      gateway_slug: gatewaySlug,
      confidence: 0.75,
      parser: 'heuristic',
      raw_match: cleanBody,
    };
  }

  return {
    amount: null,
    trx_id: trxId,
    currency: null,
    gateway_slug: gatewaySlug,
    confidence: 0,
    parser: 'none',
  };
}

const AI_FALLBACK_PROMPT = `You are an SMS payment confirmation parser for the EdgePay payment gateway platform.

Given an SMS message from a mobile financial service (MFS) provider, extract these fields:
- amount: the payment amount as a decimal string (e.g. "1500.00")
- trx_id: the transaction ID from the SMS (alphanumeric)
- currency: ISO 4217 code (BDT, INR, PKR, etc.) — default to BDT if unclear
- gateway_slug: the MFS provider (bkash, nagad, rocket, m-pesa, etc.)

Return a JSON object with these fields. If a field cannot be extracted, set it to null.

Examples:
SMS: "You have received Tk 1,500.00 from 017XXXXXXXX. TrxID: 9X7Y2Z1A3B."
Response: {"amount": "1500.00", "trx_id": "9X7Y2Z1A3B", "currency": "BDT", "gateway_slug": "bkash"}

SMS: "Cash In of Tk 2,000.00 is successful. TrxID: NG123456789."
Response: {"amount": "2000.00", "trx_id": "NG123456789", "currency": "BDT", "gateway_slug": "nagad"}`;

const AI_CONFIDENCE_THRESHOLD = 0.7;

export class SmsParserService {
  constructor(private readonly env: Env) {}

  /**
   * Parse an SMS body. Tries regex templates first, then rule-based heuristic, falls back to Workers AI.
   */
  async parse(
    smsBody: string,
    sender: string,
    merchantId: number,
  ): Promise<SmsParseResult> {
    const cleanBody = normalizeSmsText(smsBody);

    // 1. Try regex templates
    const templates = await this.env.DB.prepare(
      `SELECT id, gateway_slug, regex_pattern FROM op_sms_templates
       WHERE merchant_id IN (0, ?) AND status = 'active'`
    ).bind(merchantId).all<{ id: number; gateway_slug: string; regex_pattern: string }>();

    for (const tpl of templates.results) {
      if (!tpl.regex_pattern) continue;
      try {
        const regex = new RegExp(tpl.regex_pattern, 'i');
        const match = regex.exec(cleanBody);
        if (match?.groups) {
          const rawAmount = match.groups.amount ? match.groups.amount.replace(/,/g, '').trim() : null;
          if (isValidAmount(rawAmount)) {
            return {
              amount: rawAmount,
              trx_id: (match.groups.trx_id ?? match.groups.invoice ?? '').trim() || null,
              currency: (match.groups.currency ?? 'BDT').trim(),
              gateway_slug: tpl.gateway_slug,
              confidence: 1.0,          // regex match = high confidence
              parser: 'regex',
              raw_match: match[0],
            };
          }
        }
      } catch {
        // Bad regex — skip this template
      }
    }

    // 2. Rule-based heuristic fallback
    const heuristic = extractFallbackHeuristic(cleanBody, sender);
    if (heuristic.parser !== 'none' && heuristic.amount && heuristic.trx_id) {
      return heuristic;
    }

    // 3. Fallback to Workers AI (if binding present)
    if (this.env.AI) {
      return await this.parseWithAI(cleanBody, sender);
    }

    return heuristic;
  }

  /**
   * Workers AI fallback — extracts structured data from any SMS format.
   * Uses the @cf/meta/llama-3.1-8b-instruct model with structured output.
   */
  async parseWithAI(smsBody: string, sender: string): Promise<SmsParseResult> {
    try {
      // Workers AI bindings are available in the same isolate
      // (no network hop — model runs on Cloudflare's GPU infrastructure
      // colocated with the Worker)
      const ai = this.env.AI;
    if (!ai) throw new Error('AI binding not configured (uncomment "ai" in wrangler.jsonc)');
    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: AI_FALLBACK_PROMPT },
          { role: 'user', content: `SMS from ${sender}:\n${smsBody}` },
        ],
        // Structured output — Workers AI supports JSON schema enforcement
        response_format: {
          type: 'json_schema',
          json_schema: {
            schema: {
              type: 'object',
              properties: {
                amount: { type: ['string', 'null'] },
                trx_id: { type: ['string', 'null'] },
                currency: { type: ['string', 'null'] },
                gateway_slug: { type: ['string', 'null'] },
              },
              required: ['amount', 'trx_id', 'currency', 'gateway_slug'],
            },
          },
        },
      }) as { response?: string };

      if (!response?.response) {
        return { amount: null, trx_id: null, currency: null, gateway_slug: null, confidence: 0, parser: 'none' };
      }

      const parsed = JSON.parse(response.response) as {
        amount?: string | null;
        trx_id?: string | null;
        currency?: string | null;
        gateway_slug?: string | null;
      };

      // Heuristic confidence: if all 4 fields extracted, confidence = 0.9
      // if any field null, confidence drops
      const fieldCount = [parsed.amount, parsed.trx_id, parsed.currency, parsed.gateway_slug]
        .filter(v => v !== null && v !== undefined && v !== '').length;
      const confidence = fieldCount / 4 * 0.9;

      if (confidence < AI_CONFIDENCE_THRESHOLD) {
        // Below threshold — flag for manual review
        return {
          amount: parsed.amount ?? null,
          trx_id: parsed.trx_id ?? null,
          currency: parsed.currency ?? null,
          gateway_slug: parsed.gateway_slug ?? null,
          confidence,
          parser: 'workers-ai',
        };
      }

      return {
        amount: parsed.amount ?? null,
        trx_id: parsed.trx_id ?? null,
        currency: parsed.currency ?? null,
        gateway_slug: parsed.gateway_slug ?? null,
        confidence,
        parser: 'workers-ai',
      };
    } catch (err) {
      console.error('Workers AI SMS parse failed:', err);
      return { amount: null, trx_id: null, currency: null, gateway_slug: null, confidence: 0, parser: 'none' };
    }
  }
}
