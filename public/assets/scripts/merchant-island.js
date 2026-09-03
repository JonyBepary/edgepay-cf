/**
 * EdgePay Merchant Operations Island — Client Data Hydration & Motion
 * Framework: Astro Island Client Component
 * 100% Dynamic Data: Hydrates from the live EdgePay merchant API only.
 * No demo fallbacks — fetch failures render empty states.
 *
 * Data sources (all live, Bearer API key):
 *   - GET  /api/v1/merchant/summary        dashboard stats (graceful 404 fallback
 *                                          to client-side aggregation)
 *   - GET  /api/v1/gateways                enabled-only payment rails
 *   - GET  /api/v1/transactions?limit=20   recent ledger transactions
 *   - POST /api/v1/payments                create payment intent (idempotency key)
 *   - GET  /api/v1/api-keys                list API keys (admin scope)
 *   - POST /api/v1/api-keys                create API key (admin scope)
 *   - DELETE /api/v1/api-keys/:id          revoke API key
 *   - POST   /api/v1/api-keys/:id/rotate   rotate API key
 *   - GET  /api/v1/webhooks                list webhook endpoints
 *   - POST /api/v1/webhooks                register webhook endpoint
 *   - DELETE /api/v1/webhooks/:id          delete webhook endpoint
 *   - GET  /api/v1/webhooks/deliveries     recent webhook deliveries
 *   - POST /api/v1/webhooks/tests          send test webhook event
 *   - POST /api/v1/webhooks/deliveries/:id/retry  retry a failed delivery
 */

const API_KEY_STORAGE_KEYS = ['edgepay_api_key', 'edgepay_merchant_key'];

function getApiKey(container) {
  if (container.dataset.apiKey) return container.dataset.apiKey;
  for (const k of API_KEY_STORAGE_KEYS) {
    const v = window.localStorage.getItem(k);
    if (v) return v;
  }
  return '';
}

function setApiKey(key) {
  window.localStorage.setItem(API_KEY_STORAGE_KEYS[0], key);
}

function authHeaders(container, extra) {
  const key = getApiKey(container);
  const h = { Accept: 'application/json', ...(extra || {}) };
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

function emptyRow(cols, message, hint) {
  return `<tr><td colspan="${cols}" style="text-align: center; color: #5B6470; padding: 24px 12px;">${escapeHtml(message)}${hint ? `<br><span style="font-size:12px;">${escapeHtml(hint)}</span>` : ''}</td></tr>`;
}

function errorRow(cols, message) {
  return `<tr><td colspan="${cols}" style="text-align: center; color: #9E2A2B; padding: 24px 12px;">${escapeHtml(message)}</td></tr>`;
}

async function getJson(url, container, options) {
  const res = await fetch(url, {
    ...(options || {}),
    headers: authHeaders(container, (options && options.headers) || {}),
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

export async function initMerchantIsland() {
  const container = document.getElementById('merchant-island') || document.getElementById('merchant-app');
  if (!container) return;

  const apiOrigin = container.dataset.apiOrigin || '';
  let merchantName = container.dataset.merchant || '';

  // Initial loading state
  container.innerHTML = `
    <div style="padding: 40px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="font-size: 14px; color: #5B6470; margin-bottom: 8px;">Connecting to EdgePay Merchant API...</div>
      <div style="font-weight: 600; font-family: monospace;">Loading live merchant telemetry...</div>
    </div>
  `;

  // Fetch live data from the EdgePay merchant API (Bearer).
  let gateways = [];
  let transactions = [];
  let summary = null;
  let apiKeys = null;
  let webhooks = null;
  let deliveries = null;
  let fetchError = '';
  let unauthorized = false;

  try {
    const [summaryR, gatewaysR, trxsR, keysR, hooksR, deliveriesR] = await Promise.all([
      getJson(`${apiOrigin}/api/v1/merchant/summary`, container).catch(() => null),
      getJson(`${apiOrigin}/api/v1/gateways`, container).catch(() => null),
      getJson(`${apiOrigin}/api/v1/transactions?limit=20`, container).catch(() => null),
      getJson(`${apiOrigin}/api/v1/api-keys`, container).catch(() => null),
      getJson(`${apiOrigin}/api/v1/webhooks`, container).catch(() => null),
      getJson(`${apiOrigin}/api/v1/webhooks/deliveries?limit=50`, container).catch(() => null),
    ]);

    for (const r of [summaryR, gatewaysR, trxsR, keysR, hooksR, deliveriesR]) {
      if (r && (r.res.status === 401 || r.res.status === 403)) unauthorized = true;
    }

    if (summaryR?.res.ok && summaryR.json?.success) summary = summaryR.json.data;
    if (gatewaysR?.res.ok && gatewaysR.json?.success) {
      gateways = (gatewaysR.json.data?.enabled || []).filter((g) => g && g.slug);
    }
    if (trxsR?.res.ok && trxsR.json?.success) {
      transactions = trxsR.json.data || [];
    }
    if (keysR?.res.ok && keysR.json?.success) apiKeys = keysR.json.data || [];
    if (hooksR?.res.ok && hooksR.json?.success) webhooks = hooksR.json.data || [];
    if (deliveriesR?.res.ok && deliveriesR.json?.success) deliveries = deliveriesR.json.data || [];

    if (!gatewaysR?.res.ok && !trxsR?.res.ok && !summaryR?.res.ok) {
      fetchError = unauthorized
        ? 'Merchant API rejected the request (401/403). Set a valid API key below in Developers.'
        : 'Merchant API is unreachable. Check your connection and try again.';
    }
  } catch (err) {
    console.warn('Live merchant data fetch error:', err);
    fetchError = 'Merchant API is unreachable. Check your connection and try again.';
  }

  merchantName = merchantName || summary?.merchant_name || 'EdgePay Merchant';

  // Stats: prefer the summary endpoint; otherwise aggregate live transactions.
  let stats = { todayVolume: '0.00', trxCount: 0, pendingCount: 0 };
  if (summary) {
    stats = {
      todayVolume: String(summary.today_volume ?? summary.todayVolume ?? '0.00'),
      trxCount: Number(summary.trx_count ?? summary.trxCount ?? transactions.length ?? 0),
      pendingCount: Number(summary.pending_count ?? summary.pendingCount ?? 0),
    };
  } else if (transactions.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    let vol = 0;
    let pending = 0;
    for (const t of transactions) {
      const amt = parseFloat(t.amount || 0) || 0;
      if ((t.status === 'completed') && String(t.created_at || '').slice(0, 10) === today) vol += amt;
      if (t.status === 'pending' || t.status === 'processing' || t.status === 'awaiting_verification') pending += 1;
    }
    stats = { todayVolume: vol.toFixed(2), trxCount: transactions.length, pendingCount: pending };
  }

  const trxRows = fetchError && transactions.length === 0
    ? errorRow(5, fetchError)
    : transactions.length === 0
      ? emptyRow(5, 'No transactions yet.', 'Create a payment intent to open a live checkout session.')
      : transactions.map(t => {
          const badgeBg = t.status === 'completed' ? '#DCEEE8' : (t.status === 'pending' || t.status === 'processing' || t.status === 'awaiting_verification') ? '#F3E3C7' : '#F7D7D4';
          const badgeColor = t.status === 'completed' ? '#0B6E5C' : (t.status === 'pending' || t.status === 'processing' || t.status === 'awaiting_verification') ? '#8A5A0F' : '#9E2A2B';
          const timeStr = t.created_at ? new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'just now';
          return `
            <tr style="border-bottom: 1px solid #ECEEE8;">
              <td class="epx-mono" style="padding: 12px 14px; font-weight: 600;">${escapeHtml(t.trx_id || t.uuid?.slice(0, 16) || 'trx_' + t.id)}</td>
              <td style="padding: 12px 14px;">${escapeHtml(t.payment_method || t.gateway_slug || '—')}</td>
              <td class="epx-mono" style="padding: 12px 14px;">৳${parseFloat(t.amount || 0).toFixed(2)}</td>
              <td style="padding: 12px 14px;"><span style="background: ${badgeBg}; color: ${badgeColor}; padding: 3px 10px; border-radius: 20px; font-weight: 600; font-size: 11px;">${escapeHtml(t.status)}</span></td>
              <td class="epx-mono" style="padding: 12px 14px; color: #5B6470; font-size: 12px;">${timeStr}</td>
            </tr>
          `;
        }).join('');

  const gwCards = fetchError && gateways.length === 0
    ? `<div style="color: #9E2A2B; font-size: 13px; padding: 12px 4px;">${escapeHtml(fetchError)}</div>`
    : gateways.length === 0
      ? `<div style="color: #5B6470; font-size: 13px; padding: 12px 4px;">No payment rails enabled on this deployment. Contact the platform admin.</div>`
      : gateways.map(g => `
          <div class="gw-card" style="border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px; margin-bottom: 12px; background: #FFF; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <div style="font-weight: 600; font-size: 14px;">${escapeHtml(g.name || g.slug)}</div>
              <div style="font-size: 12px; color: #5B6470; margin-top: 3px;">
                ${g.account_number ? `Receiver number: ${escapeHtml(g.account_number)}` : escapeHtml(g.description || 'Cloudflare Edge gateway rail')}
              </div>
            </div>
            <span style="background: #DCEEE8; color: #0B6E5C; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 20px;">active</span>
          </div>
        `).join('');

  // Render Full Merchant Island Layout
  container.innerHTML = `
    <div class="app-shell" style="display: flex; min-height: 100vh;">
      <aside class="app-sidebar" style="width: 220px; flex-shrink: 0; background: #FFFFFF; border-right: 1px solid #D8DCD2; padding: 22px 14px; display: flex; flex-direction: column; gap: 4px;">
        <div class="app-sidebar__brand" style="font-weight: 700; font-size: 16px; padding: 0 10px 20px; line-height: 1.3;">
          ${escapeHtml(merchantName)}
          <small style="font-size: 11px; font-weight: 400; color: #5B6470; display: block; margin-top: 2px;">EdgePay Merchant Console</small>
        </div>
        <button class="nav-item active" id="mer-nav-dashboard" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 600; background: #12181F; color: #EEF1EA; border: none; cursor: pointer; text-align: left;">
          Dashboard
        </button>
        <button class="nav-item" id="mer-nav-gateways" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; background: transparent; border: none; cursor: pointer; text-align: left;">
          Gateways
        </button>
        <button class="nav-item" id="mer-nav-pairing" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; background: transparent; border: none; cursor: pointer; text-align: left;">
          Mobile pairing
        </button>
        <button class="nav-item" id="mer-nav-developers" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; background: transparent; border: none; cursor: pointer; text-align: left;">
          Developers
        </button>
      </aside>

      <main class="app-main" style="flex: 1; padding: 28px 32px; overflow-y: auto;">
        <!-- Tab 1: Dashboard -->
        <div id="mer-tab-dashboard">
          <div class="page-head" style="margin-bottom: 22px;">
            <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Dashboard</h2>
            <p style="font-size: 13px; color: #5B6470; margin-top: 3px;">Live ledger volume and transaction activity from the Merchant API</p>
          </div>
          <div id="island-mer-status" style="display: ${fetchError ? 'block' : 'none'}; font-size: 13px; color: #9E2A2B; background: #F7D7D4; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;">${escapeHtml(fetchError)}</div>
          <div class="stat-row" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 22px;">
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Today's volume</div>
              <div class="epx-mono" style="font-size: 22px; font-weight: 600;">৳${Number(stats.todayVolume).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
            </div>
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Transactions</div>
              <div class="epx-mono" style="font-size: 22px; font-weight: 600;">${stats.trxCount}</div>
            </div>
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Awaiting SMS</div>
              <div class="epx-mono" style="font-size: 22px; font-weight: 600;">${stats.pendingCount}</div>
            </div>
          </div>
          <div class="card card-pad" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 18px 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
              <div style="font-size: 13px; font-weight: 600;">Recent transactions</div>
              <button id="btn-mer-create-intent" class="btn btn--accent" style="background: #C97F1E; color: #FFF8EE; font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 8px; border: none; cursor: pointer;">＋ Create Live Payment Intent</button>
            </div>
            <div id="island-intent-status" style="display: none; font-size: 12.5px; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px;"></div>
            <table class="dtable" style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="text-align: left; font-size: 11.5px; color: #5B6470; border-bottom: 1px solid #D8DCD2; text-transform: uppercase;">
                  <th style="padding: 0 14px 10px;">Reference</th>
                  <th style="padding: 0 14px 10px;">Gateway</th>
                  <th style="padding: 0 14px 10px;">Amount</th>
                  <th style="padding: 0 14px 10px;">Status</th>
                  <th style="padding: 0 14px 10px;">When</th>
                </tr>
              </thead>
              <tbody id="island-trx-tbody">
                ${trxRows}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tab 2: Gateways -->
        <div id="mer-tab-gateways" style="display: none;">
          <div class="page-head" style="margin-bottom: 22px;">
            <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Payment Gateways</h2>
            <p style="font-size: 13px; color: #5B6470; margin-top: 3px;">Payment rails enabled on this deployment (GET /api/v1/gateways)</p>
          </div>
          <div id="island-gw-container">
            ${gwCards}
          </div>
        </div>

        <!-- Tab 3: Mobile Pairing -->
        <div id="mer-tab-pairing" style="display: none;">
          <div class="page-head" style="margin-bottom: 22px;">
            <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Mobile Pairing</h2>
            <p style="font-size: 13px; color: #5B6470; margin-top: 3px;">Connect your Android phone to auto-forward MFS SMS confirmations</p>
          </div>
          <div id="island-pairing-status" style="display: none; font-size: 12.5px; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;"></div>
          <div class="card card-pad" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 24px; text-align: center; max-width: 480px;">
            <div style="font-size: 13px; color: #5B6470; margin-bottom: 14px;">Paired companion devices</div>
            <div id="island-devices-list" style="font-size: 13px; color: #5B6470;">Loading paired devices…</div>
            <p style="font-size: 12px; color: #5B6470; margin-top: 14px;">Pairing codes are issued from the Admin console. Open the EdgePay Android app and enter the code shown there.</p>
          </div>
        </div>

        <!-- Tab 4: Developers -->
        <div id="mer-tab-developers" style="display: none;">
          <div class="page-head" style="margin-bottom: 22px;">
            <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Developer Integration</h2>
            <p style="font-size: 13px; color: #5B6470; margin-top: 3px;">REST API Credentials & Webhook Notifications</p>
          </div>
          <div id="island-dev-status" style="display: none; font-size: 12.5px; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;"></div>
          <div class="card card-pad" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 8px;">
              <div style="font-size: 13px; font-weight: 600;">API Keys</div>
              <button id="btn-mer-create-key" style="background: #12181F; color: #EEF1EA; font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 8px; border: none; cursor: pointer;">＋ New key</button>
            </div>
            <div style="font-size: 12px; color: #5B6470; margin-bottom: 10px;">Bearer key for this console:</div>
            <div style="display: flex; gap: 8px; margin-bottom: 14px;">
              <input id="inp-mer-api-key" type="password" placeholder="op_live_…" value="${escapeHtml(getApiKey(container))}" style="flex: 1; padding: 8px 12px; border: 1px solid #D8DCD2; border-radius: 8px; font-family: monospace; font-size: 12px;">
              <button id="btn-mer-save-key" style="background: transparent; border: 1px solid #D8DCD2; padding: 6px 12px; border-radius: 8px; font-size: 12px; cursor: pointer;">Save</button>
            </div>
            <table class="dtable" style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="text-align: left; font-size: 11.5px; color: #5B6470; border-bottom: 1px solid #D8DCD2; text-transform: uppercase;">
                  <th style="padding: 0 10px 10px;">Name</th>
                  <th style="padding: 0 10px 10px;">Prefix</th>
                  <th style="padding: 0 10px 10px;">Status</th>
                  <th style="padding: 0 10px 10px; text-align: right;">Actions</th>
                </tr>
              </thead>
              <tbody id="island-keys-tbody"></tbody>
            </table>
            <div id="island-new-key" style="display: none; margin-top: 10px; background: #FCFCFA; border: 1px solid #D8DCD2; padding: 10px 12px; border-radius: 8px; font-size: 12px;">
              <div style="font-weight: 600; margin-bottom: 4px;">New key (shown once — copy now):</div>
              <div class="epx-mono" id="island-new-key-val" style="word-break: break-all;"></div>
            </div>
          </div>
          <div class="card card-pad" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
              <div style="font-size: 13px; font-weight: 600;">Webhook endpoints</div>
              <div style="display: flex; gap: 8px;">
                <button id="btn-mer-test-hook" style="background: transparent; border: 1px solid #D8DCD2; padding: 5px 12px; border-radius: 8px; font-size: 12px; cursor: pointer;">Send test event</button>
                <button id="btn-mer-add-hook" style="background: #12181F; color: #EEF1EA; font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 8px; border: none; cursor: pointer;">＋ Add endpoint</button>
              </div>
            </div>
            <table class="dtable" style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="text-align: left; font-size: 11.5px; color: #5B6470; border-bottom: 1px solid #D8DCD2; text-transform: uppercase;">
                  <th style="padding: 0 10px 10px;">URL</th>
                  <th style="padding: 0 10px 10px;">Status</th>
                  <th style="padding: 0 10px 10px; text-align: right;">Actions</th>
                </tr>
              </thead>
              <tbody id="island-hooks-tbody"></tbody>
            </table>
          </div>
          <div class="card card-pad" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 18px 20px;">
            <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">Recent webhook deliveries</div>
            <table class="dtable" style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="text-align: left; font-size: 11.5px; color: #5B6470; border-bottom: 1px solid #D8DCD2; text-transform: uppercase;">
                  <th style="padding: 0 10px 10px;">Event</th>
                  <th style="padding: 0 10px 10px;">Status</th>
                  <th style="padding: 0 10px 10px;">When</th>
                  <th style="padding: 0 10px 10px; text-align: right;">Retry</th>
                </tr>
              </thead>
              <tbody id="island-deliveries-tbody"></tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  `;

  // Tab switching logic
  const tabs = ['dashboard', 'gateways', 'pairing', 'developers'];
  tabs.forEach(t => {
    document.getElementById(`mer-nav-${t}`)?.addEventListener('click', () => {
      tabs.forEach(other => {
        const btn = document.getElementById(`mer-nav-${other}`);
        const panel = document.getElementById(`mer-tab-${other}`);
        if (btn) {
          btn.style.background = other === t ? '#12181F' : 'transparent';
          btn.style.color = other === t ? '#EEF1EA' : '#3A424B';
          btn.style.fontWeight = other === t ? '600' : '500';
        }
        if (panel) panel.style.display = other === t ? 'block' : 'none';
      });
    });
  });

  function devStatus(message, isError) {
    const el = document.getElementById('island-dev-status');
    if (!el) return;
    if (!message) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = message;
    el.style.color = isError ? '#9E2A2B' : '#0B6E5C';
    el.style.background = isError ? '#F7D7D4' : '#DCEEE8';
  }

  // ---- API keys table (GET + POST + revoke + rotate) ----
  function renderKeys() {
    const tbody = document.getElementById('island-keys-tbody');
    if (!tbody) return;
    if (apiKeys === null) {
      tbody.innerHTML = errorRow(4, unauthorized ? 'API keys require a valid key — save one above.' : 'Could not load API keys.');
      return;
    }
    if (apiKeys.length === 0) {
      tbody.innerHTML = emptyRow(4, 'No API keys yet.', 'Create one with “＋ New key”.');
      return;
    }
    tbody.innerHTML = apiKeys.map(k => `
      <tr style="border-bottom: 1px solid #ECEEE8;">
        <td style="padding: 10px; font-weight: 600;">${escapeHtml(k.name || '')}</td>
        <td class="epx-mono" style="padding: 10px;">${escapeHtml(k.key_prefix || '')}</td>
        <td style="padding: 10px;"><span style="background: ${k.status === 'active' ? '#DCEEE8' : '#F7D7D4'}; color: ${k.status === 'active' ? '#0B6E5C' : '#9E2A2B'}; padding: 3px 10px; border-radius: 20px; font-weight: 600; font-size: 11px;">${escapeHtml(k.status || '')}</span></td>
        <td style="padding: 10px; text-align: right; white-space: nowrap;">
          <button data-revoke-key="${k.id}" style="background: transparent; border: 1px solid #D8DCD2; padding: 3px 10px; border-radius: 8px; font-size: 11.5px; cursor: pointer;">Revoke</button>
          <button data-rotate-key="${k.id}" style="background: transparent; border: 1px solid #D8DCD2; padding: 3px 10px; border-radius: 8px; font-size: 11.5px; cursor: pointer; margin-left: 6px;">Rotate</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-revoke-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-revoke-key');
        devStatus('');
        try {
          const { res, json } = await getJson(`${apiOrigin}/api/v1/api-keys/${id}`, container, { method: 'DELETE' });
          if (res.ok && json?.success !== false) {
            apiKeys = apiKeys.filter(k => String(k.id) !== String(id));
            renderKeys();
            devStatus(`Key ${id} revoked.`, false);
          } else {
            devStatus(json?.error?.message || `Revoke failed (HTTP ${res.status}).`, true);
          }
        } catch {
          devStatus('Revoke request failed — check your connection.', true);
        }
      });
    });

    tbody.querySelectorAll('[data-rotate-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-rotate-key');
        devStatus('');
        try {
          const { res, json } = await getJson(`${apiOrigin}/api/v1/api-keys/${id}/rotate`, container, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (res.ok && json?.success) {
            const box = document.getElementById('island-new-key');
            const val = document.getElementById('island-new-key-val');
            if (box && val && json.data?.api_key) {
              val.textContent = json.data.api_key;
              box.style.display = 'block';
            }
            const keysRef = await getJson(`${apiOrigin}/api/v1/api-keys`, container).catch(() => null);
            if (keysRef?.res.ok && keysRef.json?.success) {
              apiKeys = keysRef.json.data || [];
              renderKeys();
            }
            devStatus(`Key ${id} rotated — copy the new secret now.`, false);
          } else {
            devStatus(json?.error?.message || `Rotate failed (HTTP ${res.status}).`, true);
          }
        } catch {
          devStatus('Rotate request failed — check your connection.', true);
        }
      });
    });
  }

  // ---- Webhooks tables (GET + POST + deliveries + retry) ----
  function renderHooks() {
    const tbody = document.getElementById('island-hooks-tbody');
    if (!tbody) return;
    if (webhooks === null) {
      tbody.innerHTML = errorRow(3, unauthorized ? 'Webhooks require a valid key — save one above.' : 'Could not load webhooks.');
      return;
    }
    if (webhooks.length === 0) {
      tbody.innerHTML = emptyRow(3, 'No webhook endpoints registered.', 'Add one with “＋ Add endpoint”.');
      return;
    }
    tbody.innerHTML = webhooks.map(h => `
      <tr style="border-bottom: 1px solid #ECEEE8;">
        <td class="epx-mono" style="padding: 10px; word-break: break-all;">${escapeHtml(h.url || '')}</td>
        <td style="padding: 10px;"><span style="background: ${h.status === 'active' ? '#DCEEE8' : '#F3E3C7'}; color: ${h.status === 'active' ? '#0B6E5C' : '#8A5A0F'}; padding: 3px 10px; border-radius: 20px; font-weight: 600; font-size: 11px;">${escapeHtml(h.status || '')}</span></td>
        <td style="padding: 10px; text-align: right; white-space: nowrap;">
          <button data-retry-hook="${h.id}" style="background: transparent; border: 1px solid #D8DCD2; padding: 3px 10px; border-radius: 8px; font-size: 11.5px; cursor: pointer;">Send test</button>
          <button data-delete-hook="${h.id}" style="background: transparent; border: 1px solid #D8DCD2; padding: 3px 10px; border-radius: 8px; font-size: 11.5px; cursor: pointer; margin-left: 6px;">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-delete-hook]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-hook');
        devStatus('');
        try {
          const { res, json } = await getJson(`${apiOrigin}/api/v1/webhooks/${id}`, container, { method: 'DELETE' });
          if (res.ok && json?.success !== false) {
            webhooks = webhooks.filter(h => String(h.id) !== String(id));
            renderHooks();
            devStatus(`Webhook ${id} deleted.`, false);
          } else {
            devStatus(json?.error?.message || `Delete failed (HTTP ${res.status}).`, true);
          }
        } catch {
          devStatus('Delete request failed — check your connection.', true);
        }
      });
    });

    tbody.querySelectorAll('[data-retry-hook]').forEach(btn => {
      btn.addEventListener('click', async () => {
        devStatus('');
        try {
          const { res, json } = await getJson(`${apiOrigin}/api/v1/webhooks/tests`, container, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          devStatus(res.ok ? 'Test event queued for delivery.' : (json?.error?.message || `Test failed (HTTP ${res.status}).`), !res.ok);
        } catch {
          devStatus('Test request failed — check your connection.', true);
        }
      });
    });
  }

  function renderDeliveries() {
    const tbody = document.getElementById('island-deliveries-tbody');
    if (!tbody) return;
    if (deliveries === null) {
      tbody.innerHTML = errorRow(4, unauthorized ? 'Deliveries require a valid key — save one above.' : 'Could not load deliveries.');
      return;
    }
    if (deliveries.length === 0) {
      tbody.innerHTML = emptyRow(4, 'No webhook deliveries yet.', 'Send a test event to verify your endpoint.');
      return;
    }
    tbody.innerHTML = deliveries.map(d => {
      const ok = d.status === 'delivered' || (d.status_code != null && d.status_code >= 200 && d.status_code < 300);
      const timeStr = d.created_at ? new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      return `
        <tr style="border-bottom: 1px solid #ECEEE8;">
          <td class="epx-mono" style="padding: 10px;">${escapeHtml(d.event || '')}</td>
          <td style="padding: 10px;"><span style="background: ${ok ? '#DCEEE8' : '#F7D7D4'}; color: ${ok ? '#0B6E5C' : '#9E2A2B'}; padding: 3px 10px; border-radius: 20px; font-weight: 600; font-size: 11px;">${escapeHtml(d.status || String(d.status_code || ''))}</span></td>
          <td class="epx-mono" style="padding: 10px; color: #5B6470; font-size: 12px;">${timeStr}</td>
          <td style="padding: 10px; text-align: right;"><button data-retry-delivery data-delivery-id="${d.id}" style="background: transparent; border: 1px solid #D8DCD2; padding: 3px 10px; border-radius: 8px; font-size: 11.5px; cursor: pointer;">Retry</button></td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-retry-delivery]').forEach(btn => {
      btn.addEventListener('click', async () => {
        devStatus('');
        const deliveryId = btn.dataset.deliveryId;
        if (!deliveryId) {
          devStatus('Retry failed — missing delivery id.', true);
          return;
        }
        try {
          const { res, json } = await getJson(`${apiOrigin}/api/v1/webhooks/deliveries/${deliveryId}/retry`, container, {
            method: 'POST',
          });
          devStatus(res.ok ? `Retry queued for delivery #${deliveryId}.` : (json?.error?.message || `Retry failed (HTTP ${res.status}).`), !res.ok);
        } catch {
          devStatus('Retry request failed — check your connection.', true);
        }
      });
    });
  }

  renderKeys();
  renderHooks();
  renderDeliveries();

  // Save API key (persists for subsequent loads)
  document.getElementById('btn-mer-save-key')?.addEventListener('click', () => {
    const inp = document.getElementById('inp-mer-api-key');
    const key = (inp?.value || '').trim();
    if (!key) {
      devStatus('Paste an API key first (created via POST /api/v1/api-keys).', true);
      return;
    }
    setApiKey(key);
    devStatus('API key saved — reloading live data…', false);
    initMerchantIsland();
  });

  // Create API key
  document.getElementById('btn-mer-create-key')?.addEventListener('click', async () => {
    const name = prompt('Name for the new API key:');
    if (!name) return;
    devStatus('');
    try {
      const { res, json } = await getJson(`${apiOrigin}/api/v1/api-keys`, container, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes: ['read', 'write'] }),
      });
      if (res.status === 201 && json?.success) {
        const box = document.getElementById('island-new-key');
        const val = document.getElementById('island-new-key-val');
        if (box && val) {
          val.textContent = json.data.api_key || '';
          box.style.display = 'block';
        }
        const keysRef = await getJson(`${apiOrigin}/api/v1/api-keys`, container).catch(() => null);
        if (keysRef?.res.ok && keysRef.json?.success) {
          apiKeys = keysRef.json.data || [];
          renderKeys();
        }
        devStatus('Key created — copy the secret now (shown once).', false);
      } else {
        devStatus(json?.error?.message || `Create failed (HTTP ${res.status}). Admin scope may be required.`, true);
      }
    } catch {
      devStatus('Create request failed — check your connection.', true);
    }
  });

  // Register webhook endpoint
  document.getElementById('btn-mer-add-hook')?.addEventListener('click', async () => {
    const url = prompt('Public HTTPS endpoint URL for webhook events:');
    if (!url) return;
    devStatus('');
    try {
      const { res, json } = await getJson(`${apiOrigin}/api/v1/webhooks`, container, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events: ['*'] }),
      });
      if ((res.status === 201 || res.ok) && json?.success) {
        const hooksRef = await getJson(`${apiOrigin}/api/v1/webhooks`, container).catch(() => null);
        if (hooksRef?.res.ok && hooksRef.json?.success) {
          webhooks = hooksRef.json.data || [];
          renderHooks();
        }
        devStatus(
          json.data?.secret ? `Endpoint registered. Signing secret (shown once): ${json.data.secret}` : 'Endpoint registered.',
          false
        );
      } else {
        devStatus(json?.error?.message || `Register failed (HTTP ${res.status}).`, true);
      }
    } catch {
      devStatus('Register request failed — check your connection.', true);
    }
  });

  // Send test webhook event
  document.getElementById('btn-mer-test-hook')?.addEventListener('click', async () => {
    devStatus('');
    try {
      const { res, json } = await getJson(`${apiOrigin}/api/v1/webhooks/tests`, container, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      devStatus(res.ok ? 'Test event queued for delivery.' : (json?.error?.message || `Test failed (HTTP ${res.status}).`), !res.ok);
    } catch {
      devStatus('Test request failed — check your connection.', true);
    }
  });

  // Paired devices (best-effort admin surface; empty-state when unavailable)
  try {
    const devR = await getJson(`${apiOrigin}/api/admin/v1/devices`, container).catch(() => null);
    const listEl = document.getElementById('island-devices-list');
    if (listEl) {
      if (devR?.res.ok && devR.json?.success) {
        const devices = devR.json.data || [];
        listEl.innerHTML = devices.length === 0
          ? 'No companion devices paired yet.'
          : devices.map(d => `<div style="padding: 6px 0; border-bottom: 1px solid #ECEEE8;"><strong>${escapeHtml(d.device_name || 'Companion device')}</strong> <span style="color:#5B6470;">· ${escapeHtml(d.status || 'active')}</span></div>`).join('');
      } else {
        listEl.textContent = 'Device list unavailable — pairing codes are issued from the Admin console.';
      }
    }
  } catch {
    const listEl = document.getElementById('island-devices-list');
    if (listEl) listEl.textContent = 'Device list unavailable — pairing codes are issued from the Admin console.';
  }

  // Create payment intent (live, idempotent)
  document.getElementById('btn-mer-create-intent')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('island-intent-status');
    const showIntent = (msg, isError) => {
      if (!statusEl) return;
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
      statusEl.style.color = isError ? '#9E2A2B' : '#0B6E5C';
      statusEl.style.background = isError ? '#F7D7D4' : '#DCEEE8';
    };
    const raw = prompt('Amount for the new payment intent (e.g. 250.00 BDT):');
    if (raw === null) return;
    const amountStr = (raw || '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amountStr)) {
      showIntent('Enter a valid amount like 250.00.', true);
      return;
    }
    showIntent('Creating payment intent…', false);
    try {
      const idempotencyKey = (window.crypto?.randomUUID && window.crypto.randomUUID()) || String(Date.now());
      const { res, json } = await getJson(`${apiOrigin}/api/v1/payments`, container, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ amount: amountStr, currency: 'BDT' }),
      });
      if ((res.status === 201 || res.ok) && json?.success && json.data) {
        const dest = json.data.checkout_url || (json.data.token ? `/checkout?token=${encodeURIComponent(json.data.token)}` : null);
        if (dest) {
          window.location.href = dest;
          return;
        }
        showIntent('Intent created but no checkout URL was returned.', true);
      } else {
        showIntent(json?.error?.message || `Create failed (HTTP ${res.status}).`, true);
      }
    } catch {
      showIntent('Create request failed — check your connection.', true);
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMerchantIsland);
  } else {
    initMerchantIsland();
  }
}
