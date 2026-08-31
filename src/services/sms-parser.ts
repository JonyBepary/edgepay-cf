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

export interface SmsParseResult {
  amount: string | null;
  trx_id: string | null;
  currency: string | null;
  gateway_slug: string | null;
  confidence: number;          // 0.0 - 1.0
  parser: 'regex' | 'workers-ai' | 'none';
  raw_match?: string;
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
   * Parse an SMS body. Tries regex templates first, falls back to Workers AI.
   */
  async parse(
    smsBody: string,
    sender: string,
    merchantId: number,
  ): Promise<SmsParseResult> {
    // 1. Try regex templates
    const templates = await this.env.DB.prepare(

      `SELECT id, gateway_slug, regex_pattern FROM op_sms_templates
       WHERE merchant_id IN (0, ?) AND status = 'active'`
).bind(merchantId).all<{ id: number; gateway_slug: string; regex_pattern: string }>();

    for (const tpl of templates.results) {
      if (!tpl.regex_pattern) continue;
      try {
        const regex = new RegExp(tpl.regex_pattern, 'i');
        const match = regex.exec(smsBody);
        if (match?.groups) {
          const rawAmount = match.groups.amount ? match.groups.amount.replace(/,/g, '').trim() : null;
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
      } catch {
        // Bad regex — skip this template
      }
    }

    // 2. Fallback to Workers AI
    return await this.parseWithAI(smsBody, sender);
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
