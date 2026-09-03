/**
 * EdgePay Platform Admin Island — Client Data Hydration & Tenant Provisioning
 * Framework: Astro Island Client Component
 * 100% Dynamic Data: Hydrates from the live Admin API only. No demo fallbacks.
 *
 * Data sources (all live; Cloudflare Access identity + admin-scope Bearer key;
 * break-glass service token is read from localStorage when set by the operator):
 *   - GET  /api/admin/v1/merchants              list tenants
 *   - POST /api/admin/v1/merchants              provision tenant {name, email}
 *   - POST /api/admin/v1/domains/verifications  re-verify custom domain DNS {domain}
 *   - GET  /api/v1/gateways                     enabled-only gateway catalog
 *   - GET  /api/admin/v1/devices                paired companion devices
 *   - GET  /api/admin/v1/sms-queues             recent forwarded SMS + parse status
 */

function getAdminKey(container) {
  return (
    container.dataset.apiKey ||
    window.localStorage.getItem('edgepay_admin_key') ||
    window.localStorage.getItem('edgepay_api_key') ||
    ''
  );
}

function adminHeaders(container, extra) {
  const key = getAdminKey(container);
  const h = { Accept: 'application/json', ...(extra || {}) };
  if (key) h.Authorization = `Bearer ${key}`;
  const accessJwt = window.localStorage.getItem('edgepay_access_jwt');
  if (accessJwt) h['Cf-Access-Jwt-Assertion'] = accessJwt;
  return h;
}

async function adminJson(url, container, options) {
  const res = await fetch(url, {
    credentials: 'include',
    ...(options || {}),
    headers: adminHeaders(container, (options && options.headers) || {}),
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}" style="text-align: center; color: #5B6470; padding: 24px 12px;">${escapeHtml(message)}</td></tr>`;
}

function errorRow(cols, message) {
  return `<tr><td colspan="${cols}" style="text-align: center; color: #9E2A2B; padding: 24px 12px;">${escapeHtml(message)}</td></tr>`;
}

export async function initAdminIsland() {
  const container = document.getElementById('admin-island') || document.getElementById('admin-app');
  if (!container) return;

  const apiOrigin = container.dataset.apiOrigin || '';

  // Initial loading state
  container.innerHTML = `
    <div style="padding: 40px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="font-size: 14px; color: #5B6470; margin-bottom: 8px;">Connecting to EdgePay Platform Core...</div>
      <div style="font-weight: 600; font-family: monospace;">Loading live tenant registry...</div>
    </div>
  `;

  let merchants = [];
  let gateways = [];
  let devices = [];
  let loadError = '';
  let unauthorized = false;

  try {
    const [merchantsR, gatewaysR, devicesR] = await Promise.all([
      adminJson(`${apiOrigin}/api/admin/v1/merchants`, container).catch(() => null),
      adminJson(`${apiOrigin}/api/v1/gateways`, container).catch(() => null),
      adminJson(`${apiOrigin}/api/admin/v1/devices`, container).catch(() => null),
    ]);

    for (const r of [merchantsR, gatewaysR, devicesR]) {
      if (r && (r.res.status === 401 || r.res.status === 403)) unauthorized = true;
    }

    if (merchantsR?.res.ok && merchantsR.json?.success) merchants = merchantsR.json.data || [];
    if (gatewaysR?.res.ok && gatewaysR.json?.success) {
      gateways = (gatewaysR.json.data?.enabled || []).filter((g) => g && g.slug);
    }
    if (devicesR?.res.ok && devicesR.json?.success) devices = devicesR.json.data || [];

    if (!merchantsR?.res.ok) {
      loadError = unauthorized
        ? 'Admin API rejected the request (401/403). Sign in via Cloudflare Access and set an admin-scope key.'
        : 'Admin API is unreachable. Check your connection and try again.';
    }
  } catch (err) {
    console.warn('Live admin data fetch error:', err);
    loadError = 'Admin API is unreachable. Check your connection and try again.';
  }

  let selectedMerchant = merchants[0] || null;

  const merchantRows = loadError && merchants.length === 0
    ? errorRow(4, loadError)
    : merchants.length === 0
      ? emptyRow(4, 'No tenants provisioned yet. Click "＋ Provision merchant" above.')
      : merchants.map((m, idx) => `
          <tr class="selectable ${idx === 0 ? 'is-selected' : ''}" data-mid="${m.id}" style="border-bottom: 1px solid #ECEEE8; cursor: pointer; ${idx === 0 ? 'background: #FAFAF8;' : ''}">
            <td style="padding: 12px 14px; font-weight: 600;">${escapeHtml(m.name)}</td>
            <td style="padding: 12px 14px;">${gateways.map(g => escapeHtml((g.name || g.slug).split(' ')[0])).slice(0, 2).join(', ') || '—'}</td>
            <td style="padding: 12px 14px;"><span style="background: #DCEEE8; color: #0B6E5C; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;">${m.is_platform ? 'platform' : 'custom'}</span></td>
            <td style="padding: 12px 14px;"><span style="background: ${m.status === 'active' ? '#DCEEE8' : '#F3E3C7'}; color: ${m.status === 'active' ? '#0B6E5C' : '#8A5A0F'}; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;">${escapeHtml(m.status)}</span></td>
          </tr>
        `).join('');

  // Render Full Admin Island Layout
  container.innerHTML = `
    <div class="app-shell" style="display: flex; min-height: 100vh;">
      <aside class="app-sidebar" style="width: 220px; flex-shrink: 0; background: #FFFFFF; border-right: 1px solid #D8DCD2; padding: 22px 14px; display: flex; flex-direction: column; gap: 4px;">
        <div class="app-sidebar__brand" style="font-weight: 700; font-size: 16px; padding: 0 10px 20px; line-height: 1.3;">
          EdgePay <span style="color: #C97F1E;">Admin</span>
          <small style="font-size: 11px; font-weight: 400; color: #5B6470; display: block; margin-top: 2px;">Platform Operations Console</small>
        </div>
        <button class="nav-item active" id="adm-nav-merchants" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 600; background: #12181F; color: #EEF1EA; border: none; cursor: pointer; text-align: left;">
          Merchants
        </button>
        <button class="nav-item" id="adm-nav-analytics" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; background: transparent; border: none; cursor: pointer; text-align: left;">
          Analytics
        </button>
        <button class="nav-item" id="adm-nav-devices" style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; background: transparent; border: none; cursor: pointer; text-align: left;">
          Devices &amp; SMS
        </button>
      </aside>

      <main class="app-main" style="flex: 1; padding: 28px 32px; overflow-y: auto;">
        <!-- Tab 1: Merchants -->
        <div id="adm-tab-merchants">
          <div class="page-head" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px;">
            <div>
              <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Merchants</h2>
              <p style="font-size: 13px; color: #5B6470; margin-top: 3px;" id="island-adm-count">${loadError && merchants.length === 0 ? escapeHtml(loadError) : `${merchants.length} active tenant${merchants.length === 1 ? '' : 's'} provisioned`}</p>
            </div>
            <button id="btn-adm-provision" class="btn btn--accent" style="background: #C97F1E; color: #FFF8EE; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer;">＋ Provision merchant</button>
          </div>
          <div id="island-adm-status" style="display: none; font-size: 12.5px; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;"></div>

          <div style="display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; align-items: start;">
            <div class="card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; overflow: hidden;">
              <table class="dtable" style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                  <tr style="text-align: left; font-size: 11.5px; color: #5B6470; border-bottom: 1px solid #D8DCD2; text-transform: uppercase;">
                    <th style="padding: 12px 14px;">Brand</th>
                    <th style="padding: 12px 14px;">Gateways</th>
                    <th style="padding: 12px 14px;">Domain</th>
                    <th style="padding: 12px 14px;">Status</th>
                  </tr>
                </thead>
                <tbody id="island-merchants-tbody">
                  ${merchantRows}
                </tbody>
              </table>
            </div>

            <!-- Detail Panel -->
            <div class="card card-pad" id="island-adm-detail" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 18px 20px;">
              <div style="font-weight: 700; font-size: 16px; margin-bottom: 2px;" id="island-detail-name">${selectedMerchant ? escapeHtml(selectedMerchant.name) : 'Select a merchant'}</div>
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 18px; font-family: monospace;" id="island-detail-domain">${selectedMerchant ? escapeHtml(selectedMerchant.slug + '.edgepay.app') : '—'}</div>

              <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Configured payment gateways</div>
              <div id="island-detail-gws">
                ${gateways.length === 0 ? '<div style="font-size: 12px; color: #5B6470;">No gateways enabled on this deployment.</div>' : gateways.slice(0, 3).map(g => `
                  <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #ECEEE8;">
                    <span style="font-size: 13px;">${escapeHtml(g.name || g.slug)}${g.account_number ? ` (${escapeHtml(g.account_number)})` : ''}</span>
                    <span style="background: #DCEEE8; color: #0B6E5C; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 12px;">active</span>
                  </div>
                `).join('')}
              </div>

              <div style="font-size: 13px; font-weight: 600; margin: 18px 0 8px;">Custom domain DNS</div>
              <div style="margin-bottom: 10px;">
                <input id="island-detail-dns-input" value="${selectedMerchant ? escapeHtml(selectedMerchant.slug + '.edgepay.app') : ''}" placeholder="custom-domain.example.com" style="width: 100%; padding: 8px 12px; border: 1px solid #D8DCD2; border-radius: 8px; font-family: monospace; font-size: 12px; background: #FCFCFA;">
              </div>
              <div id="island-dns-status" style="display: none; font-size: 12.5px; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px;"></div>
              <button id="btn-adm-verify-dns" style="background: transparent; border: 1px solid #D8DCD2; padding: 6px 12px; border-radius: 8px; font-size: 12px; cursor: pointer;">Re-verify Cloudflare Edge DNS</button>
            </div>
          </div>
        </div>

        <!-- Tab 2: Analytics -->
        <div id="adm-tab-analytics" style="display: none;">
          <div class="page-head" style="margin-bottom: 22px;">
            <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Analytics &amp; Telemetry</h2>
            <p style="font-size: 13px; color: #5B6470; margin-top: 3px;">Cross-tenant registry snapshot</p>
          </div>
          <div class="stat-row" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 22px;">
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Active Tenants</div>
              <div class="epx-mono" style="font-size: 22px; font-weight: 600;">${merchants.length}</div>
            </div>
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Enabled Gateways</div>
              <div class="epx-mono" style="font-size: 22px; font-weight: 600;">${gateways.length}</div>
            </div>
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Paired Devices</div>
              <div class="epx-mono" style="font-size: 22px; font-weight: 600;">${devices.length}</div>
            </div>
            <div class="stat-card" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 16px 18px;">
              <div style="font-size: 12px; color: #5B6470; margin-bottom: 6px;">Registry State</div>
              <div class="epx-mono" style="font-size: 16px; font-weight: 600;">${loadError ? 'unreachable' : 'live'}</div>
            </div>
          </div>
        </div>

        <!-- Tab 3: Devices & SMS -->
        <div id="adm-tab-devices" style="display: none;">
          <div class="page-head" style="margin-bottom: 22px;">
            <h2 style="font-size: 20px; font-weight: 700; margin: 0;">Devices &amp; SMS</h2>
            <p style="font-size: 13px; color: #5B6470; margin-top: 3px;">Forwarding companion phones and SMS parse inbox</p>
          </div>
          <div class="card card-pad" style="background: #FFF; border: 1px solid #D8DCD2; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px;">
            <div style="font-size: 13px; font-weight: 600; margin-bottom: 12px;">Paired Devices</div>
            <table class="dtable" style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="text-align: left; font-size: 11.5px; color: #5B6470; border-bottom: 1px solid #D8DCD2; text-transform: uppercase;">
                  <th style="padding: 8px 12px;">Device Name</th>
                  <th style="padding: 8px 12px;">Status</th>
                  <th style="padding: 8px 12px;">Last Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                ${loadError && devices.length === 0 ? errorRow(3, loadError) : devices.length === 0 ? emptyRow(3, 'No mobile devices paired yet. Pair with the OTP flow from a merchant account.') : devices.map(d => `
                  <tr style="border-bottom: 1px solid #ECEEE8;">
                    <td style="padding: 10px 12px; font-weight: 600;">${escapeHtml(d.device_name || 'Companion Device')}</td>
                    <td style="padding: 10px 12px;"><span style="background: #DCEEE8; color: #0B6E5C; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 12px;">${escapeHtml(d.status || 'active')}</span></td>
                    <td style="padding: 10px 12px; font-family: monospace;">${d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toLocaleTimeString() : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  `;

  function admStatus(message, isError) {
    const el = document.getElementById('island-adm-status');
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

  function selectMerchantRow(id) {
    selectedMerchant = merchants.find(m => String(m.id) === String(id)) || null;
    const nameEl = document.getElementById('island-detail-name');
    const domainEl = document.getElementById('island-detail-domain');
    const dnsInp = document.getElementById('island-detail-dns-input');
    if (nameEl) nameEl.textContent = selectedMerchant ? selectedMerchant.name : 'Select a merchant';
    if (domainEl) domainEl.textContent = selectedMerchant ? `${selectedMerchant.slug}.edgepay.app` : '—';
    if (dnsInp) dnsInp.value = selectedMerchant ? `${selectedMerchant.slug}.edgepay.app` : '';
    container.querySelectorAll('#island-merchants-tbody tr.selectable').forEach(tr => {
      const on = tr.dataset.mid === String(id);
      tr.classList.toggle('is-selected', on);
      tr.style.background = on ? '#FAFAF8' : '';
    });
  }

  container.querySelectorAll('#island-merchants-tbody tr.selectable').forEach(tr => {
    tr.addEventListener('click', () => selectMerchantRow(tr.dataset.mid));
  });

  // Tab switching
  const tabs = ['merchants', 'analytics', 'devices'];
  tabs.forEach(t => {
    document.getElementById(`adm-nav-${t}`)?.addEventListener('click', () => {
      tabs.forEach(other => {
        const btn = document.getElementById(`adm-nav-${other}`);
        const panel = document.getElementById(`adm-tab-${other}`);
        if (btn) {
          btn.style.background = other === t ? '#12181F' : 'transparent';
          btn.style.color = other === t ? '#EEF1EA' : '#3A424B';
          btn.style.fontWeight = other === t ? '600' : '500';
        }
        if (panel) panel.style.display = other === t ? 'block' : 'none';
      });
    });
  });

  // Provision merchant — live POST /api/admin/v1/merchants (Access + break-glass).
  document.getElementById('btn-adm-provision')?.addEventListener('click', async () => {
    const name = prompt('Merchant business name:');
    if (!name) return;
    const email = prompt('Merchant owner email:');
    if (!email) return;
    admStatus('Provisioning tenant…', false);
    try {
      const { res, json } = await adminJson(`${apiOrigin}/api/admin/v1/merchants`, container, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      if ((res.status === 201 || res.ok) && json?.success && json.data?.merchant) {
        const m = json.data.merchant;
        merchants = [...merchants, m];
        const tbody = document.getElementById('island-merchants-tbody');
        if (tbody) {
          const tr = document.createElement('tr');
          tr.className = 'selectable';
          tr.dataset.mid = String(m.id);
          tr.style.cssText = 'border-bottom: 1px solid #ECEEE8; cursor: pointer;';
          tr.innerHTML = `
            <td style="padding: 12px 14px; font-weight: 600;">${escapeHtml(m.name)}</td>
            <td style="padding: 12px 14px;">—</td>
            <td style="padding: 12px 14px;"><span style="background: #DCEEE8; color: #0B6E5C; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;">custom</span></td>
            <td style="padding: 12px 14px;"><span style="background: #DCEEE8; color: #0B6E5C; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;">${escapeHtml(m.status || 'active')}</span></td>`;
          tr.addEventListener('click', () => selectMerchantRow(tr.dataset.mid));
          const emptyCell = tbody.querySelector('td[colspan]');
          if (emptyCell) tbody.innerHTML = '';
          tbody.appendChild(tr);
        }
        const count = document.getElementById('island-adm-count');
        if (count) count.textContent = `${merchants.length} active tenant${merchants.length === 1 ? '' : 's'} provisioned`;
        admStatus(
          json.data?.claim_token
            ? `Tenant "${m.name}" provisioned. One-time claim token (copy now): ${json.data.claim_token}`
            : `Tenant "${m.name}" provisioned.`,
          false
        );
      } else {
        admStatus(json?.error?.message || `Provision failed (HTTP ${res.status}).`, true);
      }
    } catch {
      admStatus('Provision request failed — check your connection.', true);
    }
  });

  // DNS verify — live POST /api/admin/v1/domains/verifications.
  document.getElementById('btn-adm-verify-dns')?.addEventListener('click', async () => {
    const dnsInp = document.getElementById('island-detail-dns-input');
    const statusEl = document.getElementById('island-dns-status');
    const show = (msg, isError) => {
      if (!statusEl) return;
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
      statusEl.style.color = isError ? '#9E2A2B' : '#0B6E5C';
      statusEl.style.background = isError ? '#F7D7D4' : '#DCEEE8';
    };
    const domain = (dnsInp?.value || '').trim();
    if (!domain) {
      show('Enter a custom domain to verify.', true);
      return;
    }
    show('Verifying DNS TXT record…', false);
    try {
      const { res, json } = await adminJson(`${apiOrigin}/api/admin/v1/domains/verifications`, container, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      if (res.ok && json?.success) {
        show(
          json.data?.verified
            ? `Verified: ${json.data.lookup || domain} matches.`
            : `Not verified yet — publish TXT ${json.data?.lookup || `_edgepay-verification.${domain}`} with token ${json.data?.expected_token || '(see domain record)'}.`,
          !json.data?.verified
        );
      } else {
        show(json?.error?.message || `Verification failed (HTTP ${res.status}).`, true);
      }
    } catch {
      show('Verification request failed — check your connection.', true);
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdminIsland);
  } else {
    initAdminIsland();
  }
}
