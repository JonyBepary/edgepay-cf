/**
 * EdgePay Customer Checkout Island — Client Data Hydration & Motion
 * Framework: Astro Island Client Component
 * 100% Dynamic Data: Hydrates from live EdgePay API only. No demo fallbacks.
 *
 * Data sources (all live):
 *   - GET /checkout/:token            (Accept: application/json) checkout session
 *   - GET /api/v1/gateways            enabled-only payment rails (Bearer when available)
 *   - POST /checkout/:token/submit-trx  customer TrxID corroboration
 *     (falls back to POST /checkout/:token/verify — same handler)
 *   - GET /checkout/:token/status      poll while awaiting carrier SMS
 */

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 20;

function getApiKey(container) {
  return (
    container.dataset.apiKey ||
    window.localStorage.getItem('edgepay_api_key') ||
    ''
  );
}

function authHeaders(container) {
  const key = getApiKey(container);
  const h = { Accept: 'application/json' };
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

function emptyState(message, hint) {
  return `
    <div class="checkout-card" style="padding: 36px 24px; text-align: center;">
      <div style="font-size: 13px; color: var(--muted); margin-bottom: 8px;">${escapeHtml(message)}</div>
      ${hint ? `<div class="epx-mono" style="font-size: 12px; font-weight: 600;">${escapeHtml(hint)}</div>` : ''}
    </div>
  `;
}

function inlineError(container, message) {
  let el = container.querySelector('#island-form-error');
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  el.textContent = message;
}

export async function initCheckoutIsland() {
  const container = document.getElementById('checkout-island') || document.getElementById('app');
  if (!container) return;

  // 1. Read initial attributes (server dataset or ?token=)
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token') || container.dataset.token || '';
  const apiOrigin = container.dataset.apiOrigin || '';

  // Render initial loading state
  container.innerHTML = `
    <div class="checkout-card" style="padding: 32px 24px; text-align: center;">
      <div style="font-size: 13px; color: var(--muted); margin-bottom: 8px;">Loading live checkout session...</div>
      <div class="epx-mono" style="font-size: 14px; font-weight: 600;">Connecting to EdgePay Edge...</div>
    </div>
  `;

  if (!token) {
    container.innerHTML = emptyState(
      'No checkout session found.',
      'Ask the merchant for a fresh payment link.'
    );
    return;
  }

  // 2. Load live checkout session (amount / currency / merchant / rails)
  let session = null;
  try {
    const sessionRes = await fetch(`${apiOrigin}/checkout/${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
    });
    if (sessionRes.ok) {
      session = await sessionRes.json();
    } else {
      container.innerHTML = emptyState(
        'This checkout link is invalid or expired.',
        'Ask the merchant for a fresh payment link.'
      );
      return;
    }
  } catch {
    container.innerHTML = emptyState(
      'Checkout is unreachable right now.',
      'Check your connection and try again.'
    );
    return;
  }

  let amount = session.amount_minor != null ? String(Number(session.amount_minor) / 100) : (session.amount || '');
  let currency = session.currency || container.dataset.currency || 'BDT';
  let merchantName = session.merchant || container.dataset.merchant || '';
  let orderId = session.order_id || session.orderId || container.dataset.orderId || '';
  let sessionGateways = Array.isArray(session.rails) ? session.rails : [];
  let sessionStatus = session.status || '';

  if (sessionStatus === 'completed') {
    container.innerHTML = emptyState('This payment is already completed.', orderId ? `Order #${orderId}` : '');
    return;
  }

  if (!amount) {
    container.innerHTML = emptyState(
      'This checkout session has no amount.',
      'Ask the merchant for a fresh payment link.'
    );
    return;
  }

  // 3. Load enabled-only gateway catalog
  let gateways = [];
  try {
    const gwRes = await fetch(`${apiOrigin}/api/v1/gateways`, {
      headers: authHeaders(container),
    });
    if (gwRes.ok) {
      const gwJson = await gwRes.json();
      const enabled = gwJson?.data?.enabled || gwJson?.enabled || [];
      gateways = enabled.map((g) => ({
        slug: g.slug,
        name: g.name,
        type: g.type || (String(g.slug || '').includes('api') ? 'api' : 'manual'),
        account_number: g.account_number || '',
      }));
    }
  } catch {
    // Falls through to the empty-state below — never to hardcoded rails.
  }

  // Prefer session rails when the session names a subset of enabled gateways.
  if (sessionGateways.length > 0 && gateways.length > 0) {
    const wanted = new Set(sessionGateways.map((s) => String(s).toLowerCase()));
    const subset = gateways.filter((g) => wanted.has(String(g.slug).toLowerCase()));
    if (subset.length > 0) gateways = subset;
  }

  if (gateways.length === 0) {
    container.innerHTML = emptyState(
      'No payment rails are available for this checkout.',
      'Please try again later or contact the merchant.'
    );
    return;
  }

  const activeGateways = gateways;
  let selectedRail = activeGateways[0];
  const currencySymbol = currency === 'BDT' ? '৳' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency;

  // 4. Render Full Interactive Island Markup
  container.innerHTML = `
    <div class="checkout-card">
      <div class="checkout-steps">
        <span id="chk-step-bar-1" class="done"></span>
        <span id="chk-step-bar-2"></span>
        <span id="chk-step-bar-3"></span>
      </div>

      <!-- Step 1: Rail Selection -->
      <div id="chk-step-1" style="padding: 20px 24px 26px;">
        <div style="font-size: 12px; color: var(--muted); margin-bottom: 2px;" id="island-merchant-name">${escapeHtml(merchantName)}</div>
        <div class="checkout-amount epx-serif" id="island-amount">${currencySymbol}${parseFloat(amount).toFixed(2)}</div>
        <div style="font-size: 12px; color: var(--muted); margin: 2px 0 20px;">Order #${escapeHtml(orderId)} · Live Checkout Session</div>

        <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">Choose how to pay</div>
        <div id="island-methods-container">
          ${activeGateways.map((g, idx) => {
            const isSel = idx === 0;
            const color = g.slug.includes('bkash') ? 'var(--bkash, #D6296B)' : g.slug.includes('nagad') ? 'var(--nagad, #EA7A1C)' : g.slug.includes('rocket') ? 'var(--rocket, #6D3FA0)' : 'var(--card, #3A424B)';
            const code = g.slug.slice(0, 2).toUpperCase();
            return `
              <div class="method ${isSel ? 'is-selected' : ''}" data-slug="${escapeHtml(g.slug)}" style="cursor: pointer;">
                <div class="method__icon" style="background: ${color}; color: #fff;">${code}</div>
                <div>
                  <div style="font-size: 13.5px; font-weight: 600;">${escapeHtml(g.name)}</div>
                  <div style="font-size: 11.5px; color: var(--muted);">${g.type === 'manual' ? 'Personal Send Money' : 'Instant Gateway Card / Wallet'}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <button id="btn-chk-continue" class="btn btn--accent" style="width: 100%; justify-content: center; margin-top: 16px; padding: 12px 0; font-size: 14px;">Continue</button>
        <div style="display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; font-size: 11.5px; color: var(--muted);">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Secured by EdgePay · Cloudflare Edge
        </div>
      </div>

      <!-- Step 2: Send Money & TrxID Entry -->
      <div id="chk-step-2" style="padding: 20px 24px 26px; display: none;">
        <button id="btn-chk-back" style="background: none; border: none; display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); cursor: pointer; padding: 0; margin-bottom: 14px; font-family: inherit;">
          ← Back
        </button>
        <div class="card card-pad" style="margin-bottom: 16px; background: #FBF3E6; border-color: #EAD3A5;">
          <div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">Send exactly</div>
          <div class="epx-mono" style="font-size: 22px; font-weight: 700;">${currencySymbol}${parseFloat(amount).toFixed(2)}</div>
          <div style="font-size: 12px; color: var(--muted); margin: 8px 0 4px;">To this <span id="island-target-rail">${escapeHtml(selectedRail.name)}</span> number</div>
          <div class="epx-mono" id="island-target-phone" style="font-size: 16px; font-weight: 700; color: var(--ink);">${escapeHtml(selectedRail.account_number || '—')}</div>
        </div>
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">Then confirm your payment</div>
        <div id="island-form-error" style="display: none; font-size: 12.5px; color: #9E2A2B; background: #F7D7D4; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px;"></div>
        <div class="field">
          <label>Transaction ID from confirmation SMS</label>
          <input id="inp-trxid" placeholder="e.g. BL9A4K8M10" class="epx-mono" style="font-weight: 600; text-transform: uppercase;">
        </div>
        <div class="field" style="margin-top: 12px;">
          <label>Number you sent from</label>
          <input id="inp-sender" placeholder="017XX-XXXXXX" class="epx-mono">
        </div>
        <div id="island-awaiting-note" style="display: none; font-size: 12.5px; color: #8A5A0F; background: #F3E3C7; border-radius: 8px; padding: 8px 12px; margin-top: 12px;"></div>
        <button id="btn-chk-verify" class="btn btn--accent" style="width: 100%; justify-content: center; margin-top: 18px; padding: 12px 0; font-size: 14px;">Verify payment</button>
      </div>

      <!-- Step 3: Confirmation Receipt -->
      <div id="chk-step-3" style="padding: 36px 24px 28px; text-align: center; display: none;">
        <div style="width: 56px; height: 56px; border-radius: 50%; background: var(--teal-bg, #DCEEE8); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--teal-text, #0B6E5C)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 4px;">Payment confirmed</div>
        <p style="font-size: 13px; color: var(--muted); margin: 0 0 20px;" id="island-receipt-msg">${escapeHtml(merchantName)} has received your payment submission.</p>
        <div class="card card-pad" style="text-align: left; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px;"><span style="color: var(--muted);">Amount</span><span class="epx-mono" style="font-weight: 600;">${currencySymbol}${parseFloat(amount).toFixed(2)}</span></div>
          <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px;"><span style="color: var(--muted);">Paid via</span><span style="font-weight: 600;" id="island-receipt-rail">${escapeHtml(selectedRail.name)}</span></div>
          <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px;"><span style="color: var(--muted);">Reference</span><span class="epx-mono" style="font-weight: 600;" id="island-receipt-ref">—</span></div>
        </div>
        <button id="btn-chk-reset" class="btn btn--primary" style="width: 100%; justify-content: center; padding: 12px 0; font-size: 14px;">Return to Merchant</button>
      </div>
    </div>
  `;

  // 5. Interactive Event Wiring
  const step1 = document.getElementById('chk-step-1');
  const step2 = document.getElementById('chk-step-2');
  const step3 = document.getElementById('chk-step-3');
  const bar1 = document.getElementById('chk-step-bar-1');
  const bar2 = document.getElementById('chk-step-bar-2');
  const bar3 = document.getElementById('chk-step-bar-3');

  function setStep(s) {
    if (step1) step1.style.display = s === 1 ? 'block' : 'none';
    if (step2) step2.style.display = s === 2 ? 'block' : 'none';
    if (step3) step3.style.display = s === 3 ? 'block' : 'none';
    if (bar1) bar1.className = s >= 1 ? 'done' : '';
    if (bar2) bar2.className = s >= 2 ? 'done' : '';
    if (bar3) bar3.className = s >= 3 ? 'done' : '';
  }

  function showReceipt(trxId) {
    const refEl = document.getElementById('island-receipt-ref');
    const msgEl = document.getElementById('island-receipt-msg');
    if (refEl) refEl.textContent = trxId;
    if (msgEl) msgEl.textContent = `${merchantName} has confirmed your payment (${trxId}).`;
    setStep(3);
  }

  async function pollStatus(submittedTrxId, attemptsLeft) {
    if (attemptsLeft <= 0) return;
    try {
      const statusRes = await fetch(`${apiOrigin}/checkout/${encodeURIComponent(token)}/status`, {
        headers: { Accept: 'application/json' },
      });
      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        const status = statusJson?.data?.status || statusJson?.status || '';
        if (status === 'completed') {
          showReceipt(statusJson?.data?.trx_id || statusJson?.trx_id || submittedTrxId);
          return;
        }
      }
    } catch {
      // Transient — keep polling until attempts run out.
    }
    setTimeout(() => pollStatus(submittedTrxId, attemptsLeft - 1), POLL_INTERVAL_MS);
  }

  async function submitTrx(path, payload) {
    const res = await fetch(`${apiOrigin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    return { res, json };
  }

  // Method selection
  container.querySelectorAll('#island-methods-container .method').forEach(el => {
    el.addEventListener('click', () => {
      container.querySelectorAll('#island-methods-container .method').forEach(m => m.classList.remove('is-selected'));
      el.classList.add('is-selected');
      const slug = el.dataset.slug;
      const found = activeGateways.find(x => x.slug === slug);
      if (found) {
        selectedRail = found;
        const targetRail = document.getElementById('island-target-rail');
        const targetPhone = document.getElementById('island-target-phone');
        const receiptRail = document.getElementById('island-receipt-rail');
        if (targetRail) targetRail.textContent = found.name;
        if (targetPhone) targetPhone.textContent = found.account_number || '—';
        if (receiptRail) receiptRail.textContent = found.name;
      }
    });
  });

  document.getElementById('btn-chk-continue')?.addEventListener('click', () => setStep(2));
  document.getElementById('btn-chk-back')?.addEventListener('click', () => setStep(1));
  document.getElementById('btn-chk-reset')?.addEventListener('click', () => setStep(1));

  document.getElementById('btn-chk-verify')?.addEventListener('click', async () => {
    const trxInp = document.getElementById('inp-trxid');
    const senderInp = document.getElementById('inp-sender');
    const verifyBtn = document.getElementById('btn-chk-verify');
    const awaitingNote = document.getElementById('island-awaiting-note');
    inlineError(container, '');
    if (awaitingNote) awaitingNote.style.display = 'none';

    const trxId = (trxInp?.value || '').trim().toUpperCase();
    const senderPhone = (senderInp?.value || '').trim();

    if (trxId.length < 4) {
      inlineError(container, 'Enter the Transaction ID from your payment confirmation message (at least 4 characters).');
      return;
    }

    if (verifyBtn) {
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying…';
    }

    const payload = { trx_id: trxId, sender_phone: senderPhone || undefined };
    try {
      // Primary: submit-trx corroboration endpoint; fallback: verify alias.
      let { res, json } = await submitTrx(`/checkout/${encodeURIComponent(token)}/submit-trx`, payload);
      if (res.status === 404) {
        ({ res, json } = await submitTrx(`/checkout/${encodeURIComponent(token)}/verify`, payload));
      }

      if (json?.success && json?.data) {
        const status = json.data.status;
        const returnedTrx = json.data.trx_id || trxId;
        if (status === 'completed') {
          showReceipt(returnedTrx);
        } else {
          // awaiting_sms / processing — record the claim, stay on step 2, poll.
          if (awaitingNote) {
            awaitingNote.style.display = 'block';
            awaitingNote.textContent =
              json.data.message ||
              `Transaction ${returnedTrx} recorded — waiting for carrier SMS confirmation. This page updates automatically.`;
          }
          pollStatus(returnedTrx, POLL_MAX_ATTEMPTS);
        }
      } else {
        const code = json?.error?.code || '';
        const message =
          json?.error?.message ||
          (res.status === 404 ? 'This checkout link is invalid or expired.' : 'Verification failed — please check the Transaction ID and try again.');
        if (code === 'TRX_ALREADY_USED') {
          inlineError(container, 'This Transaction ID was already used for another payment.');
        } else if (code === 'AMOUNT_MISMATCH') {
          inlineError(container, 'The payment received does not match the order amount.');
        } else {
          inlineError(container, message);
        }
      }
    } catch {
      inlineError(container, 'Verification is unreachable right now — check your connection and try again.');
    } finally {
      if (verifyBtn) {
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify payment';
      }
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Auto-hydrate on import or DOMContentLoaded
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCheckoutIsland);
  } else {
    initCheckoutIsland();
  }
}
