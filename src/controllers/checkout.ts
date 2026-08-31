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

  // Load active gateways for this merchant with manual gateway instructions
  let gateways: Array<{ id: number; slug: string; name: string; type: string; account_number?: string | null; instructions?: string | null }> = [];
  if (intent.gateway_id) {
    const gw = await c.env.DB.prepare(
      `SELECT g.id, g.slug, g.name, g.type, m.account_number, m.instructions
       FROM op_gateways g
       LEFT JOIN op_manual_gateways m ON m.gateway_id = g.id
       WHERE g.id = ? AND g.merchant_id = ? AND g.status = 'active' LIMIT 1`,
    ).bind(intent.gateway_id, intent.merchant_id).first<{ id: number; slug: string; name: string; type: string; account_number?: string | null; instructions?: string | null }>();
    if (gw) gateways = [gw];
  } else {
    const gws = await c.env.DB.prepare(
      `SELECT g.id, g.slug, g.name, g.type, m.account_number, m.instructions
       FROM op_gateways g
       LEFT JOIN op_manual_gateways m ON m.gateway_id = g.id
       WHERE g.merchant_id = ? AND g.status = 'active' ORDER BY g.priority ASC, g.id ASC`,
    ).bind(intent.merchant_id).all<{ id: number; slug: string; name: string; type: string; account_number?: string | null; instructions?: string | null }>();
    gateways = gws.results ?? [];
  }

  // Render checkout HTML
  const merchant = c.get('merchant') as { name?: string; color?: string } | null;
  const brandName = merchant?.name ?? 'EdgePay';
  const brandColor = merchant?.color ?? '#0052cc';

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
  gateways: Array<{ id: number; slug: string; name: string; type: string; account_number?: string | null; instructions?: string | null }>;
}): string {
  const isCompleted = opts.status === 'completed';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secure Checkout — ${escapeHtml(opts.brandName)}</title>
<style>
:root {
  --primary: ${opts.brandColor};
  --primary-hover: #0043a8;
  --bg: #f8fafc;
  --card-bg: #ffffff;
  --text-main: #0f172a;
  --text-muted: #64748b;
  --border: #e2e8f0;
  --success: #10b981;
  --success-bg: #ecfdf5;
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
  max-width: 460px;
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
  background: #f1f5f9;
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 1.25rem;
  font-size: 0.875rem;
}
.copy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  margin-top: 0.5rem;
  font-family: monospace;
  font-weight: 700;
  font-size: 1rem;
}
.copy-btn {
  background: #e2e8f0;
  border: none;
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.copy-btn:hover { background: #cbd5e1; }
.btn-pay {
  width: 100%;
  padding: 0.875rem;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s, transform 0.05s;
}
.btn-pay:hover { opacity: 0.95; }
.btn-pay:active { transform: scale(0.99); }
.btn-pay:disabled { background: #94a3b8; cursor: not-allowed; transform: none; }
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
  margin-top: 1rem;
}
</style>
</head>
<body>

<div class="checkout-card" id="card">
  ${isCompleted ? `
    <div class="success-screen">
      <div class="success-icon">✓</div>
      <h2 style="font-size: 1.5rem; font-weight: 800; margin-bottom: 0.5rem; color: #065f46;">Payment Successful!</h2>
      <p style="color: #64748b; margin-bottom: 1.5rem;">Your payment of <strong>${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</strong> has been verified.</p>
      <div class="status-pill completed">Completed</div>
    </div>
  ` : `
    <div class="checkout-header">
      <div class="brand-name">${escapeHtml(opts.brandName)}</div>
      <div class="order-amount">${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</div>
    </div>
    <div class="checkout-body">
      <div class="status-pill" id="statusBadge">Awaiting Payment</div>
      <div class="description">${escapeHtml(opts.description || 'Secure Online Order')}</div>

      <div class="section-label">Select Payment Method</div>
      <div class="gateway-list">
        ${opts.gateways.map((gw, idx) => `
          <label class="gateway-option ${idx === 0 ? 'selected' : ''}" onclick="selectGateway(this, ${gw.id}, '${escapeHtml(gw.account_number || '')}', '${escapeHtml(gw.instructions || '')}')">
            <div class="gw-left">
              <input type="radio" name="gateway_id" value="${gw.id}" ${idx === 0 ? 'checked' : ''} style="display:none">
              <span>${escapeHtml(gw.name)}</span>
            </div>
            <span style="font-size: 0.8125rem; color: #64748b;">${escapeHtml(gw.type.toUpperCase())}</span>
          </label>
        `).join('')}
        ${opts.gateways.length === 0 ? '<p style="color: #dc2626;">No active payment methods configured</p>' : ''}
      </div>

      <div id="mfsDetails" class="mfs-info-card" style="display: none;">
        <div style="font-weight: 600; margin-bottom: 0.25rem;">Payment Instructions:</div>
        <div id="mfsInstructions" style="color: #475569; margin-bottom: 0.5rem;"></div>
        <div class="copy-row">
          <span id="mfsAccount">01815300789</span>
          <button class="copy-btn" onclick="copyAccount()">Copy Number</button>
        </div>
      </div>

      <button id="payBtn" class="btn-pay" ${opts.gateways.length === 0 ? 'disabled' : ''} onclick="initiatePayment()">Pay ${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</button>

      <div class="footer-secure">
        🔒 Protected by EdgePay Cloudflare Zero-Trust Ledger
      </div>
    </div>
  `}
</div>

<script>
let currentGatewayId = ${opts.gateways[0]?.id || 0};
let pollInterval = null;

function selectGateway(el, id, accountNumber, instructions) {
  document.querySelectorAll('.gateway-option').forEach(g => g.classList.remove('selected'));
  el.classList.add('selected');
  el.querySelector('input').checked = true;
  currentGatewayId = id;

  const mfsBox = document.getElementById('mfsDetails');
  if (accountNumber) {
    mfsBox.style.display = 'block';
    document.getElementById('mfsAccount').innerText = accountNumber;
    document.getElementById('mfsInstructions').innerText = instructions || 'Send payment to this personal account number';
  } else {
    mfsBox.style.display = 'none';
  }
}

// Initialize first selected gateway instructions
${opts.gateways[0]?.account_number ? `
selectGateway(document.querySelector('.gateway-option'), ${opts.gateways[0].id}, '${escapeHtml(opts.gateways[0].account_number || '')}', '${escapeHtml(opts.gateways[0].instructions || '')}');
` : ''}

function copyAccount() {
  const num = document.getElementById('mfsAccount').innerText;
  navigator.clipboard.writeText(num).then(() => {
    alert('Account number copied to clipboard: ' + num);
  });
}

async function initiatePayment() {
  const btn = document.getElementById('payBtn');
  btn.disabled = true;
  btn.innerText = 'Processing...';

  try {
    const res = await fetch('/checkout/${opts.token}/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateway_id: currentGatewayId }),
    });
    const data = await res.json();
    if (data.success) {
      if (data.data.redirect_url) {
        window.location = data.data.redirect_url;
      } else if (data.data.form_html) {
        document.body.innerHTML = data.data.form_html;
      } else {
        document.getElementById('statusBadge').innerText = 'Awaiting Confirmation...';
        startPolling();
      }
    } else {
      alert(data.error?.message || 'Payment initiation failed');
      btn.disabled = false;
      btn.innerText = 'Pay ${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}';
    }
  } catch (err) {
    alert('Network error initiating payment');
    btn.disabled = false;
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
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

