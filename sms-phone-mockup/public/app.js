/**
 * Android SMS Phone Mockup & Relay Application
 */

// State Management
const state = {
  currentGateway: 'bkash',
  editMode: 'template', // 'template' | 'raw'
  soundEnabled: true,
  theme: 'dark',
  history: [],
  mockMessages: [],
};

// Gateway Presets & Template Generators
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
    avatarColor: '#10b981',
    currency: 'BDT',
    genTrx: () => 'TXN' + Math.floor(10000000 + Math.random() * 90000000),
    templates: {
      received_money: (d) => `A/C *${d.number.slice(-4) || '4589'} credited with ${d.currency} ${d.amount} on ${d.datetime}. Ref/TrxID: ${d.trx_id}. Available Bal: ${d.currency} ${d.balance}`,
      merchant_payment: (d) => `Payment received for ${d.currency} ${d.amount} with Ref ${d.trx_id} on ${d.datetime}. Balance: ${d.currency} ${d.balance}`,
      cash_in: (d) => `Deposit of ${d.currency} ${d.amount} successful. TrxID: ${d.trx_id} at ${d.datetime}. Bal: ${d.currency} ${d.balance}`,
    }
  }
};

// Audio Synthesizer for Android SMS sound
function playSmsSound() {
  if (!state.soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {
    console.warn('Audio not allowed yet or not supported');
  }
}

// Helpers
function getFormattedCurrentDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  return `${day}/${month}/${year} ${hours}:${mins}`;
}

function getRandomPhone() {
  const prefixes = ['017', '018', '019', '016', '013', '014', '015'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  let num = prefix;
  for (let i = 0; i < 8; i++) num += Math.floor(Math.random() * 10);
  return num;
}

function getRandomAmount() {
  const amounts = ['100.00', '250.00', '500.00', '750.00', '1000.00', '1250.00', '1500.00', '2000.00', '2500.00', '5000.00'];
  return amounts[Math.floor(Math.random() * amounts.length)];
}

// Build SMS text from inputs
function buildSmsText() {
  if (state.editMode === 'raw') {
    return document.getElementById('rawSmsText').value.trim();
  }

  const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
  const variant = document.getElementById('templateVariant').value || 'received_money';
  const templateFn = gw.templates[variant] || gw.templates.received_money;

  const data = {
    sender: document.getElementById('inputSender').value,
    trx_id: document.getElementById('inputTrxId').value,
    number: document.getElementById('inputNumber').value,
    amount: parseFloat(document.getElementById('inputAmount').value || 0).toFixed(2),
    currency: document.getElementById('inputCurrency').value,
    fee: parseFloat(document.getElementById('inputFee').value || 0).toFixed(2),
    balance: parseFloat(document.getElementById('inputBalance').value || 0).toFixed(2),
    ref: document.getElementById('inputRef').value,
    datetime: document.getElementById('inputDateTime').value,
  };

  return templateFn(data);
}

// Build JSON payload based on selected format
function buildPayload() {
  const format = document.getElementById('payloadFormatSelect').value;
  const fullText = buildSmsText();
  const sender = document.getElementById('inputSender').value;
  const trxId = document.getElementById('inputTrxId').value;
  const number = document.getElementById('inputNumber').value;
  const amount = document.getElementById('inputAmount').value;
  const currency = document.getElementById('inputCurrency').value;
  const fee = document.getElementById('inputFee').value;
  const balance = document.getElementById('inputBalance').value;
  const nowIso = new Date().toISOString();

  if (format === 'edgepay_mobile') {
    return {
      sender: sender,
      body: fullText,
      received_at: nowIso,
    };
  } else if (format === 'structured_json') {
    return {
      trx_id: trxId,
      sender_number: number,
      amount: amount,
      currency: currency,
      sender: sender,
      gateway: state.currentGateway,
      fee: fee,
      balance: balance,
      raw_sms: fullText,
      timestamp: nowIso,
    };
  } else if (format === 'both_combined') {
    return {
      sender: sender,
      body: fullText,
      received_at: nowIso,
      parsed: {
        trx_id: trxId,
        amount: amount,
        currency: currency,
        number: number,
        gateway: state.currentGateway,
      }
    };
  } else {
    return fullText;
  }
}

// Update all UI elements & live previews
function updateUI() {
  const fullText = buildSmsText();
  const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;

  // Phone screen updates
  document.getElementById('phoneSenderName').textContent = document.getElementById('inputSender').value || gw.name;
  document.getElementById('phoneAvatar').style.background = gw.avatarColor;
  document.getElementById('avatarText').textContent = gw.avatarText;
  document.getElementById('phoneInputPreview').value = fullText;
  document.getElementById('sampleBubbleText').textContent = fullText;

  // Time updates
  const d = new Date();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  document.getElementById('statusBarTime').textContent = `${hours}:${mins}`;
  document.getElementById('sampleBubbleTime').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Outgoing payload preview
  const payload = buildPayload();
  document.getElementById('payloadPreviewCode').textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

// Select Gateway preset
function selectGateway(gwKey) {
  if (!GATEWAYS[gwKey]) return;
  state.currentGateway = gwKey;
  const gw = GATEWAYS[gwKey];

  // Update preset chip buttons
  document.querySelectorAll('.preset-chips .chip').forEach(el => {
    el.classList.toggle('active', el.dataset.gateway === gwKey);
  });

  // Populate inputs with gateway specifics
  document.getElementById('inputSender').value = gw.sender;
  document.getElementById('inputCurrency').value = gw.currency;
  document.getElementById('inputTrxId').value = gw.genTrx();

  updateUI();
}

// Randomize fields
function randomizeAllFields() {
  const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
  document.getElementById('inputTrxId').value = gw.genTrx();
  document.getElementById('inputNumber').value = getRandomPhone();
  document.getElementById('inputAmount').value = getRandomAmount();
  const bal = (Math.random() * 8000 + 500).toFixed(2);
  document.getElementById('inputBalance').value = bal;
  document.getElementById('inputDateTime').value = getFormattedCurrentDate();
  document.getElementById('inputRef').value = 'ord#' + Math.floor(100 + Math.random() * 900);

  updateUI();
}

// Add bubble to phone thread
function appendBubbleToPhone(text, isOutgoing = false) {
  const thread = document.getElementById('messagesThread');
  const bubble = document.createElement('div');
  bubble.className = `sms-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
  
  const d = new Date();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  bubble.innerHTML = `
    <div class="bubble-content">
      <p>${escapeHtml(text)}</p>
    </div>
    <div class="bubble-meta">
      <span class="sms-time">${timeStr}</span>
      <span class="sim-badge">${isOutgoing ? 'SENT' : 'SIM1'}</span>
    </div>
  `;

  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

// Send SMS to Server
async function sendSms() {
  const targetUrl = document.getElementById('targetUrlInput').value.trim();
  const method = document.getElementById('httpMethodSelect').value;
  const useRelay = document.getElementById('relayProxyCheckbox').checked;
  const authType = document.getElementById('authTypeSelect').value;
  const authToken = document.getElementById('authTokenInput').value.trim();
  const payload = buildPayload();
  const fullText = buildSmsText();

  if (!targetUrl) {
    alert('Please enter a target URL');
    return;
  }

  // Visual & Audio triggers
  playSmsSound();
  appendBubbleToPhone(fullText, false);

  // Headers
  const headers = {};
  if (typeof payload === 'object') {
    headers['Content-Type'] = 'application/json';
  } else {
    headers['Content-Type'] = 'text/plain';
  }

  if (authType === 'bearer' && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  } else if (authType === 'apiKey' && authToken) {
    headers['X-API-Key'] = authToken;
  }

  const statusDot = document.getElementById('responseStatusDot');
  const statusBadge = document.getElementById('responseStatusBadge');
  const timeBadge = document.getElementById('responseTimeBadge');
  const bodyViewer = document.getElementById('responseBodyViewer');

  statusBadge.textContent = 'Sending...';
  statusBadge.className = 'metric-badge';
  statusDot.style.background = '#f59e0b';
  bodyViewer.textContent = 'Transmitting request to server...';

  const startTime = Date.now();

  try {
    let result;

    if (useRelay) {
      // Send through server-side proxy
      const res = await fetch('/api/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          method: method,
          headers: headers,
          body: payload,
        }),
      });
      result = await res.json();
    } else {
      // Direct browser fetch
      const res = await fetch(targetUrl, {
        method: method,
        headers: headers,
        body: typeof payload === 'object' ? JSON.stringify(payload) : payload,
      });
      const timeMs = Date.now() - startTime;
      let data;
      try {
        data = await res.json();
      } catch {
        data = await res.text();
      }
      result = {
        success: res.ok,
        status: res.status,
        statusText: res.statusText,
        time_ms: timeMs,
        data: data,
      };
    }

    const duration = result.time_ms || (Date.now() - startTime);
    const isOk = result.status >= 200 && result.status < 300;

    statusBadge.textContent = `Status: ${result.status || 200} ${result.statusText || 'OK'}`;
    statusBadge.className = `metric-badge ${isOk ? 'success' : 'error'}`;
    statusDot.style.background = isOk ? '#10b981' : '#ef4444';
    timeBadge.textContent = `Latency: ${duration} ms`;

    bodyViewer.textContent = typeof result.data === 'object'
      ? JSON.stringify(result.data, null, 2)
      : String(result.data || 'Empty Response');

    // Add to sent history
    addToHistory({
      timestamp: new Date().toLocaleTimeString(),
      gateway: state.currentGateway,
      sender: document.getElementById('inputSender').value,
      trx_id: document.getElementById('inputTrxId').value,
      amount: document.getElementById('inputAmount').value,
      currency: document.getElementById('inputCurrency').value,
      status: result.status || (isOk ? 200 : 500),
      duration: duration,
      body: fullText,
      targetUrl: targetUrl,
    });

  } catch (err) {
    const duration = Date.now() - startTime;
    statusBadge.textContent = 'Status: Failed (Network Error)';
    statusBadge.className = 'metric-badge error';
    statusDot.style.background = '#ef4444';
    timeBadge.textContent = `Latency: ${duration} ms`;
    bodyViewer.textContent = `Fetch error: ${err.message}\n\nTip: Make sure the target server is running or keep "Use Relay Proxy" enabled.`;

    addToHistory({
      timestamp: new Date().toLocaleTimeString(),
      gateway: state.currentGateway,
      sender: document.getElementById('inputSender').value,
      trx_id: document.getElementById('inputTrxId').value,
      amount: document.getElementById('inputAmount').value,
      currency: document.getElementById('inputCurrency').value,
      status: 'ERR',
      duration: duration,
      body: fullText,
      targetUrl: targetUrl,
    });
  }
}

// History Management
function addToHistory(item) {
  state.history.unshift(item);
  if (state.history.length > 50) state.history.pop();
  renderHistory();
}

function renderHistory() {
  const container = document.getElementById('historyList');
  document.getElementById('historyCount').textContent = state.history.length;

  if (state.history.length === 0) {
    container.innerHTML = '<div class="empty-state">No SMS sent yet. Hit Send or Randomize & Send!</div>';
    return;
  }

  container.innerHTML = state.history.map((item, idx) => {
    const isOk = item.status >= 200 && item.status < 300;
    return `
      <div class="history-item">
        <div class="item-left">
          <div class="item-title">
            <span>${item.sender}</span>
            <span class="badge">${item.currency} ${item.amount}</span>
            <span class="badge" style="font-family: monospace;">${item.trx_id}</span>
          </div>
          <div class="item-body">${escapeHtml(item.body)}</div>
        </div>
        <div class="item-right">
          <span class="metric-badge ${isOk ? 'success' : 'error'}">${item.status} (${item.duration}ms)</span>
          <button class="tiny-btn" onclick="resendHistoryItem(${idx})">Resend</button>
        </div>
      </div>
    `;
  }).join('');
}

window.resendHistoryItem = function(idx) {
  const item = state.history[idx];
  if (!item) return;
  document.getElementById('inputSender').value = item.sender;
  document.getElementById('inputTrxId').value = item.trx_id;
  document.getElementById('inputAmount').value = item.amount;
  document.getElementById('inputCurrency').value = item.currency;
  updateUI();
  sendSms();
};

// Mock Server Feed Management
function appendMockFeedItem(entry) {
  const container = document.getElementById('mockFeed');
  if (container.querySelector('.empty-state')) {
    container.innerHTML = '';
  }

  const d = new Date(entry.timestamp);
  const timeStr = d.toLocaleTimeString();

  const itemEl = document.createElement('div');
  itemEl.className = 'feed-item';
  itemEl.innerHTML = `
    <div class="item-left">
      <div class="item-title">
        <span class="status-dot online"></span>
        <span>POST ${entry.endpoint}</span>
        <span class="badge">${timeStr}</span>
      </div>
      <pre style="margin-top: 4px; max-height: 80px; overflow: auto;">${escapeHtml(JSON.stringify(entry.data, null, 2))}</pre>
    </div>
  `;

  container.prepend(itemEl);
}

// Connect SSE stream for live mock feed
function setupSSE() {
  try {
    const evtSource = new EventSource('/api/events');
    evtSource.addEventListener('sms_received', (e) => {
      try {
        const data = JSON.parse(e.data);
        appendMockFeedItem(data);
      } catch (err) {
        console.error('SSE JSON error', err);
      }
    });
  } catch (err) {
    console.warn('SSE not supported or failed to connect', err);
  }
}

// Batch Runner
async function runBatch(count, intervalMs, gatewayMode) {
  const progressContainer = document.getElementById('batchProgressContainer');
  const progressFill = document.getElementById('batchProgressFill');
  const progressText = document.getElementById('batchProgressText');
  const startBtn = document.getElementById('startBatchBtn');

  progressContainer.style.display = 'block';
  startBtn.disabled = true;

  const gwKeys = Object.keys(GATEWAYS);

  for (let i = 1; i <= count; i++) {
    if (gatewayMode === 'random') {
      const randomGw = gwKeys[Math.floor(Math.random() * (gwKeys.length - 1))];
      selectGateway(randomGw);
    } else if (GATEWAYS[gatewayMode]) {
      selectGateway(gatewayMode);
    }

    randomizeAllFields();
    await sendSms();

    const percent = Math.round((i / count) * 100);
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `Sent ${i} / ${count}`;

    if (i < count) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  startBtn.disabled = false;
  setTimeout(() => {
    document.getElementById('batchModal').classList.remove('active');
    progressContainer.style.display = 'none';
  }, 1000);
}

// Event Listeners Initialization
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('inputDateTime').value = getFormattedCurrentDate();

  // Preset chips click
  document.querySelectorAll('.preset-chips .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      selectGateway(btn.dataset.gateway);
    });
  });

  // Inputs change listeners
  const inputsToListen = [
    'inputSender', 'inputTrxId', 'inputNumber', 'inputAmount',
    'inputCurrency', 'inputFee', 'inputBalance', 'inputRef',
    'inputDateTime', 'templateVariant', 'payloadFormatSelect', 'rawSmsText'
  ];

  inputsToListen.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateUI);
      el.addEventListener('change', updateUI);
    }
  });

  // Quick Amount Buttons
  document.querySelectorAll('.quick-amounts .amt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('inputAmount').value = parseFloat(btn.dataset.amt).toFixed(2);
      updateUI();
    });
  });

  // Randomizer buttons
  document.getElementById('genTrxBtn').addEventListener('click', () => {
    const gw = GATEWAYS[state.currentGateway] || GATEWAYS.bkash;
    document.getElementById('inputTrxId').value = gw.genTrx();
    updateUI();
  });

  document.getElementById('genNumBtn').addEventListener('click', () => {
    document.getElementById('inputNumber').value = getRandomPhone();
    updateUI();
  });

  document.getElementById('nowBtn').addEventListener('click', () => {
    document.getElementById('inputDateTime').value = getFormattedCurrentDate();
    updateUI();
  });

  document.getElementById('quickShuffleBtn').addEventListener('click', () => {
    randomizeAllFields();
  });

  // Mode Toggle (Template vs Raw)
  document.querySelectorAll('input[name="smsEditMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      state.editMode = e.target.value;
      const isRaw = state.editMode === 'raw';
      document.getElementById('templateFieldsContainer').style.display = isRaw ? 'none' : 'block';
      document.getElementById('rawSmsContainer').style.display = isRaw ? 'block' : 'none';
      if (isRaw) {
        document.getElementById('rawSmsText').value = document.getElementById('phoneInputPreview').value;
      }
      updateUI();
    });
  });

  // Target preset select
  document.getElementById('targetPresetSelect').addEventListener('change', (e) => {
    if (e.target.value !== 'custom') {
      document.getElementById('targetUrlInput').value = e.target.value;
    }
  });

  // Auth select toggle
  document.getElementById('authTypeSelect').addEventListener('change', (e) => {
    const isNone = e.target.value === 'none';
    const input = document.getElementById('authTokenInput');
    input.disabled = isNone;
    if (isNone) input.value = '';
  });

  // Send buttons
  document.getElementById('phoneSendBtn').addEventListener('click', sendSms);
  document.getElementById('mainSendBtn').addEventListener('click', sendSms);
  document.getElementById('randomSendBtn').addEventListener('click', () => {
    randomizeAllFields();
    sendSms();
  });

  // Tabs switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const targetPane = document.getElementById(`tab-${btn.dataset.tab}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // Top Nav Toggles
  document.getElementById('soundToggleBtn').addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    document.getElementById('soundToggleBtn').innerHTML = state.soundEnabled ? '🔔' : '🔕';
  });

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    document.getElementById('themeToggleBtn').innerHTML = state.theme === 'dark' ? '🌙' : '☀️';
  });

  // Clear buttons
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    state.history = [];
    renderHistory();
  });

  document.getElementById('clearMockBtn').addEventListener('click', async () => {
    await fetch('/api/mock-messages', { method: 'DELETE' });
    document.getElementById('mockFeed').innerHTML = '<div class="empty-state">Waiting for incoming SMS payloads...</div>';
  });

  document.getElementById('refreshMockBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/mock-messages');
      const json = await res.json();
      const container = document.getElementById('mockFeed');
      if (json.messages && json.messages.length > 0) {
        container.innerHTML = '';
        json.messages.forEach(msg => appendMockFeedItem(msg));
      } else {
        container.innerHTML = '<div class="empty-state">No mock messages received yet.</div>';
      }
    } catch (e) {
      console.error(e);
    }
  });

  // Batch Modal
  document.getElementById('batchModalBtn').addEventListener('click', () => {
    document.getElementById('batchModal').classList.add('active');
  });

  document.getElementById('closeBatchModalBtn').addEventListener('click', () => {
    document.getElementById('batchModal').classList.remove('active');
  });

  document.getElementById('cancelBatchBtn').addEventListener('click', () => {
    document.getElementById('batchModal').classList.remove('active');
  });

  document.getElementById('startBatchBtn').addEventListener('click', () => {
    const count = parseInt(document.getElementById('batchCount').value || '5', 10);
    const interval = parseInt(document.getElementById('batchInterval').value || '800', 10);
    const gwMode = document.getElementById('batchGateway').value;
    runBatch(count, interval, gwMode);
  });

  // Init
  selectGateway('bkash');
  setupSSE();
});
