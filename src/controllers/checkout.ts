/**
 * Checkout routes — /checkout/{token}, /invoice/{token}, /pay/{slug}
 *
 * Public-facing customer checkout flow. Rendered as HTML.
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../types/env';
import { PaymentService } from '../services/payment';
import { resolveIntentStatus } from '../services/checkout-status';
import { HierarchyService, type CheckoutGate, type CheckoutBrand } from '../services/hierarchy';
import { metric } from '../lib/observability';

type CheckoutContext = Context<{ Bindings: Env; Variables: Record<string, unknown> }>;

export const checkoutRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

// Mount Content-Security-Policy & anti-framing on checkout surfaces (EDGE-P0-006 fix)
checkoutRoutes.use('*', async (c, next) => {
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none';");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  await next();
});

// GET /checkout/{token} — render checkout UI
checkoutRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');

  const intent = await c.env.DB.prepare(
    `SELECT pi.id, pi.merchant_id, pi.amount, pi.currency, pi.description, pi.status, pi.expires_at,
            pi.gateway_id, pi.store_id, pi.brand_id, pi.gate_id
     FROM op_payment_intents pi
     WHERE pi.token = ?
     LIMIT 1`
  ).bind(token).first<{
    id: number;
    merchant_id: number;
    amount: string;
    currency: string;
    description: string | null;
    status: string;
    gateway_id: number | null;
    store_id: number | null;
    brand_id: number | null;
    gate_id: number | null;
  }>();

  if (!intent) {
    return c.html('<h1>Payment Not Found</h1>', 404);
  }

  const hierarchy = new HierarchyService(c.env.DB);

  let gates: CheckoutGate[] = [];
  let brand: CheckoutBrand | null = null;

  if (intent.brand_id) {
    brand = await hierarchy.getBrandForCheckout(intent.brand_id, intent.merchant_id);
  }

  if (intent.gate_id) {
    // The intent was created against a specific gate — show only that one.
    const store = await hierarchy.getStore(
      intent.store_id ?? 0,
      intent.merchant_id,
    );
    if (store) {
      const all = await hierarchy.listGatesForCheckout(store.id);
      gates = all.filter(g => g.id === intent.gate_id);
    }
  } else if (intent.store_id) {
    gates = await hierarchy.listGatesForCheckout(intent.store_id);
  } else {
    gates = await hierarchy.listGatesForMerchantDefault(intent.merchant_id);
  }

  if (gates.length === 0) {
    // No gates configured. Render a minimal page telling the customer
    // to contact the merchant. This is a merchant misconfiguration.
    metric(c.env, 'checkout_no_gates', { merchant_id: intent.merchant_id, value: 1 });
    return c.html(renderNoGatesPage(intent, brand), 200);
  }

  // Render checkout HTML
  const merchant = c.get('merchant') as { name?: string; color?: string } | null;
  const brandName = brand?.name ?? merchant?.name ?? 'EdgePay';
  const brandColor = brand?.brand_color ?? merchant?.color ?? '#0052cc';
  const csrfToken = (c.get('csrfToken') as string) || '';

  return c.html(renderCheckoutHTML({
    token,
    amount: String(intent.amount),
    currency: String(intent.currency),
    description: String(intent.description ?? ''),
    status: String(intent.status),
    brandName,
    brandColor,
    gates,
    brand,
    csrfToken,
  }));
});

// POST /checkout/{token}/initiate — customer clicks "Pay"
checkoutRoutes.post('/:token/initiate', async (c) => {
  const token = c.req.param('token');
  const body = await c.req.json<{ gate_id?: number; gateway_id?: number }>();

  const intent = await c.env.DB.prepare(
    `SELECT id, merchant_id FROM op_payment_intents WHERE token = ? LIMIT 1`
  ).bind(token).first<{ id: number; merchant_id: number }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Invalid checkout token' } }, 404);
  }

  const hierarchy = new HierarchyService(c.env.DB);
  let resolvedGatewayId: number | undefined = body.gateway_id;

  if (body.gate_id) {
    const gate = await hierarchy.getGate(body.gate_id, intent.merchant_id);
    if (!gate) {
      return c.json({ success: false, error: { code: 'GATE_NOT_FOUND', message: 'Gate not found' } }, 404);
    }
    // The gate's gateway must belong to the same merchant as the intent.
    resolvedGatewayId = gate.gateway_id;
  }

  if (!resolvedGatewayId) {
    return c.json({ success: false, error: { code: 'GATEWAY_REQUIRED', message: 'Select a payment method' } }, 400);
  }

  const service = new PaymentService(c.env);
  const result = await service.initiatePayment(intent.id, resolvedGatewayId);

  return c.json({ success: true, data: result });
});

// POST /checkout/{token}/verify & /submit-trx — customer submits TrxID and sender phone
// Hardened (P0-1): per-gateway format check, UPPER+trim normalization,
// synthetic-ID rejection. Verification still requires exact SMS corroboration
// (cmp == 0); otherwise the intent stays awaiting_sms/processing — never completed.
export function normalizeTrxId(raw: string): string {
  return raw.trim().toUpperCase();
}

const SYNTHETIC_TRX_EXACT = new Set(['LIVE', 'TEST', 'DEMO', 'NULL', 'NONE', 'N/A']);

export function isSyntheticTrxId(normalized: string): boolean {
  if (!normalized) return true;
  if (SYNTHETIC_TRX_EXACT.has(normalized)) return true;
  // Server-generated prefixes from legacy/insecure code paths — never accept
  // customer-submitted IDs that look machine-generated by us.
  if (normalized.startsWith('TRX')) return true;
  if (normalized.startsWith('EDGEPAY')) return true;
  if (normalized.startsWith('OP_')) return true;
  if (normalized.includes('LIVE')) return true;
  return false;
}

// Per-gateway customer TrxID formats. MFS carriers issue short uppercase
// alphanumerics; card/API gateways allow a wider set. Default is intentionally
// permissive (fake-but-well-formed IDs must reach awaiting_sms, not 400) —
// the security gate is SMS corroboration, not the regex.
const TRX_FORMATS: Record<string, RegExp> = {
  bkash: /^[A-Z0-9]{6,15}$/,
  'bkash-api': /^[A-Z0-9]{6,15}$/,
  nagad: /^[A-Z0-9]{6,15}$/,
  'nagad-merchant-api': /^[A-Z0-9]{6,15}$/,
  rocket: /^[A-Z0-9]{6,15}$/,
  sslcommerz: /^[A-Z0-9]{4,30}$/,
  stripe: /^[A-Z0-9_:-]{4,64}$/,
  razorpay: /^[A-Z0-9_:-]{4,64}$/,
  paypal: /^[A-Z0-9_:-]{4,64}$/,
};

export function validateCustomerTrxId(
  raw: unknown,
  gatewaySlug?: string | null,
): { ok: true; normalized: string } | { ok: false; code: string; message: string } {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_TRX_ID', message: 'Please enter a valid Transaction ID (at least 4 characters)' };
  }
  const normalized = normalizeTrxId(raw);
  if (normalized.length < 4 || normalized.length > 64) {
    return { ok: false, code: 'INVALID_TRX_ID', message: 'Please enter a valid Transaction ID (at least 4 characters)' };
  }
  if (isSyntheticTrxId(normalized)) {
    return { ok: false, code: 'INVALID_TRX_ID', message: 'Please enter the Transaction ID from your payment confirmation message' };
  }
  const key = (gatewaySlug ?? '').trim().toLowerCase();
  const pattern: RegExp = (key ? TRX_FORMATS[key] : undefined) ?? /^[A-Z0-9]{4,30}$/;
  if (!pattern.test(normalized)) {
    return { ok: false, code: 'INVALID_TRX_ID', message: 'Please enter a valid Transaction ID (at least 4 characters)' };
  }
  return { ok: true, normalized };
}

const handleCustomerTrxVerify = async (c: CheckoutContext) => {
  const token = c.req.param('token');
  const body = await c.req.json<{ trx_id?: string; sender_phone?: string; amount?: string }>();

  // Generic format gate (no gateway context yet) — synthetic IDs rejected here.
  const initial = validateCustomerTrxId(body.trx_id);
  if (!initial.ok) {
    return c.json({
      success: false,
      error: { code: initial.code, message: initial.message }
    }, 400);
  }
  const senderPhone = body.sender_phone ? body.sender_phone.trim() : null;

  // Load intent & transaction (incl. gateway slug for per-gateway format gate)
  const intent = await c.env.DB.prepare(
    `SELECT pi.id, pi.merchant_id, pi.amount, pi.currency, pi.status, pi.metadata, pi.gateway_id,
            pi.store_id, pi.brand_id, pi.gate_id,
            g.slug AS gateway_slug,
            t.id AS trx_db_id, t.gateway_trx_id
     FROM op_payment_intents pi
     LEFT JOIN op_transactions t ON t.payment_intent_id = pi.id
     LEFT JOIN op_gateways g ON g.id = pi.gateway_id
     WHERE pi.token = ?
     LIMIT 1`
  ).bind(token).first<{
    id: number;
    merchant_id: number;
    amount: string;
    currency: string;
    status: string;
    metadata: string | null;
    gateway_id: number | null;
    store_id: number | null;
    brand_id: number | null;
    gate_id: number | null;
    gateway_slug: string | null;
    trx_db_id: number | null;
    gateway_trx_id: string | null;
  }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Invalid checkout token' } }, 404);
  }

  // Per-gateway format gate (gateway-aware re-validation).
  const checked = validateCustomerTrxId(body.trx_id, intent.gateway_slug);
  if (!checked.ok) {
    return c.json({
      success: false,
      error: { code: checked.code, message: checked.message }
    }, 400);
  }
  const normalizedTrxId = checked.normalized;

  if (intent.status === 'completed') {
    return c.json({
      success: true,
      data: {
        status: 'completed',
        trx_id: intent.gateway_trx_id ?? normalizedTrxId,
        message: 'Payment has already been confirmed and completed.'
      }
    });
  }

  // 1. Check if this TrxID is already used by another completed transaction
  const usedTrx = await c.env.DB.prepare(
    `SELECT t.id, t.payment_intent_id FROM op_transactions t
     WHERE t.gateway_trx_id = ? AND t.status = 'completed' AND t.payment_intent_id != ?
     LIMIT 1`
  ).bind(normalizedTrxId, intent.id).first();

  if (usedTrx) {
    return c.json({
      success: false,
      error: {
        code: 'TRX_ALREADY_USED',
        message: 'This Transaction ID has already been claimed for another completed payment.'
      }
    }, 409);
  }

  // 2. Check if a matching carrier SMS exists in op_sms_data for this merchant
  const matchingSms = await c.env.DB.prepare(
    `SELECT id, parsed_amount, parsed_trx_id, sender, created_at
     FROM op_sms_data
     WHERE merchant_id = ?
       AND UPPER(TRIM(parsed_trx_id)) = ?
       AND match_status IN ('pending', 'parsed', 'needs_manual_review', 'no_match')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(intent.merchant_id, normalizedTrxId).first<{
    id: number;
    parsed_amount: string;
    parsed_trx_id: string;
    sender: string;
  }>();

  if (matchingSms) {
    // Exact amount verification (EDGE-P0-007 fix)
    const { cmp } = await import('../lib/money');
    if (!matchingSms.parsed_amount || cmp(matchingSms.parsed_amount, intent.amount) !== 0) {
      return c.json({
        success: false,
        error: {
          code: 'AMOUNT_MISMATCH',
          message: `The payment received for TrxID ${normalizedTrxId} does not match the order amount (Tk ${intent.amount}).`
        }
      }, 400);
    }

    // Corroboration success! Complete the transaction and post ledger entry
    const { PaymentService } = await import('../services/payment');
    const service = new PaymentService(c.env);
    
    let txId = intent.trx_db_id;
    if (!txId) {
      const txRow = await c.env.DB.prepare(
        `SELECT id FROM op_transactions WHERE payment_intent_id = ? LIMIT 1`
      ).bind(intent.id).first<{ id: number }>();
      txId = txRow?.id ?? null;
    }

    if (txId) {
      await service.completeTransaction(txId, intent.id, normalizedTrxId);
      await c.env.DB.prepare(
        `UPDATE op_sms_data SET match_status = 'matched' WHERE id = ?`
      ).bind(matchingSms.id).run();

      return c.json({
        success: true,
        data: {
          status: 'completed',
          trx_id: normalizedTrxId,
          amount: intent.amount,
          currency: intent.currency,
          message: 'Payment verified and confirmed!'
        }
      });
    }
  }

  // 3. If SMS has not arrived yet: record customer TrxID & phone on intent for bi-directional queue match
  let meta: Record<string, unknown> = {};
  try {
    if (intent.metadata) meta = JSON.parse(intent.metadata);
  } catch {}
  meta.customer_trx_id = normalizedTrxId;
  meta.customer_phone = senderPhone;
  meta.customer_submitted_at = new Date().toISOString();

  const nowIso = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE op_payment_intents SET metadata = ?, status = 'processing', updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(meta), nowIso, intent.id),
    c.env.DB.prepare(
      `UPDATE op_transactions SET gateway_trx_id = ?, status = 'awaiting_verification', updated_at = ? WHERE payment_intent_id = ?`
    ).bind(normalizedTrxId, nowIso, intent.id)
  ]);

  return c.json({
    success: true,
    data: {
      status: 'awaiting_sms',
      trx_id: normalizedTrxId,
      message: 'Transaction ID submitted. Verifying with mobile network confirmation...'
    }
  });
};

checkoutRoutes.post('/:token/verify', handleCustomerTrxVerify);
checkoutRoutes.post('/:token/submit-trx', handleCustomerTrxVerify);

// GET /checkout/{token}/callback — gateway redirects back here
checkoutRoutes.get('/:token/callback', async (c) => {
  const token = c.req.param('token');
  const callbackData = Object.fromEntries(new URL(c.req.url).searchParams);

  const intent = await c.env.DB.prepare(
    `SELECT id FROM op_payment_intents WHERE token = ? LIMIT 1`
  ).bind(token).first<{ id: number }>();

  if (!intent) {
    return c.html('<h1>Invalid checkout token</h1>', 404);
  }

  const service = new PaymentService(c.env);
  await service.handleCallback(intent.id, callbackData);

  return c.redirect(`/checkout/${token}/status`);
});

// GET /checkout/{token}/status — poll status (AJAX)
checkoutRoutes.get('/:token/status', async (c) => {
  const token = c.req.param('token');

  const intent = await c.env.DB.prepare(
    `SELECT pi.id, pi.merchant_id, pi.status, pi.amount, pi.currency, t.gateway_trx_id
     FROM op_payment_intents pi
     LEFT JOIN op_transactions t ON t.payment_intent_id = pi.id
     WHERE pi.token = ? LIMIT 1`
  ).bind(token).first<{ id: number; merchant_id: number; status: string; amount: string; currency: string; gateway_trx_id: string | null }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
  }

  const finalStatus = await resolveIntentStatus(c.env, intent);

  return c.json({
    success: true,
    data: {
      status: finalStatus,
      amount: intent.amount,
      currency: intent.currency,
      trx_id: intent.gateway_trx_id ?? null,
    },
  });
});

function renderNoGatesPage(
  intent: { amount: string; currency: string; description?: string | null },
  brand: CheckoutBrand | null,
): string {
  const brandName = brand?.name ?? 'EdgePay';
  const brandColor = sanitizeBrandColor(brand?.brand_color ?? undefined);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout — ${escapeHtml(brandName)}</title>
<style>
:root {
  --primary: ${brandColor};
  --bg: #f8fafc;
  --card-bg: #ffffff;
  --text-main: #0f172a;
  --text-muted: #64748b;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  background: var(--bg);
  color: var(--text-main);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem 1rem;
}
.card {
  width: 100%;
  max-width: 480px;
  background: var(--card-bg);
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  padding: 2rem;
  text-align: center;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);
}
h2 { font-size: 1.25rem; margin-bottom: 0.75rem; color: #0f172a; }
p { color: var(--text-muted); font-size: 0.9375rem; margin-bottom: 1rem; line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
  ${brand?.logo_path ? `<img src="${escapeHtml(brand.logo_path)}" alt="${escapeHtml(brandName)}" style="max-height: 48px; margin-bottom: 1rem;" />` : ''}
  <h2>Payment Unavailable</h2>
  <p>Amount: <strong>${escapeHtml(intent.currency)} ${escapeHtml(intent.amount)}</strong></p>
  <p>No active payment methods are currently available for this order.</p>
  <p>Please <strong>contact the merchant</strong> to complete your payment.</p>
  ${brand?.support_email ? `<p style="font-size: 0.8125rem; color: var(--text-muted);">Support: <a href="mailto:${escapeHtml(brand.support_email)}">${escapeHtml(brand.support_email)}</a></p>` : ''}
  ${brand?.support_phone ? `<p style="font-size: 0.8125rem; color: var(--text-muted);">Phone: ${escapeHtml(brand.support_phone)}</p>` : ''}
</div>
</body>
</html>`;
}

function renderCheckoutHTML(opts: {
  token: string;
  amount: string;
  currency: string;
  description: string;
  status: string;
  brandName: string;
  brandColor: string;
  gates: CheckoutGate[];
  brand?: CheckoutBrand | null;
  csrfToken?: string;
}): string {
  const isCompleted = opts.status === 'completed';
  const primaryColor = sanitizeBrandColor(opts.brand?.brand_color ?? opts.brandColor);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${escapeHtml(opts.csrfToken || '')}">
<title>Secure Checkout — ${escapeHtml(opts.brandName)}</title>
<style>
:root {
  --primary: ${primaryColor};
  --primary-hover: #0043a8;
  --bg: #f8fafc;
  --card-bg: #ffffff;
  --text-main: #0f172a;
  --text-muted: #64748b;
  --border: #e2e8f0;
  --success: #10b981;
  --success-bg: #ecfdf5;
  --danger: #ef4444;
  --danger-bg: #fef2f2;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  background: var(--bg);
  color: var(--text-main);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem 1rem;
}
.checkout-card {
  width: 100%;
  max-width: 480px;
  background: var(--card-bg);
  border-radius: 16px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.03);
  border: 1px solid var(--border);
  overflow: hidden;
  animation: fadeIn 0.3s ease-in-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.checkout-header {
  background: linear-gradient(135deg, var(--primary) 0%, #1e293b 100%);
  color: white;
  padding: 1.75rem 1.5rem;
  text-align: center;
}
.brand-name {
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.85;
  margin-bottom: 0.25rem;
}
.order-amount {
  font-size: 2.25rem;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.checkout-body {
  padding: 1.5rem;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.35rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.8125rem;
  font-weight: 600;
  margin-bottom: 1rem;
  background: #fef3c7;
  color: #92400e;
}
.status-pill.completed {
  background: var(--success-bg);
  color: var(--success);
}
.status-pill.awaiting {
  background: #e0f2fe;
  color: #0369a1;
}
.description {
  font-size: 0.9375rem;
  color: var(--text-muted);
  margin-bottom: 1.25rem;
}
.section-label {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
}
.gateway-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  margin-bottom: 1.25rem;
}
.gateway-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  border: 1.5px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.gateway-option:hover {
  border-color: #cbd5e1;
  background: #f8fafc;
}
.gateway-option.selected {
  border-color: var(--primary);
  background: #eff6ff;
}
.gw-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-weight: 600;
  font-size: 0.9375rem;
}
.mfs-info-card {
  background: #f8fafc;
  border: 1.5px solid #e2e8f0;
  border-radius: 12px;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
  font-size: 0.875rem;
}
.steps-list {
  margin: 0.5rem 0 1rem 1.25rem;
  color: #334155;
  line-height: 1.5;
}
.copy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #ffffff;
  border: 1.5px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.625rem 0.875rem;
  margin: 0.5rem 0 1rem;
  font-family: monospace;
  font-weight: 700;
  font-size: 1.125rem;
  color: #0f172a;
}
.copy-btn {
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.35rem 0.65rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.copy-btn:hover { opacity: 0.9; }

.form-group {
  margin-bottom: 1rem;
}
.form-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 700;
  color: #334155;
  margin-bottom: 0.375rem;
}
.form-input {
  width: 100%;
  padding: 0.75rem 0.875rem;
  border: 1.5px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.9375rem;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.form-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.15);
}
.form-input.trx-input {
  text-transform: uppercase;
  font-family: monospace;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.btn-verify {
  width: 100%;
  padding: 0.875rem;
  background: #10b981;
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.05s;
}
.btn-verify:hover { opacity: 0.95; }
.btn-verify:active { transform: scale(0.99); }
.btn-verify:disabled { background: #94a3b8; cursor: not-allowed; transform: none; }

.feedback-banner {
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 1rem;
  display: none;
}
.feedback-banner.error {
  display: block;
  background: var(--danger-bg);
  color: var(--danger);
  border: 1px solid #fecaca;
}
.feedback-banner.info {
  display: block;
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.success-screen {
  text-align: center;
  padding: 2.5rem 1.5rem;
}
.success-icon {
  width: 64px;
  height: 64px;
  background: var(--success-bg);
  color: var(--success);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  margin: 0 auto 1.25rem;
}
.footer-secure {
  text-align: center;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 1.25rem;
}
</style>
</head>
<body>

<div class="checkout-card" id="card">
  ${isCompleted ? `
    <div class="success-screen">
      <div class="success-icon">✓</div>
      <h2 style="font-size: 1.5rem; font-weight: 800; margin-bottom: 0.5rem; color: #065f46;">Payment Successful!</h2>
      <p style="color: #64748b; margin-bottom: 1.5rem;">Your payment of <strong>${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</strong> has been verified & completed.</p>
      <div class="status-pill completed">Completed</div>
    </div>
  ` : `
    <div class="checkout-header">
      ${opts.brand?.logo_path ? `<div class="brand-logo-wrap" style="margin-bottom: 0.75rem;"><img src="${escapeHtml(opts.brand.logo_path)}" alt="${escapeHtml(opts.brandName)}" class="brand-logo" style="max-height: 48px; max-width: 200px; object-fit: contain;" /></div>` : ''}
      <div class="brand-name">${escapeHtml(opts.brandName)}</div>
      <div class="order-amount">${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</div>
    </div>
    <div class="checkout-body">
      <div class="status-pill" id="statusBadge">Awaiting Payment</div>
      <div class="description">${escapeHtml(opts.description || 'Secure Online Order')}</div>

      <div id="feedbackBox" class="feedback-banner"></div>

      <div class="section-label">1. Select Payment Method</div>
      <div class="gateway-list">
        ${opts.gates.map((g, idx) => `
          <label class="gateway-option ${idx === 0 ? 'selected' : ''}" data-id="${g.id}" data-gateway-id="${g.gateway_id}" data-account="${escapeHtml(g.destination_number || 'Contact merchant')}" data-instructions="${escapeHtml(g.instructions || '')}" data-type="${escapeHtml(g.gateway_type)}">
            <div class="gw-left">
              <input type="radio" name="gate_id" value="${g.id}" ${idx === 0 ? 'checked' : ''} style="display:none">
              <span>${escapeHtml(g.label)}</span>
            </div>
            <span style="font-size: 0.8125rem; color: #64748b;">${escapeHtml(g.destination_number || 'Contact merchant')}</span>
          </label>
        `).join('')}
        ${opts.gates.length === 0 ? '<p style="color: #dc2626;">No active payment methods configured</p>' : ''}
      </div>

      <div id="mfsDetails" class="mfs-info-card">
        <div style="font-weight: 700; color: #0f172a; margin-bottom: 0.25rem;">2. How to Pay:</div>
        <ol class="steps-list">
          <li>Open your mobile banking app (bKash / Nagad / Rocket).</li>
          <li>Choose <strong>Send Money</strong> and transfer <strong>${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</strong> to:</li>
        </ol>
        <div class="copy-row">
          <span id="mfsAccount">${escapeHtml(opts.gates[0]?.destination_number || 'Contact merchant')}</span>
          <button class="copy-btn" onclick="copyAccount()">Copy Number</button>
        </div>
        <div id="mfsInstructions" style="color: #64748b; font-size: 0.8125rem; margin-bottom: 1rem;">${escapeHtml(opts.gates[0]?.instructions || '')}</div>

        <div style="font-weight: 700; color: #0f172a; margin-bottom: 0.75rem;">3. Submit Payment Proof (TrxID):</div>
        
        <div class="form-group">
          <label class="form-label" for="senderPhone">Your Mobile Number (Sender)</label>
          <input class="form-input" id="senderPhone" type="tel" placeholder="e.g. 017XXXXXXXX" maxlength="15">
        </div>

        <div class="form-group">
          <label class="form-label" for="trxId">Transaction ID (TrxID) *</label>
          <input class="form-input trx-input" id="trxId" type="text" placeholder="e.g. BK998877 or 9H7X6Y5Z" maxlength="30">
        </div>

        <button id="verifyBtn" class="btn-verify" onclick="submitTrxVerification()">Verify & Complete Payment</button>
      </div>

      <div class="footer-secure">
        🔒 Protected by EdgePay Cloudflare Zero-Trust Ledger
        ${opts.brand?.support_email || opts.brand?.support_phone ? `
          <div class="brand-support" style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-muted);">
            ${opts.brand.support_email ? `<div>Support: <a href="mailto:${escapeHtml(opts.brand.support_email)}" style="color: inherit;">${escapeHtml(opts.brand.support_email)}</a></div>` : ''}
            ${opts.brand.support_phone ? `<div>Phone: ${escapeHtml(opts.brand.support_phone)}</div>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `}
</div>

<script>
const csrfToken = '${escapeHtml(opts.csrfToken || '')}';
let currentGateId = ${opts.gates[0]?.id || 0};
let currentGatewayId = ${opts.gates[0]?.gateway_id || 0};
let pollInterval = null;

function selectGateway(el, id, accountNumber, instructions, type) {
  document.querySelectorAll('.gateway-option').forEach(g => g.classList.remove('selected'));
  el.classList.add('selected');
  const radio = el.querySelector('input');
  if (radio) radio.checked = true;
  currentGateId = Number(id);
  currentGatewayId = Number(el.dataset.gatewayId || 0);

  const mfsBox = document.getElementById('mfsDetails');
  if (mfsBox) {
    mfsBox.style.display = 'block';
    const accEl = document.getElementById('mfsAccount');
    if (accEl) accEl.innerText = accountNumber || 'Contact merchant';
    const instEl = document.getElementById('mfsInstructions');
    if (instEl) instEl.innerText = instructions || 'Send exact payment amount to this personal account number.';
  }
}

document.querySelectorAll('.gateway-option').forEach(el => {
  el.addEventListener('click', function() {
    selectGateway(this, this.dataset.id, this.dataset.account, this.dataset.instructions, this.dataset.type);
  });
});

// Initialize default gateway
const firstOption = document.querySelector('.gateway-option');
if (firstOption) {
  selectGateway(firstOption, firstOption.dataset.id, firstOption.dataset.account, firstOption.dataset.instructions, firstOption.dataset.type);
}

function copyAccount() {
  const num = document.getElementById('mfsAccount').innerText;
  navigator.clipboard.writeText(num).then(() => {
    alert('Account number copied: ' + num);
  });
}

function showFeedback(type, msg) {
  const box = document.getElementById('feedbackBox');
  if (!box) return;
  box.className = 'feedback-banner ' + type;
  box.innerText = msg;
}

async function submitTrxVerification() {
  const trxInput = document.getElementById('trxId');
  const phoneInput = document.getElementById('senderPhone');
  const btn = document.getElementById('verifyBtn');

  const trxId = trxInput.value.trim().toUpperCase();
  const senderPhone = phoneInput ? phoneInput.value.trim() : '';

  if (!trxId || trxId.length < 4) {
    showFeedback('error', 'Please enter a valid Transaction ID (at least 4 characters).');
    trxInput.focus();
    return;
  }

  btn.disabled = true;
  btn.innerText = 'Verifying with Network...';
  showFeedback('info', 'Verifying TrxID ' + trxId + ' with incoming SMS confirmations...');

  const metaCsrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
  const activeCsrf = csrfToken || metaCsrf || '';

  try {
    const res = await fetch('/checkout/${opts.token}/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(activeCsrf ? { 'X-CSRF-Token': activeCsrf } : {}),
      },
      body: JSON.stringify({
        trx_id: trxId,
        sender_phone: senderPhone,
      }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      if (data.data?.status === 'completed') {
        showFeedback('info', 'Payment Verified Successfully!');
        setTimeout(() => window.location.reload(), 500);
      } else {
        showFeedback('info', 'Transaction ID submitted. Awaiting incoming carrier SMS confirmation...');
        document.getElementById('statusBadge').className = 'status-pill awaiting';
        document.getElementById('statusBadge').innerText = 'Awaiting Carrier SMS...';
        startPolling();
      }
    } else {
      showFeedback('error', data.error?.message || 'Verification failed. Please check TrxID and try again.');
      btn.disabled = false;
      btn.innerText = 'Verify & Complete Payment';
    }
  } catch (err) {
    showFeedback('error', 'Network error submitting TrxID. Please check internet connection.');
    btn.disabled = false;
    btn.innerText = 'Verify & Complete Payment';
  }
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/checkout/${opts.token}/status');
      const json = await res.json();
      if (json.data?.status === 'completed') {
        clearInterval(pollInterval);
        window.location.reload();
      }
    } catch (_) {}
  }, 2000);
}

// Auto-start polling if awaiting verification
${!isCompleted ? 'startPolling();' : ''}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeBrandColor(color: string | undefined): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    return color.trim();
  }
  return '#2563eb';
}

