#!/usr/bin/env node

/**
 * Standalone Android SMS Phone Mockup & Automated Companion Server
 * 
 * Zero external dependencies. Runs on Node 18+
 * Features:
 * - Full Android Phone Webview UI on Port 3300
 * - Automated 30s Heartbeat Loop (POST /api/mobile/v1/heartbeat)
 * - Local FIFO Outbox Queue with Exponential Backoff Retries
 * - 1-Click 6-Digit OTP Pairing Loop (POST /api/mobile/v1/pair)
 * - Background Traffic Generator Loop (Realistic & Adversarial MFS Payments)
 * - Live Server-Sent Events (SSE) stream for terminal & UI synchronization
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3300', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.companion-state.json');

// In-memory stores
const receivedMessages = [];
const outboxQueue = [];
const sseClients = new Set();

// Companion Configuration & State
let companionState = {
  edgepay_url: process.env.EDGEPAY_URL || 'http://localhost:8787',
  jwt_token: process.env.MOBILE_JWT || '',
  refresh_token: '',
  paired: false,
  merchant_id: null,
  device_uuid: `dev_${crypto.randomBytes(6).toString('hex')}`,
  device_name: 'Samsung Galaxy A54 (EdgePay Companion)',
  auto_relay_enabled: true,
  simulation_active: false,
  simulation_interval_ms: 10000,
  last_heartbeat_at: null,
  battery_level: 94,
  is_charging: true,
  carrier: 'Grameenphone 4G',
};

// Load saved state if exists
if (fs.existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    companionState = { ...companionState, ...saved };
  } catch (_) {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(companionState, null, 2));
  } catch (_) {}
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function log(level, message, detail = '') {
  const time = new Date().toLocaleTimeString();
  let tag = `[${time}]`;
  if (level === 'INFO') tag = `${colors.cyan}${tag} [INFO]${colors.reset}`;
  else if (level === 'OK') tag = `${colors.green}${tag} [SUCCESS]${colors.reset}`;
  else if (level === 'WARN') tag = `${colors.yellow}${tag} [WARN]${colors.reset}`;
  else if (level === 'ERR') tag = `${colors.red}${tag} [ERROR]${colors.reset}`;
  else if (level === 'SMS') tag = `${colors.magenta}${tag} [SMS-EVENT]${colors.reset}`;
  else if (level === 'HEARTBEAT') tag = `${colors.blue}${tag} [HEARTBEAT]${colors.reset}`;

  console.log(`${tag} ${message} ${detail ? colors.dim + (typeof detail === 'object' ? JSON.stringify(detail) : detail) + colors.reset : ''}`);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!body) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(body);
      }
    });
    req.on('error', reject);
  });
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

function broadcastEvent(type, data) {
  const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function refreshAccessToken() {
  if (!companionState.refresh_token || !companionState.edgepay_url) {
    return false;
  }
  const endpoint = `${companionState.edgepay_url.replace(/\/$/, '')}/api/mobile/v1/refresh`;
  log('INFO', 'Refreshing expired mobile access token...');
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: companionState.refresh_token }),
    });
    const data = await res.json();
    if (res.ok && data.success && (data.data?.access_token || data.data?.token)) {
      companionState.jwt_token = data.data.access_token || data.data.token;
      saveState();
      log('OK', 'Mobile access token refreshed successfully!');
      return true;
    }
  } catch (err) {
    log('WARN', `Token refresh failed: ${err.message}`);
  }
  return false;
}

// -----------------------------------------------------------------------------
// LOOP 1: AUTOMATED HEARTBEAT LOOP (Every 30 Seconds)
// -----------------------------------------------------------------------------
async function sendHeartbeat() {
  if (!companionState.jwt_token || !companionState.edgepay_url) {
    return;
  }

  const endpoint = `${companionState.edgepay_url.replace(/\/$/, '')}/api/mobile/v1/heartbeat`;
  const payload = {
    battery_level: companionState.battery_level,
    is_charging: companionState.is_charging,
    network_type: 'wifi',
    carrier: companionState.carrier,
    app_version: '2.1.0',
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${companionState.jwt_token}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      companionState.last_heartbeat_at = new Date().toISOString();
      companionState.paired = true;
      saveState();
      broadcastEvent('heartbeat', { status: 'online', timestamp: companionState.last_heartbeat_at });
      log('HEARTBEAT', 'Companion device heartbeat synced successfully');
    } else if (res.status === 401) {
      log('WARN', 'Heartbeat received HTTP 401 (token expired), attempting auto-refresh...');
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        setTimeout(sendHeartbeat, 1000);
      }
    } else {
      log('WARN', `Heartbeat returned HTTP ${res.status}`);
    }
  } catch (err) {
    log('WARN', `Heartbeat ping failed: ${err.message}`);
  }
}

setInterval(sendHeartbeat, 30000);
setTimeout(sendHeartbeat, 2000);

// -----------------------------------------------------------------------------
// LOOP 2: FIFO OUTBOX QUEUE & AUTO-RETRY LOOP (Every 2 Seconds)
// -----------------------------------------------------------------------------
let isProcessingQueue = false;

async function processOutboxQueue() {
  if (isProcessingQueue || outboxQueue.length === 0) return;
  if (!companionState.jwt_token || !companionState.edgepay_url || !companionState.auto_relay_enabled) return;

  isProcessingQueue = true;
  const now = Date.now();

  for (let i = 0; i < outboxQueue.length; i++) {
    const item = outboxQueue[i];
    if (item.status === 'delivering' || (item.next_retry_at && item.next_retry_at > now)) {
      continue;
    }

    item.status = 'delivering';
    item.attempts = (item.attempts || 0) + 1;

    const endpoint = `${companionState.edgepay_url.replace(/\/$/, '')}/api/mobile/v1/sms`;
    log('INFO', `[Queue] Relaying SMS (Attempt ${item.attempts}) -> ${endpoint}`);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${companionState.jwt_token}`,
        },
        body: JSON.stringify(item.payload),
      });

      const responseBody = await res.json().catch(() => ({}));

      if (res.status === 401) {
        log('WARN', '[Queue] Received 401 (token expired), refreshing token...');
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          item.status = 'queued';
          item.next_retry_at = Date.now() + 500;
          continue;
        }
      }

      if (res.ok && responseBody.success !== false) {
        log('OK', `[Queue] SMS delivered successfully! Match status: ${responseBody.data?.match_status || 'received'}`);
        item.status = 'delivered';
        item.delivered_at = new Date().toISOString();
        item.response = responseBody;
        broadcastEvent('sms_delivered', item);
        outboxQueue.splice(i, 1);
        i--;
      } else {
        throw new Error(responseBody.error?.message || `HTTP ${res.status}`);
      }
    } catch (err) {
      log('WARN', `[Queue] Delivery failed (attempt ${item.attempts}): ${err.message}`);
      if (item.attempts >= 5) {
        item.status = 'failed_terminal';
        item.last_error = err.message;
        broadcastEvent('sms_failed', item);
        outboxQueue.splice(i, 1);
        i--;
      } else {
        item.status = 'retry_scheduled';
        const delayMs = Math.min(60000, 2000 * Math.pow(2, item.attempts));
        item.next_retry_at = Date.now() + delayMs;
        item.last_error = err.message;
      }
    }
  }

  isProcessingQueue = false;
}

setInterval(processOutboxQueue, 2000);

// -----------------------------------------------------------------------------
// LOOP 3: BACKGROUND TRAFFIC SIMULATOR (MFS Payment Generator)
// -----------------------------------------------------------------------------
let simulationTimer = null;

function generateRandomMfsSms(gateway = 'bkash') {
  const randTrx = () => Math.random().toString(36).substring(2, 12).toUpperCase();
  const randPhone = () => '017' + Math.floor(10000000 + Math.random() * 90000000);
  const randAmount = (Math.floor(Math.random() * 50) * 50 + 100).toFixed(2);
  const dateStr = new Date().toLocaleDateString('en-GB') + ' ' + new Date().toLocaleTimeString();

  if (gateway === 'bkash') {
    return {
      sender: 'bKash',
      body: `You have received Tk ${randAmount} from ${randPhone()}. Fee Tk 0.00. Balance Tk 15,200.00. TrxID ${randTrx()} at ${dateStr}`,
      sim_slot: 1,
    };
  } else if (gateway === 'nagad') {
    return {
      sender: 'Nagad',
      body: `Cash In of Tk ${randAmount} is successful from ${randPhone()}. Fee Tk 0.00. Balance Tk 18,450.00. TxnID: NG${randTrx()} at ${dateStr}`,
      sim_slot: 1,
    };
  } else {
    return {
      sender: '16216',
      body: `TxnId: ${Math.floor(1000000000 + Math.random() * 9000000000)} Tk ${randAmount} From: ${randPhone()}`,
      sim_slot: 2,
    };
  }
}

function startSimulation(intervalMs = 10000) {
  if (simulationTimer) clearInterval(simulationTimer);
  companionState.simulation_active = true;
  companionState.simulation_interval_ms = intervalMs;
  saveState();

  log('INFO', `Traffic simulator active: generating synthetic MFS SMS every ${intervalMs / 1000}s`);

  simulationTimer = setInterval(() => {
    if (!companionState.simulation_active) return;
    const gws = ['bkash', 'nagad', 'rocket'];
    const selectedGw = gws[Math.floor(Math.random() * gws.length)];
    const sms = generateRandomMfsSms(selectedGw);

    // Ingest into received list and enqueue for delivery
    const entry = {
      id: `sim-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sender: sms.sender,
      body: sms.body,
      sim_slot: sms.sim_slot,
      source: 'simulator',
    };

    receivedMessages.unshift(entry);
    if (receivedMessages.length > 100) receivedMessages.pop();
    broadcastEvent('sms_received', entry);

    if (companionState.auto_relay_enabled && companionState.jwt_token) {
      outboxQueue.push({
        id: entry.id,
        created_at: entry.timestamp,
        attempts: 0,
        status: 'queued',
        payload: {
          sender: sms.sender,
          body: sms.body,
          sim_slot: sms.sim_slot,
          received_at: entry.timestamp,
        },
      });
    }
  }, intervalMs);
}

function stopSimulation() {
  if (simulationTimer) clearInterval(simulationTimer);
  simulationTimer = null;
  companionState.simulation_active = false;
  saveState();
  log('INFO', 'Traffic simulator stopped');
}

// -----------------------------------------------------------------------------
// MAIN HTTP ROUTER
// -----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key, X-EdgePay-Signature');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Live Stream
  if (pathname === '/api/events') {
    return handleSSE(req, res);
  }

  // Companion Device Status
  if (pathname === '/api/companion/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        ...companionState,
        queue_depth: outboxQueue.length,
        received_count: receivedMessages.length,
      },
    }));
    return;
  }

  // 1-Click 6-Digit OTP Pairing
  if (pathname === '/api/companion/pair' && req.method === 'POST') {
    try {
      const body = await parseRequestBody(req);
      if (!body || !body.otp) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'OTP is required' }));
        return;
      }

      const edgepayUrl = body.edgepay_url || companionState.edgepay_url;
      const endpoint = `${edgepayUrl.replace(/\/$/, '')}/api/mobile/v1/pair`;

      log('INFO', `Attempting 1-Click pairing with OTP: ${body.otp} -> ${endpoint}`);

      const pairRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: body.otp.trim(),
          device_uuid: companionState.device_uuid,
          device_name: companionState.device_name,
          os_version: 'Android 14',
          app_version: '2.1.0',
        }),
      });

      const pairData = await pairRes.json();
      if (!pairRes.ok || !pairData.success) {
        res.writeHead(pairRes.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: pairData.error?.message || 'Pairing failed' }));
        return;
      }

      companionState.edgepay_url = edgepayUrl;
      companionState.jwt_token = pairData.data.token;
      companionState.refresh_token = pairData.data.refresh_token;
      companionState.merchant_id = pairData.data.merchant_id;
      companionState.paired = true;
      saveState();

      log('OK', `Pairing successful! Paired with Merchant ID: ${companionState.merchant_id}`);
      broadcastEvent('paired', companionState);

      // Trigger immediate heartbeat
      await sendHeartbeat();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: companionState }));
      return;
    } catch (err) {
      log('ERR', 'Pairing error', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
  }

  // Simulation Control
  if (pathname === '/api/companion/simulation' && req.method === 'POST') {
    try {
      const body = await parseRequestBody(req);
      if (body.enabled) {
        startSimulation(body.interval_ms || 10000);
      } else {
        stopSimulation();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { simulation_active: companionState.simulation_active } }));
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
  }

  // Forwarding Relay Proxy (Bypasses Browser CORS)
  if ((pathname === '/api/forward' || pathname === '/api/relay/send') && req.method === 'POST') {
    try {
      const payload = await parseRequestBody(req);
      const targetUrl = payload?.target_url || payload?.url;
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing target url' }));
        return;
      }

      const targetMethod = payload.method || 'POST';
      const targetHeaders = payload.headers || {};
      const rawBody = payload.payload !== undefined ? payload.payload : payload.body;
      const targetBody = typeof rawBody === 'object' ? JSON.stringify(rawBody) : rawBody;

      if (!targetHeaders['Content-Type'] && typeof rawBody === 'object') {
        targetHeaders['Content-Type'] = 'application/json';
      }

      const startTime = Date.now();
      const fetchResponse = await fetch(targetUrl, {
        method: targetMethod,
        headers: targetHeaders,
        body: targetMethod !== 'GET' && targetMethod !== 'HEAD' ? targetBody : undefined,
      });

      const timeMs = Date.now() - startTime;
      let responseBody;
      const contentType = fetchResponse.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        responseBody = await fetchResponse.json().catch(() => ({}));
      } else {
        responseBody = await fetchResponse.text();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        status: fetchResponse.status,
        time_ms: timeMs,
        data: responseBody,
      }));
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
  }

  // Inbound Mock Receiver & Auto-Relay Enqueue
  if (
    (pathname === '/mock-webhook' ||
     pathname === '/api/mobile/v1/sms' ||
     pathname === '/api/mock/receive' ||
     pathname === '/api/mock/sms') &&
    req.method === 'POST'
  ) {
    try {
      const data = await parseRequestBody(req);
      const entry = {
        id: `mock-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: new Date().toISOString(),
        endpoint: pathname,
        data: data,
      };

      receivedMessages.unshift(entry);
      if (receivedMessages.length > 100) receivedMessages.pop();

      log('SMS', `Ingested SMS on ${pathname}`, data);
      broadcastEvent('sms_received', entry);

      // Enqueue to Outbox for EdgePay Cloud Relay if enabled
      if (companionState.auto_relay_enabled && companionState.jwt_token && data) {
        outboxQueue.push({
          id: entry.id,
          created_at: entry.timestamp,
          attempts: 0,
          status: 'queued',
          payload: {
            sender: data.sender || 'bKash',
            body: data.body || data.text || '',
            sim_slot: data.sim_slot || 1,
            received_at: entry.timestamp,
          },
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          status: 'queued_and_relayed',
          id: entry.id,
          received_at: entry.timestamp,
        },
      }));
      return;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
  }

  // Get Messages
  if (pathname === '/api/mock-messages' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, messages: receivedMessages, outbox: outboxQueue }));
    return;
  }

  // Clear Messages
  if (pathname === '/api/mock-messages' && req.method === 'DELETE') {
    receivedMessages.length = 0;
    outboxQueue.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'History cleared' }));
    return;
  }

  // Favicon
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Static Assets
  const ext = path.extname(pathname).toLowerCase();
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (ext && ext !== '.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${pathname}`);
        return;
      }

      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (err2, content) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const fileExt = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[fileExt] || 'application/octet-stream';

    fs.readFile(filePath, (err3, content) => {
      if (err3) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
${colors.bright}${colors.cyan}====================================================${colors.reset}
${colors.bright}${colors.green}  📱 EdgePay Android Companion & SMS Relay Active! 🚀${colors.reset}
${colors.bright}${colors.cyan}====================================================${colors.reset}

  ${colors.bright}UI Webview URL:${colors.reset}       ${colors.yellow}http://localhost:${PORT}${colors.reset}
  ${colors.bright}Target Worker URL:${colors.reset}    ${colors.blue}${companionState.edgepay_url}${colors.reset}
  ${colors.bright}Device Status:${colors.reset}        ${companionState.paired ? colors.green + '🟢 Paired (Merchant #' + companionState.merchant_id + ')' : colors.yellow + '🟡 Unpaired (Enter OTP to Pair)'}${colors.reset}
  ${colors.bright}Heartbeat Loop:${colors.reset}       ${colors.green}Active (30s interval)${colors.reset}
  ${colors.bright}Queue Relay Loop:${colors.reset}     ${colors.green}Active (2s FIFO worker)${colors.reset}
`);
});
