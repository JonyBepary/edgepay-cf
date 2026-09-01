/**
 * Checkout routes — /checkout/{token}, /invoice/{token}, /pay/{slug}
 *
 * Public-facing customer checkout flow. Rendered as HTML.
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../types/env';
import { PaymentService } from '../services/payment';

type CheckoutContext = Context<{ Bindings: Env; Variables: Record<string, unknown> }>;

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

// POST /checkout/{token}/verify & /submit-trx — customer submits TrxID and sender phone
const handleCustomerTrxVerify = async (c: CheckoutContext) => {
  const token = c.req.param('token');
  const body = await c.req.json<{ trx_id?: string; sender_phone?: string; amount?: string }>();

  if (!body.trx_id || typeof body.trx_id !== 'string' || body.trx_id.trim().length < 4) {
    return c.json({
      success: false,
      error: { code: 'INVALID_TRX_ID', message: 'Please enter a valid Transaction ID (at least 4 characters)' }
    }, 400);
  }

  const normalizedTrxId = body.trx_id.trim().toUpperCase();
  const senderPhone = body.sender_phone ? body.sender_phone.trim() : null;

  // Load intent & transaction
  const intent = await c.env.DB.prepare(
    `SELECT pi.id, pi.merchant_id, pi.amount, pi.currency, pi.status, pi.metadata,
            t.id AS trx_db_id, t.gateway_trx_id
     FROM op_payment_intents pi
     LEFT JOIN op_transactions t ON t.payment_intent_id = pi.id
     WHERE pi.token = ?
     LIMIT 1`
  ).bind(token).first<{
    id: number;
    merchant_id: number;
    amount: string;
    currency: string;
    status: string;
    metadata: string | null;
    trx_db_id: number | null;
    gateway_trx_id: string | null;
  }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Invalid checkout token' } }, 404);
  }

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
    // Exact amount verification
    const { cmp } = await import('../lib/money');
    if (matchingSms.parsed_amount && cmp(matchingSms.parsed_amount, intent.amount) !== 0) {
      return c.json({
        success: false,
        error: {
          code: 'AMOUNT_MISMATCH',
          message: `The payment received for TrxID ${normalizedTrxId} (Tk ${matchingSms.parsed_amount}) does not match the order amount (Tk ${intent.amount}).`
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
    `SELECT pi.status, pi.amount, pi.currency, t.gateway_trx_id
     FROM op_payment_intents pi
     LEFT JOIN op_transactions t ON t.payment_intent_id = pi.id
     WHERE pi.token = ? LIMIT 1`
  ).bind(token).first<{ status: string; amount: string; currency: string; gateway_trx_id: string | null }>();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
  }

  return c.json({
    success: true,
    data: {
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      trx_id: intent.gateway_trx_id ?? null,
    },
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
      <div class="brand-name">${escapeHtml(opts.brandName)}</div>
      <div class="order-amount">${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</div>
    </div>
    <div class="checkout-body">
      <div class="status-pill" id="statusBadge">Awaiting Payment</div>
      <div class="description">${escapeHtml(opts.description || 'Secure Online Order')}</div>

      <div id="feedbackBox" class="feedback-banner"></div>

      <div class="section-label">1. Select Payment Method</div>
      <div class="gateway-list">
        ${opts.gateways.map((gw, idx) => `
          <label class="gateway-option ${idx === 0 ? 'selected' : ''}" onclick="selectGateway(this, ${gw.id}, '${escapeHtml(gw.account_number || '')}', '${escapeHtml(gw.instructions || '')}', '${escapeHtml(gw.type)}')">
            <div class="gw-left">
              <input type="radio" name="gateway_id" value="${gw.id}" ${idx === 0 ? 'checked' : ''} style="display:none">
              <span>${escapeHtml(gw.name)}</span>
            </div>
            <span style="font-size: 0.8125rem; color: #64748b;">${escapeHtml(gw.type.toUpperCase())}</span>
          </label>
        `).join('')}
        ${opts.gateways.length === 0 ? '<p style="color: #dc2626;">No active payment methods configured</p>' : ''}
      </div>

      <div id="mfsDetails" class="mfs-info-card">
        <div style="font-weight: 700; color: #0f172a; margin-bottom: 0.25rem;">2. How to Pay:</div>
        <ol class="steps-list">
          <li>Open your mobile banking app (bKash / Nagad / Rocket).</li>
          <li>Choose <strong>Send Money</strong> and transfer <strong>${escapeHtml(opts.currency)} ${escapeHtml(opts.amount)}</strong> to:</li>
        </ol>
        <div class="copy-row">
          <span id="mfsAccount"></span>
          <button class="copy-btn" onclick="copyAccount()">Copy Number</button>
        </div>
        <div id="mfsInstructions" style="color: #64748b; font-size: 0.8125rem; margin-bottom: 1rem;"></div>

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
      </div>
    </div>
  `}
</div>

<script>
let currentGatewayId = ${opts.gateways[0]?.id || 0};
let pollInterval = null;

function selectGateway(el, id, accountNumber, instructions, type) {
  document.querySelectorAll('.gateway-option').forEach(g => g.classList.remove('selected'));
  el.classList.add('selected');
  el.querySelector('input').checked = true;
  currentGatewayId = id;

  const mfsBox = document.getElementById('mfsDetails');
  if (accountNumber || type === 'manual') {
    mfsBox.style.display = 'block';
    document.getElementById('mfsAccount').innerText = accountNumber || 'Contact Merchant';
    document.getElementById('mfsInstructions').innerText = instructions || 'Send exact payment amount to this personal account number.';
  } else {
    mfsBox.style.display = 'block';
  }
}

// Initialize default gateway
${opts.gateways[0]?.account_number ? `
selectGateway(document.querySelector('.gateway-option'), ${opts.gateways[0].id}, '${escapeHtml(opts.gateways[0].account_number || '')}', '${escapeHtml(opts.gateways[0].instructions || '')}', '${escapeHtml(opts.gateways[0].type)}');
` : ''}

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

  try {
    const res = await fetch('/checkout/${opts.token}/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

