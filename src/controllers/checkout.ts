/**
 * Checkout routes — /checkout/{token}, /invoice/{token}, /pay/{slug}
 *
 * Public-facing customer checkout flow. Rendered as HTML.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { PaymentService } from '../services/payment';

export const checkoutRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

// GET /checkout/{token} — render checkout UI
checkoutRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');

  const intent = await c.env.DB.prepare(
    `SELECT pi.id, pi.merchant_id, pi.amount, pi.currency, pi.description, pi.status, pi.expires_at,
            pi.gateway_id
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
  }>();

  if (!intent) {
    return c.html('<h1>Payment Not Found</h1>', 404);
  }

  // Load active gateways for this merchant
  let gateways: Array<{ id: number; slug: string; name: string }> = [];
  if (intent.gateway_id) {
    const gw = await c.env.DB.prepare(
      `SELECT id, slug, name FROM op_gateways WHERE id = ? AND merchant_id = ? AND status = 'active' LIMIT 1`,
    ).bind(intent.gateway_id, intent.merchant_id).first<{ id: number; slug: string; name: string }>();
    if (gw) gateways = [gw];
  } else {
    const gws = await c.env.DB.prepare(
      `SELECT id, slug, name FROM op_gateways WHERE merchant_id = ? AND status = 'active' ORDER BY id ASC`,
    ).bind(intent.merchant_id).all<{ id: number; slug: string; name: string }>();
    gateways = gws.results ?? [];
  }

  // Render checkout HTML
  const merchant = c.get('merchant') as { name?: string; color?: string } | null;
  const brandName = merchant?.name ?? 'EdgePay';
  const brandColor = merchant?.color ?? '#0b1f3a';

  return c.html(renderCheckoutHTML({
    token,
    amount: String(intent.amount),
    currency: String(intent.currency),
    description: String(intent.description ?? ''),
    status: String(intent.status),
    brandName,
    brandColor,
    gateways,
  }));
});

// POST /checkout/{token}/initiate — customer clicks "Pay"
checkoutRoutes.post('/:token/initiate', async (c) => {
  const token = c.req.param('token');
  const body = await c.req.json<{ gateway_id?: number }>();

  const intent = await c.env.DB.prepare(

    `SELECT id FROM op_payment_intents WHERE token = ? LIMIT 1`
).bind(token).first<{ id: number }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Invalid checkout token' } }, 404);
  }

  if (!body.gateway_id) {
    return c.json({ success: false, error: { code: 'GATEWAY_REQUIRED', message: 'Select a payment method' } }, 400);
  }

  const service = new PaymentService(c.env);
  const result = await service.initiatePayment(intent.id, body.gateway_id);

  return c.json({ success: true, data: result });
});

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

  // Redirect to status page
  return c.redirect(`/checkout/${token}/status`);
});

// GET /checkout/{token}/status — poll status (AJAX)
checkoutRoutes.get('/:token/status', async (c) => {
  const token = c.req.param('token');

  const intent = await c.env.DB.prepare(

    `SELECT status, amount, currency FROM op_payment_intents WHERE token = ? LIMIT 1`
).bind(token).first<{ status: string; amount: string; currency: string }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
  }

  return c.json({
    success: true,
    data: { status: intent.status, amount: intent.amount, currency: intent.currency },
  });
});

function renderCheckoutHTML(opts: {
  token: string;
  amount: string;
  currency: string;
  description: string;
  status: string;
  brandName: string;
  brandColor: string;
  gateways: Array<{ id: number; slug: string; name: string }>;
}): string {
  const statusBadge = opts.status === 'completed' ? '✓ Paid' : opts.status === 'processing' ? 'Processing…' : 'Awaiting payment';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout — ${escapeHtml(opts.brandName)}</title>
<style>
:root { --brand: ${opts.brandColor}; }
body{font-family:system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#0b1f3a;margin:0;padding:1rem;min-height:100vh}
.container{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08);overflow:hidden}
.header{background:var(--brand);color:#fff;padding:1.5rem}
.header h1{margin:0;font-size:1.25rem}
.header .brand{font-size:.875rem;opacity:.85;margin-bottom:.25rem}
.body{padding:1.5rem}
.amount{font-size:2.25rem;font-weight:700;margin:.5rem 0}
.status-badge{display:inline-block;padding:.25rem .75rem;background:#fef3c7;color:#92400e;border-radius:999px;font-size:.75rem;font-weight:600;text-transform:uppercase}
.status-badge.completed{background:#d1fae5;color:#065f46}
.btn{display:block;width:100%;padding:.875rem;background:var(--brand);color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;margin-top:1rem}
.btn:hover{opacity:.9}
.btn:disabled{background:#94a3b8;cursor:not-allowed}
.description{color:#475569;font-size:.875rem;margin:.5rem 0 1rem}
.gateway-list{margin:1rem 0}
.gateway-list label{display:block;padding:.75rem 1rem;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:.5rem;cursor:pointer}
.gateway-list input{margin-right:.5rem}
.gateway-list label:hover{background:#f1f5f9}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="brand">${escapeHtml(opts.brandName)}</div>
    <h1>Checkout</h1>
  </div>
  <div class="body">
    <div class="status-badge ${opts.status === 'completed' ? 'completed' : ''}">${escapeHtml(statusBadge)}</div>
    <div class="amount">${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</div>
    <div class="description">${escapeHtml(opts.description || 'Payment for order')}</div>

    <div class="gateway-list">
      ${opts.gateways.map((gw, idx) => `
        <label><input type="radio" name="gateway_id" value="${gw.id}" ${idx === 0 ? 'checked' : ''}> ${escapeHtml(gw.name)}</label>
      `).join('')}
      ${opts.gateways.length === 0 ? '<p style="color: #dc2626;">No payment methods configured</p>' : ''}
    </div>

    <button class="btn" ${opts.gateways.length === 0 || opts.status === 'completed' ? 'disabled' : ''} onclick="initiatePayment()">Pay ${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</button>
  </div>
</div>

<script>
async function initiatePayment() {
  const selected = document.querySelector('input[name=gateway_id]:checked');
  if (!selected) { alert('Select a payment method'); return; }
  const gatewayId = parseInt(selected.value, 10);
  const res = await fetch('/checkout/${opts.token}/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gateway_id: gatewayId }),
  });
  const data = await res.json();
  if (data.success) {
    if (data.data.redirect_url) window.location = data.data.redirect_url;
    else if (data.data.form_html) document.body.innerHTML = data.data.form_html;
  } else {
    alert(data.error?.message || 'Payment initiation failed');
  }
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
