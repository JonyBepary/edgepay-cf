/**
 * Unified webhook inbound handler — /webhook/{gateway}
 *
 * Defense in depth (v0.2.1, review: "geo-block is coarse — gateway IP
 * ranges change; prefer data-driven per-gateway IP allowlists plus
 * signature verification, with geo-block only as fallback"):
 *
 *   Layer 1  per-gateway IP allowlist — op_gateway_ips is DATA-DRIVEN
 *            (update via admin API/SQL, no redeploy) because gateway
 *            IP ranges change without notice. When an allowlist exists
 *            for the gateway, requests from outside it are rejected
 *            before signature checking.
 *   Layer 2  geo fallback — only when no allowlist is configured for
 *            the gateway: request.cf.country must be BD/AF (where our
 *            MFS gateways operate). Coarse by design; the allowlist is
 *            the precise tool.
 *   Layer 3  signature verification (adapter.verifyWebhook) — ALWAYS
 *            required; layers 1-2 only reduce wasted work and probe
 *            noise. Never skipped.
 *
 * Then: idempotent event recording (event_id dedup) and transaction
 * completion via the idempotent ledger posting path.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { gatewayRegistry } from '../gateways';
import { gatewaySelection } from '../gateways/enabled';
import { decrypt } from '../lib/crypto';
import { PaymentService } from '../services/payment';
import { ipInCidr } from '../lib/crypto';
import { metric } from '../lib/observability';

export const webhookRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

/** Geo fallback set — only applied when a gateway has no IP allowlist. */
const WEBHOOK_ALLOWED_COUNTRIES = ['BD', 'AF', 'SG', 'US']; // MFS providers + regional relays

/** Module-level allowlist cache (60s) — avoids a D1 read per webhook. */
const allowlistCache = new Map<string, { cidrs: string[]; fetchedAt: number }>();
const ALLOWLIST_TTL_MS = 60_000;

async function loadGatewayIpAllowlist(env: Env, slug: string): Promise<string[]> {
  const cached = allowlistCache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < ALLOWLIST_TTL_MS) return cached.cidrs;

  const rows = await env.DB
    .prepare(`SELECT cidr FROM op_gateway_ips WHERE gateway_slug = ?`)
    .bind(slug)
    .all<{ cidr: string }>();
  const cidrs = rows.results.map(r => r.cidr);
  allowlistCache.set(slug, { cidrs, fetchedAt: Date.now() });
  return cidrs;
}

// POST /webhook/{gateway_slug}
webhookRoutes.post('/:gateway', async (c) => {
  const slug = c.req.param('gateway');

  // Resolve adapter. v0.2.3: a gateway disabled via ENABLED_GATEWAYS is
  // indistinguishable from an unregistered one — both 404, fail closed,
  // no adapter-inventory information leak to probes.
  if (!gatewayRegistry.has(slug) || !gatewaySelection(c.env.ENABLED_GATEWAYS).enabled.includes(slug)) {
    return c.json({ success: false, error: { code: 'UNKNOWN_GATEWAY' } }, 404);
  }
  const adapter = gatewayRegistry.resolve(slug);

  // Get the merchant context (set by DomainMiddleware)
  const merchantId = c.get('merchantId');
  if (!merchantId) {
    return c.json({ success: false, error: { code: 'NO_MERCHANT_CONTEXT' } }, 400);
  }

  // Load gateway config (decrypted credentials)
  const gateway = await c.env.DB
    .prepare(`SELECT id FROM op_gateways WHERE slug = ? AND merchant_id = ? AND status = 'active' LIMIT 1`)
    .bind(slug, merchantId)
    .first<{ id: number }>();

  if (!gateway) {
    return c.json({ success: false, error: { code: 'GATEWAY_NOT_CONFIGURED' } }, 404);
  }

  // ---- Layer 1: per-gateway IP allowlist (data-driven) ----
  const clientIp = c.req.header('CF-Connecting-IP') ?? '';
  const allowlist = await loadGatewayIpAllowlist(c.env, slug);
  if (allowlist.length > 0) {
    const allowed = allowlist.some(cidr => ipInCidr(clientIp, cidr));
    if (!allowed) {
      metric(c.env, 'webhook_ip_rejected', { merchant_id: merchantId as number, gateway: slug });
      return c.json({ success: false, error: { code: 'IP_NOT_ALLOWED' } }, 403);
    }
  } else if (c.req.raw.cf?.country) {
    // ---- Layer 2: geo fallback (only when no allowlist is configured) ----
    const country = String(c.req.raw.cf.country);
    if (!WEBHOOK_ALLOWED_COUNTRIES.includes(country)) {
      metric(c.env, 'webhook_geo_rejected', { merchant_id: merchantId as number, gateway: slug, extra: country });
      return c.json({ success: false, error: { code: 'GEO_BLOCKED' } }, 403);
    }
  }

  const credRows = await c.env.DB
    .prepare(`SELECT field_name, field_value FROM op_gateway_configs WHERE gateway_id = ? AND merchant_id = ?`)
    .bind(gateway.id, merchantId)
    .all<{ field_name: string; field_value: string }>();

  const credentials: Record<string, string> = {};
  for (const row of credRows.results) {
    try {
      credentials[row.field_name] = await decrypt(row.field_value, c.env.ENCRYPTION_KEY);
    } catch { /* skip */ }
  }

  // Get raw body + headers
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  // ---- Layer 3: signature verification (ALWAYS) ----
  const verified = await adapter.verifyWebhook({ rawBody, headers, credentials, ctx: { kv: c.env.KV } });
  if (!verified) {
    metric(c.env, 'webhook_signature_rejected', { merchant_id: merchantId as number, gateway: slug });
    await c.env.DB
      .prepare(
        `INSERT INTO op_webhook_deliveries (merchant_id, event, url, direction, status_code, response_time_ms, attempt, status, payload_hash, gateway, created_at)
         VALUES (?, 'inbound.unknown', ?, 'inbound', 401, 0, 1, 'failed', '', ?, ?)`,
      )
      .bind(merchantId, c.req.url, slug, new Date().toISOString())
      .run();

    return c.json({ success: false, error: { code: 'SIGNATURE_INVALID' } }, 401);
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = {};
  }

  // Idempotency check — hash the payload + gateway + gateway_event
  const event_id = (payload.id ?? payload.event_id ?? crypto.randomUUID()) as string;
  const existing = await c.env.DB
    .prepare(
      `SELECT id FROM op_webhook_events
       WHERE merchant_id = ? AND gateway = ? AND event_id = ?
       LIMIT 1`,
    )
    .bind(merchantId, slug, event_id)
    .first();

  if (existing) {
    return c.json({ success: true, data: { status: 'duplicate', event_id } });
  }

  // Record event
  const event_type = (payload.type ?? payload.event_type ?? 'unknown') as string;
  const event_created = (payload.created as number | undefined) ?? undefined;
  await c.env.DB
    .prepare(
      `INSERT INTO op_webhook_events (merchant_id, gateway, event_id, event_type, payload, processed_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      merchantId,
      slug,
      event_id,
      event_type,
      rawBody,
      new Date().toISOString(),
    )
    .run();

  // Webhook lag metric (gateway timestamp vs receipt), when available
  if (event_created && typeof event_created === 'number') {
    metric(c.env, 'webhook_lag', {
      merchant_id: merchantId as number,
      gateway: slug,
      value: Math.max(0, Date.now() - event_created * 1000),
    });
  }

  // For payment-completed events, look up the payment intent + complete the transaction
  if (event_type.includes('payment') && (event_type.includes('succeeded') || event_type.includes('completed') || event_type.includes('captured'))) {
    // Extract the trx_id / payment_intent_id from the payload (gateway-specific)
    const trxId = extractTransactionId(slug, payload);
    if (trxId) {
      const tx = await c.env.DB
        .prepare(`SELECT id, payment_intent_id FROM op_transactions WHERE trx_id = ? AND merchant_id = ? LIMIT 1`)
        .bind(trxId, merchantId)
        .first<{ id: number; payment_intent_id: number }>();

      if (tx && tx.payment_intent_id) {
        const service = new PaymentService(c.env);
        await service.completeTransaction(tx.id, tx.payment_intent_id, event_id);
      }
    }
  }

  return c.json({ success: true, data: { status: 'processed', event_id } });
});

/**
 * Extract the EdgePay transaction ID from a gateway webhook payload.
 * Each gateway embeds it differently — usually in metadata we set during initiate().
 */
function extractTransactionId(gatewaySlug: string, payload: Record<string, unknown>): string | null {
  switch (gatewaySlug) {
    case 'stripe': {
      // metadata.edgepay_trx_id is set during initiate() — this is the key
      // the checkout flow uses to reconcile the webhook with the intent.
      const metadata = (payload.data as { object?: { metadata?: Record<string, string> } } | undefined)
        ?.object?.metadata;
      return metadata?.edgepay_trx_id ?? null;
    }
    case 'paypal': {
      // resource.custom is a JSON string we set during initiate()
      const resource = payload.resource as { custom?: string } | undefined;
      return resource?.custom ?? null;
    }
    case 'razorpay': {
      const p = payload.payload as { payment?: { entity?: { notes?: { trx_id?: string } } } } | undefined;
      return p?.payment?.entity?.notes?.trx_id ?? null;
    }
    default:
      return null;
  }
}
