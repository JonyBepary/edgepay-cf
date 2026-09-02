/**
 * Android SMS Simulator & MFS Relay Application
 * Theme: Wada Sanzo Harmony & Modern Responsive Architecture
 */

// Application State
const state = {
  currentGateway: 'bkash',
  editMode: 'template', // 'template' | 'raw'
  soundEnabled: true,
  theme: localStorage.getItem('theme') || 'dark',
  history: [],
  batchRunning: false,
};

// Gateway Presets & Generator Engines
const GATEWAYS = {
  bkash: {
    name: 'bKash',
    sender: 'bKash',
    avatarText: 'bK',
    avatarColor: '#e2136e',
    currency: 'BDT',
    genTrx: () => {
      const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let res = '';
      for (let i = 0; i < 10; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
      return res;
    },
    templates: {
      received_money: (d) => `You have received Tk ${d.amount} from ${d.number}. Ref ${d.ref || 'None'}. Fee Tk ${d.fee}. Balance Tk ${d.balance}. TrxID ${d.trx_id} at ${d.datetime}`,
      merchant_payment: (d) => `Payment Tk ${d.amount} received from ${d.number}. Counter 1. Fee Tk ${d.fee}. Balance Tk ${d.balance}. TrxID ${d.trx_id} at ${d.datetime}`,
      cash_in: (d) => `Cash In Tk ${d.amount} from ${d.number} successful. Fee Tk ${d.fee}. Balance Tk ${d.balance}. TrxID ${d.trx_id} at ${d.datetime}`,
    }
  },
  nagad: {
    name: 'Nagad',
    sender: '16167',
    avatarText: 'NG',
    avatarColor: '#f7941d',
    currency: 'BDT',
    genTrx: () => {
      const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let res = '7';
      for (let i = 0; i < 7; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
      return res;
    },
    templates: {
      received_money: (d) => `Money Received of Tk ${d.amount} from ${d.number}. TxnID: ${d.trx_id}. Balance: Tk ${d.balance}. Date: ${d.datetime}`,
      merchant_payment: (d) => `Merchant Payment of Tk ${d.amount} received from ${d.number}. TxnID: ${d.trx_id}. Balance: Tk ${d.balance}. Ref: ${d.ref || 'None'}. Date: ${d.datetime}`,
      cash_in: (d) => `Cash In of Tk ${d.amount} from ${d.number} is successful. TxnID: ${d.trx_id}. Balance: Tk ${d.balance}. Date: ${d.datetime}`,
    }
  },
  rocket: {
    name: 'Rocket',
    sender: '16216',
    avatarText: 'DB',
    avatarColor: '#8c3494',
    currency: 'BDT',
    genTrx: () => {
      let res = '';
      for (let i = 0; i < 10; i++) res += Math.floor(Math.random() * 10);
      return res;
    },
    templates: {
      received_money: (d) => `You have received Tk ${d.amount} from ${d.number}. Fee Tk ${d.fee}. Balance Tk ${d.balance}. TxnId: ${d.trx_id} on ${d.datetime}`,
      merchant_payment: (d) => `Merchant payment of Tk ${d.amount} from ${d.number} is successful. TxnId: ${d.trx_id} on ${d.datetime}`,
      cash_in: (d) => `Cash In of Tk ${d.amount} from ${d.number} is successful. Fee Tk ${d.fee}. Balance Tk ${d.balance}. TxnId: ${d.trx_id} on ${d.datetime}`,
    }
  },
  upay: {
    name: 'Upay',
    sender: 'upay',
    avatarText: 'UP',
    avatarColor: '#008cd3',
    currency: 'BDT',
    genTrx: () => 'UP' + Math.floor(100000 + Math.random() * 900000),
    templates: {
      received_money: (d) => `Received Tk ${d.amount} from ${d.number}. TrxID: ${d.trx_id}. Fee: Tk ${d.fee}. Balance: Tk ${d.balance}. ${d.datetime}`,
      merchant_payment: (d) => `Payment received Tk ${d.amount} from ${d.number}. TrxID: ${d.trx_id}. Balance: Tk ${d.balance}. ${d.datetime}`,
      cash_in: (d) => `Cash In Tk ${d.amount} from ${d.number} successful. TrxID: ${d.trx_id}. Fee: Tk ${d.fee}. Balance: Tk ${d.balance}. ${d.datetime}`,
    }
  },
  mpesa: {
    name: 'M-Pesa',
    sender: 'MPESA',
    avatarText: 'MP',
    avatarColor: '#00a859',
    currency: 'KES',
    genTrx: () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
      let res = '';
      for (let i = 0; i < 10; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
      return res;
    },
    templates: {
      received_money: (d) => `${d.trx_id} Confirmed. You have received Ksh${d.amount} from ${d.number} on ${d.datetime}. New M-PESA balance is Ksh${d.balance}.`,
      merchant_payment: (d) => `${d.trx_id} Confirmed. Ksh${d.amount} received from ${d.number} for Account ${d.ref || '101'} on ${d.datetime}. New M-PESA balance is Ksh${d.balance}.`,
      cash_in: (d) => `${d.trx_id} Confirmed. on ${d.datetime} Give Ksh${d.amount} cash to ${d.number}. New M-PESA balance is Ksh${d.balance}.`,
    }
  },
  bank: {
    name: 'Bank Alert',
    sender: 'BANK_ALERT',
    avatarText: 'BK',
    avatarColor: '#4e936b',
    currency: 'BDT',
    genTrx: () => 'TXN' + Math.floor(10000000 + Math.random() * 90000000),
    templates: {
      received_money: (d) => `A/C *${d.number.slice(-4) || '4589'} credited with ${d.currency} ${d.amount} on ${d.datetime}. Ref/TrxID: ${d.trx_id}. Available Bal: ${d.currency} ${d.balance}`,
      merchant_payment: (d) => `Payment received for ${d.currency} ${d.amount} with Ref ${d.trx_id} on ${d.datetime}. Balance: ${d.currency} ${d.balance}`,
      cash_in: (d) => `Deposit of ${d.currency} ${d.amount} successful. TrxID: ${d.trx_id} at ${d.datetime}. Bal: ${d.currency} ${d.balance}`,
    }
  }
};

// Audio Synthesizer (Chime effect)
function playSmsChime() {
  if (!state.soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (_) {}
}

// Helpers
function getFormattedDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getRandomPhone() {
  const prefixes = ['017', '018', '019', '016', '013', '014', '015'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  let rest = '';
  for (let i = 0; i < 8; i++) rest += Math.floor(Math.random() * 10);
  return `${prefix}${rest}`;
}

// DOM Elements
const doc = document;
const el = {
  themeToggleBtn: doc.getElementById('themeToggleBtn'),
  themeIcon: doc.getElementById('themeIcon'),
  soundToggleBtn: doc.getElementById('soundToggleBtn'),
  soundIcon: doc.getElementById('soundIcon'),
  
  // Phone Elements
  statusBarTime: doc.getElementById('statusBarTime'),
  phoneAvatar: doc.getElementById('phoneAvatar'),
  phoneSenderName: doc.getElementById('phoneSenderName'),
  phoneSenderSubtitle: doc.getElementById('phoneSenderSubtitle'),
  phoneMessageBubble: doc.getElementById('phoneMessageBubble'),
  bubbleTime: doc.getElementById('bubbleTime'),
  phoneBottomPreview: doc.getElementById('phoneBottomPreview'),
  phoneBatteryBar: doc.getElementById('phoneBatteryBar'),
  phoneBatteryText: doc.getElementById('phoneBatteryText'),
  phoneQuickSendBtn: doc.getElementById('phoneQuickSendBtn'),

  // Workspace Tabs
  tabBtns: doc.querySelectorAll('.tab-btn'),
  tabPanes: doc.querySelectorAll('.tab-pane'),
  presetPills: doc.querySelectorAll('.preset-pill'),

  // Form Fields
  inputSender: doc.getElementById('inputSender'),
  inputTrxId: doc.getElementById('inputTrxId'),
  inputNumber: doc.getElementById('inputNumber'),
  inputAmount: doc.getElementById('inputAmount'),
  inputCurrency: doc.getElementById('inputCurrency'),
  inputFee: doc.getElementById('inputFee'),
  inputBalance: doc.getElementById('inputBalance'),
  inputRef: doc.getElementById('inputRef'),
  inputDateTime: doc.getElementById('inputDateTime'),
  templateVariant: doc.getElementById('templateVariant'),
  rawSmsText: doc.getElementById('rawSmsText'),
  templateFormWrap: doc.getElementById('templateFormWrap'),
  rawFormWrap: doc.getElementById('rawFormWrap'),

  // Buttons
  randTrxBtn: doc.getElementById('randTrxBtn'),
  randPhoneBtn: doc.getElementById('randPhoneBtn'),
  nowTimeBtn: doc.getElementById('nowTimeBtn'),
  amtBtns: doc.querySelectorAll('.amt-btn'),
  mainSendBtn: doc.getElementById('mainSendBtn'),
  randomSendBtn: doc.getElementById('randomSendBtn'),

  // Target & Auth
  targetPresetSelect: doc.getElementById('targetPresetSelect'),
  targetUrlInput: doc.getElementById('targetUrlInput'),
  httpMethodSelect: doc.getElementById('httpMethodSelect'),
  payloadFormatSelect: doc.getElementById('payloadFormatSelect'),
  authTypeSelect: doc.getElementById('authTypeSelect'),
  authTokenInput: doc.getElementById('authTokenInput'),
  relayProxyCheckbox: doc.getElementById('relayProxyCheckbox'),
  pairingOtpInput: doc.getElementById('pairingOtpInput'),
  pairDeviceBtn: doc.getElementById('pairDeviceBtn'),
  pairingStatusMsg: doc.getElementById('pairingStatusMsg'),

  // Response Box
  responseStatusBadge: doc.getElementById('responseStatusBadge'),
  responseLatency: doc.getElementById('responseLatency'),
  responsePre: doc.getElementById('responsePre'),

  // History Log
  historyTableBody: doc.getElementById('historyTableBody'),
  historyCount: doc.getElementById('historyCount'),
  clearHistoryBtn: doc.getElementById('clearHistoryBtn'),

  // Diagnostics
  batterySlider: doc.getElementById('batterySlider'),
  batteryValText: doc.getElementById('batteryValText'),
  carrierSelect: doc.getElementById('carrierSelect'),
  serverEventLog: doc.getElementById('serverEventLog'),

  // Modals
  batchModalOverlay: doc.getElementById('batchModalOverlay'),
  openBatchModalBtn: doc.getElementById('openBatchModalBtn'),
  closeBatchModalBtn: doc.getElementById('closeBatchModalBtn'),
  cancelBatchBtn: doc.getElementById('cancelBatchBtn'),
  startBatchBtn: doc.getElementById('startBatchBtn'),
  batchCountInput: doc.getElementById('batchCountInput'),
  batchIntervalInput: doc.getElementById('batchIntervalInput'),
  batchProgressWrap: doc.getElementById('batchProgressWrap'),
  batchProgressBar: doc.getElementById('batchProgressBar'),
  batchProgressText: doc.getElementById('batchProgressText'),
  batchPercentText: doc.getElementById('batchPercentText'),

  quickPairBtn: doc.getElementById('quickPairBtn'),
  quickPairModalOverlay: doc.getElementById('quickPairModalOverlay'),
  closeQuickPairModalBtn: doc.getElementById('closeQuickPairModalBtn'),
  cancelQuickPairBtn: doc.getElementById('cancelQuickPairBtn'),
  confirmQuickPairBtn: doc.getElementById('confirmQuickPairBtn'),
  modalPairingOtpInput: doc.getElementById('modalPairingOtpInput'),
  modalPairStatusMsg: doc.getElementById('modalPairStatusMsg'),

  // Mobile View Switcher
  mobileViewToggle: doc.getElementById('mobileViewToggle'),
  showPhoneBtn: doc.getElementById('showPhoneBtn'),
  showControlsBtn: doc.getElementById('showControlsBtn'),
  phoneColumn: doc.getElementById('phoneColumn'),
  controlColumn: doc.getElementById('controlColumn'),
};

// Clock Updater
function updateClock() {
  const d = new Date();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (el.statusBarTime) el.statusBarTime.textContent = timeStr;
  if (el.bubbleTime) el.bubbleTime.textContent = timeStr;
}
setInterval(updateClock, 10000);
updateClock();

// Theme Switcher
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  state.theme = theme;
  if (el.themeIcon) el.themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
}
applyTheme(state.theme);

el.themeToggleBtn?.addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

// Sound Toggle
el.soundToggleBtn?.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  if (el.soundIcon) el.soundIcon.textContent = state.soundEnabled ? '🔔' : '🔕';
});

// Tab Navigation
el.tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    el.tabBtns.forEach(b => b.classList.remove('active'));
    el.tabPanes.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = doc.getElementById(tabId);
    if (pane) pane.classList.add('active');
  });
});

// Mobile View Switcher
el.showPhoneBtn?.addEventListener('click', () => {
  el.showPhoneBtn.classList.add('active');
  el.showControlsBtn.classList.remove('active');
  el.phoneColumn.classList.remove('hidden-mobile');
  el.controlColumn.classList.add('hidden-mobile');
});

el.showControlsBtn?.addEventListener('click', () => {
  el.showControlsBtn.classList.add('active');
  el.showPhoneBtn.classList.remove('active');
  el.phoneColumn.classList.add('hidden-mobile');
  el.controlColumn.classList.remove('hidden-mobile');
});

// Gateway Presets Selection
function setGateway(gwKey) {
  state.currentGateway = gwKey;
  const gw = GATEWAYS[gwKey];
  if (!gw) return;

  el.presetPills.forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-gw') === gwKey);
  });

  el.inputSender.value = gw.sender;
  el.inputCurrency.value = gw.currency;
  el.inputTrxId.value = gw.genTrx();

  el.phoneAvatar.textContent = gw.avatarText;
  el.phoneAvatar.style.backgroundColor = gw.avatarColor;
  el.phoneSenderName.textContent = gw.name;
  el.phoneSenderSubtitle = `${gw.name} Official Alert`;

  updateSmsPreview();
}

el.presetPills.forEach(pill => {
  pill.addEventListener('click', () => {
    setGateway(pill.getAttribute('data-gw'));
  });
});

// Build SMS Body from fields
function getGeneratedSmsBody() {
  if (state.editMode === 'raw') {
    return el.rawSmsText.value.trim();
  }
  const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
  const variant = el.templateVariant.value || 'received_money';
  const templateFn = gw.templates[variant] || gw.templates.received_money;

  const data = {
    amount: parseFloat(el.inputAmount.value || 0).toFixed(2),
    currency: el.inputCurrency.value,
    number: el.inputNumber.value.trim(),
    trx_id: el.inputTrxId.value.trim(),
    fee: parseFloat(el.inputFee.value || 0).toFixed(2),
    balance: parseFloat(el.inputBalance.value || 0).toFixed(2),
    ref: el.inputRef.value.trim(),
    datetime: el.inputDateTime.value.trim(),
  };

  return templateFn(data);
}

// Update Phone Screen with generated text
function updateSmsPreview() {
  const text = getGeneratedSmsBody();
  if (el.phoneMessageBubble) {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.phoneMessageBubble.innerHTML = `
      ${text}
      <div class="bubble-meta">
        <span>${timeStr}</span>
        <span class="sim-tag">SIM1</span>
      </div>
    `;
  }
  if (el.phoneBottomPreview) {
    el.phoneBottomPreview.textContent = text.slice(0, 36) + '...';
  }
}

// Mode Switcher (Template vs Raw)
doc.querySelectorAll('input[name="smsEditMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    state.editMode = e.target.value;
    if (state.editMode === 'raw') {
      el.templateFormWrap.style.display = 'none';
      el.rawFormWrap.style.display = 'block';
      el.rawSmsText.value = getGeneratedSmsBody();
    } else {
      el.templateFormWrap.style.display = 'block';
      el.rawFormWrap.style.display = 'none';
    }
    updateSmsPreview();
  });
});

// Form inputs listeners
[
  el.inputSender, el.inputTrxId, el.inputNumber, el.inputAmount,
  el.inputCurrency, el.inputFee, el.inputBalance, el.inputRef,
  el.inputDateTime, el.templateVariant, el.rawSmsText
].forEach(input => {
  if (input) input.addEventListener('input', updateSmsPreview);
});

// Randomizers
el.randTrxBtn?.addEventListener('click', () => {
  const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
  el.inputTrxId.value = gw.genTrx();
  updateSmsPreview();
});

el.randPhoneBtn?.addEventListener('click', () => {
  el.inputNumber.value = getRandomPhone();
  updateSmsPreview();
});

el.nowTimeBtn?.addEventListener('click', () => {
  el.inputDateTime.value = getFormattedDateTime();
  updateSmsPreview();
});

// Quick Amounts
el.amtBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    el.inputAmount.value = parseFloat(btn.getAttribute('data-amt')).toFixed(2);
    updateSmsPreview();
  });
});

// Target Preset Selector
el.targetPresetSelect?.addEventListener('change', (e) => {
  if (e.target.value !== 'custom') {
    el.targetUrlInput.value = e.target.value;
  }
});

// Construct Payload
function buildPayload() {
  const sender = el.inputSender.value.trim();
  const body = getGeneratedSmsBody();
  const structure = el.payloadFormatSelect.value;
  const nowIso = new Date().toISOString();

  if (structure === 'raw_text_body') {
    return body;
  }

  if (structure === 'structured_json') {
    return {
      sender,
      trx_id: el.inputTrxId.value.trim(),
      amount: el.inputAmount.value.trim(),
      currency: el.inputCurrency.value,
      number: el.inputNumber.value.trim(),
      fee: el.inputFee.value.trim(),
      balance: el.inputBalance.value.trim(),
      received_at: nowIso,
    };
  }

  if (structure === 'both_combined') {
    return {
      sender,
      body,
      structured: {
        trx_id: el.inputTrxId.value.trim(),
        amount: el.inputAmount.value.trim(),
        currency: el.inputCurrency.value,
      },
      received_at: nowIso,
    };
  }

  // Default: edgepay_mobile format
  return {
    sender,
    body,
    received_at: nowIso,
  };
}

// Send SMS Transmission
async function sendSmsTransmission(payloadObj = null) {
  const payload = payloadObj || buildPayload();
  const targetUrl = el.targetUrlInput.value.trim();
  const method = el.httpMethodSelect.value;
  const useRelay = el.relayProxyCheckbox.checked;

  const headers = { 'Content-Type': 'application/json' };
  const authType = el.authTypeSelect.value;
  const token = el.authTokenInput.value.trim();

  if (token) {
    if (authType === 'bearer') headers['Authorization'] = `Bearer ${token}`;
    else if (authType === 'apiKey') headers['X-API-Key'] = token;
    else if (authType === 'custom') headers['Authorization'] = token;
  }

  const startTime = performance.now();
  el.responseStatusBadge.className = 'badge ready';
  el.responseStatusBadge.textContent = 'Sending...';
  el.responseLatency.textContent = 'Latency: ...';

  playSmsChime();

  try {
    let res;
    if (useRelay) {
      // Use local Node.js relay proxy endpoint
      res = await fetch('/api/relay/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_url: targetUrl,
          method,
          headers,
          payload,
        }),
      });
    } else {
      // Direct fetch from browser
      res = await fetch(targetUrl, {
        method,
        headers,
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    }

    const duration = Math.round(performance.now() - startTime);
    const json = await res.json().catch(() => ({ statusText: res.statusText }));

    const isOk = res.status >= 200 && res.status < 300;
    el.responseStatusBadge.className = `badge ${isOk ? 'success' : 'error'}`;
    el.responseStatusBadge.textContent = `${res.status} ${isOk ? 'OK' : 'Error'}`;
    el.responseLatency.textContent = `Latency: ${duration} ms`;
    el.responsePre.textContent = JSON.stringify(json, null, 2);

    addHistoryEntry({
      time: new Date().toLocaleTimeString(),
      sender: el.inputSender.value,
      trx_id: el.inputTrxId.value,
      amount: `${el.inputAmount.value} ${el.inputCurrency.value}`,
      status: res.status,
      latency: `${duration}ms`,
      payload,
    });

    return { success: isOk, status: res.status, duration };
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    el.responseStatusBadge.className = 'badge error';
    el.responseStatusBadge.textContent = 'Network Error';
    el.responseLatency.textContent = `Latency: ${duration} ms`;
    el.responsePre.textContent = JSON.stringify({ error: err.message }, null, 2);

    addHistoryEntry({
      time: new Date().toLocaleTimeString(),
      sender: el.inputSender.value,
      trx_id: el.inputTrxId.value,
      amount: `${el.inputAmount.value} ${el.inputCurrency.value}`,
      status: 'ERR',
      latency: `${duration}ms`,
      payload,
    });

    return { success: false, error: err.message };
  }
}

// History Table Manager
function addHistoryEntry(entry) {
  state.history.unshift(entry);
  if (state.history.length > 50) state.history.pop();
  renderHistoryTable();
}

function renderHistoryTable() {
  if (el.historyCount) el.historyCount.textContent = state.history.length;
  if (!el.historyTableBody) return;

  if (state.history.length === 0) {
    el.historyTableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
          No SMS messages transmitted yet.
        </td>
      </tr>
    `;
    return;
  }

  el.historyTableBody.innerHTML = state.history.map((h, idx) => `
    <tr>
      <td>${h.time}</td>
      <td><strong>${h.sender}</strong></td>
      <td><code>${h.trx_id}</code></td>
      <td>${h.amount}</td>
      <td>
        <span class="badge ${h.status >= 200 && h.status < 300 ? 'success' : 'error'}">
          ${h.status}
        </span>
      </td>
      <td>${h.latency}</td>
      <td>
        <button class="tiny-btn" onclick="resendHistory(${idx})">Resend</button>
      </td>
    </tr>
  `).join('');
}

window.resendHistory = function(idx) {
  const item = state.history[idx];
  if (item) sendSmsTransmission(item.payload);
};

el.clearHistoryBtn?.addEventListener('click', () => {
  state.history = [];
  renderHistoryTable();
});

// Action Buttons
el.mainSendBtn?.addEventListener('click', () => sendSmsTransmission());
el.phoneQuickSendBtn?.addEventListener('click', () => sendSmsTransmission());

el.randomSendBtn?.addEventListener('click', () => {
  const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
  el.inputTrxId.value = gw.genTrx();
  el.inputNumber.value = getRandomPhone();
  el.inputDateTime.value = getFormattedDateTime();
  updateSmsPreview();
  sendSmsTransmission();
});

// OTP Pairing Logic
async function handlePairing(otpCode, statusEl) {
  if (!otpCode || otpCode.length < 6) {
    statusEl.textContent = '❌ Please enter a valid 6-digit OTP';
    statusEl.style.color = 'var(--accent-primary)';
    return;
  }

  statusEl.textContent = 'Pairing device...';
  statusEl.style.color = 'var(--text-secondary)';

  try {
    const targetUrl = el.targetUrlInput.value.replace(/\/sms$/, '/pair');
    const res = await fetch('/api/relay/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_url: targetUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: {
          token: otpCode,
          device_name: 'Android SMS Simulator',
          fingerprint: 'sim-dev-fp-01',
        },
      }),
    });

    const json = await res.json();
    const token = json.data?.data?.access_token || json.data?.data?.token || json.data?.access_token || json.data?.token || json.data?.jwt_token;
    if (res.ok && token) {
      el.authTokenInput.value = token;
      el.authTypeSelect.value = 'bearer';
      statusEl.textContent = '✓ Device paired successfully! Scoped JWT applied.';
      statusEl.style.color = 'var(--accent-green)';
      if (el.headerStatusText) el.headerStatusText.textContent = 'Paired & Active';
      if (el.headerStatusPill) el.headerStatusPill.style.borderColor = 'var(--accent-green)';
    } else {
      const errMsg = json.data?.error?.message || json.error?.message || 'Invalid or expired OTP';
      statusEl.textContent = `❌ Pairing failed: ${errMsg}`;
      statusEl.style.color = 'var(--accent-primary)';
    }
  } catch (err) {
    statusEl.textContent = `❌ Pairing error: ${err.message}`;
    statusEl.style.color = 'var(--accent-primary)';
  }
}

el.pairDeviceBtn?.addEventListener('click', () => {
  handlePairing(el.pairingOtpInput.value.trim(), el.pairingStatusMsg);
});

el.confirmQuickPairBtn?.addEventListener('click', () => {
  handlePairing(el.modalPairingOtpInput.value.trim(), el.modalPairStatusMsg);
});

// Modals Trigger Handlers
el.openBatchModalBtn?.addEventListener('click', () => el.batchModalOverlay.classList.add('open'));
el.closeBatchModalBtn?.addEventListener('click', () => el.batchModalOverlay.classList.remove('open'));
el.cancelBatchBtn?.addEventListener('click', () => el.batchModalOverlay.classList.remove('open'));

el.quickPairBtn?.addEventListener('click', () => el.quickPairModalOverlay.classList.add('open'));
el.closeQuickPairModalBtn?.addEventListener('click', () => el.quickPairModalOverlay.classList.remove('open'));
el.cancelQuickPairBtn?.addEventListener('click', () => el.quickPairModalOverlay.classList.remove('open'));

// Batch Load Test Execution
el.startBatchBtn?.addEventListener('click', async () => {
  const count = parseInt(el.batchCountInput.value, 10) || 10;
  const interval = parseInt(el.batchIntervalInput.value, 10) || 250;

  el.batchProgressWrap.style.display = 'flex';
  el.startBatchBtn.disabled = true;

  for (let i = 1; i <= count; i++) {
    const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
    el.inputTrxId.value = gw.genTrx();
    el.inputNumber.value = getRandomPhone();
    el.inputDateTime.value = getFormattedDateTime();
    updateSmsPreview();

    await sendSmsTransmission();

    const percent = Math.round((i / count) * 100);
    el.batchProgressBar.style.width = `${percent}%`;
    el.batchProgressText.textContent = `Sending ${i}/${count}...`;
    el.batchPercentText.textContent = `${percent}%`;

    if (i < count) {
      await new Promise(r => setTimeout(r, interval));
    }
  }

  el.startBatchBtn.disabled = false;
  el.batchProgressText.textContent = `✓ Batch completed (${count} sent)`;
});

// Battery Slider Simulator
el.batterySlider?.addEventListener('input', (e) => {
  const val = e.target.value;
  if (el.batteryValText) el.batteryValText.textContent = `${val}%`;
  if (el.phoneBatteryBar) el.phoneBatteryBar.style.width = `${val}%`;
  if (el.phoneBatteryText) el.phoneBatteryText.textContent = `${val}%`;
});

// Server Event Bus Connection (SSE)
if (typeof EventSource !== 'undefined') {
  try {
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (el.serverEventLog) {
          el.serverEventLog.textContent = `[${new Date().toLocaleTimeString()}] ${JSON.stringify(data)}\n` + el.serverEventLog.textContent.slice(0, 1000);
        }
      } catch (_) {}
    };
  } catch (_) {}
}

// Initialize
setGateway('bkash');
updateSmsPreview();
