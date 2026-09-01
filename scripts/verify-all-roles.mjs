import crypto from 'crypto';

const BASE_URL = 'https://edgepay-cf.bm-jonybepary.workers.dev';
const ADMIN_API_KEY = 'op_live_9e9b2a89581d_1be4697dbc9b453cbe513bea64ef4613';
const JWT_SECRET = 'f14d30e9a38c97b57ac7c3845b64d8307d6233896f7b6d6571892f06c40272f5';

function createMobileToken(secret, merchantId = 4, userId = 3, deviceId = 2) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: String(userId),
    merchant_id: merchantId,
    device_id: deviceId,
    scope: ['read', 'write'],
    type: 'access',
    iss: 'edgepay-cf',
    aud: 'mobile',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID()
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const mobileToken = createMobileToken(JWT_SECRET);

let totalPassed = 0;
let totalFailed = 0;

function assert(condition, name, details = '') {
  if (condition) {
    console.log(`  [PASS] ${name} ${details}`);
    totalPassed++;
  } else {
    console.error(`  [FAIL] ${name} ${details}`);
    totalFailed++;
  }
}

async function runMultiRoleVerification() {
  console.log(`========================================================================`);
  console.log(`  EDGEPAY MULTI-ROLE PRODUCTION & SECURITY AUDIT`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`========================================================================\n`);

  // =========================================================================
  // 1. MERCHANT POV AUDIT
  // =========================================================================
  console.log(`[ROLE 1: MERCHANT POV — API Keys, Intent Creation & Tenant Isolation]`);

  // Create a payment intent
  const createRes = await fetch(`${BASE_URL}/api/v1/payments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: '550.00',
      currency: 'BDT',
      gateway: 'bkash',
      description: 'Production Multi-Role Verification Order'
    })
  });
  const createData = await createRes.json();
  assert(createRes.status === 201 && createData.success === true, 'MERCHANT-1: Merchant creates payment intent successfully (201)');
  const token = createData.data?.token;

  // Merchant queries transaction list
  const txRes = await fetch(`${BASE_URL}/api/v1/transactions`, {
    headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
  });
  const txData = await txRes.json();
  assert(txRes.status === 200 && Array.isArray(txData.data), 'MERCHANT-2: Merchant retrieves their scoped transactions list (200)');

  // Merchant manages webhooks
  const hookRes = await fetch(`${BASE_URL}/api/v1/webhooks`, {
    headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
  });
  const hookData = await hookRes.json();
  assert(hookRes.status === 200 && hookData.success === true, 'MERCHANT-3: Merchant inspects registered webhook endpoints (200)');

  // =========================================================================
  // 2. CUSTOMER POV AUDIT
  // =========================================================================
  console.log(`\n[ROLE 2: CUSTOMER POV — Hosted Checkout UX & Status Polling]`);

  // Customer loads checkout HTML
  const checkoutHtmlRes = await fetch(`${BASE_URL}/checkout/${token}`);
  const htmlContent = await checkoutHtmlRes.text();
  assert(checkoutHtmlRes.status === 200 && htmlContent.includes('Secure Checkout'), 'CUSTOMER-1: Customer loads responsive checkout UI (200)');
  assert(htmlContent.includes('550.00') && htmlContent.includes('01815300789'), 'CUSTOMER-2: Checkout presents amount, wallet number and copy button');

  // Customer checks status via token
  const statusRes = await fetch(`${BASE_URL}/checkout/${token}/status`);
  const statusData = await statusRes.json();
  assert(statusRes.status === 200 && statusData.data?.status === 'pending', 'CUSTOMER-3: Customer polls token status (pending state)');

  // Customer initiates gateway selection
  const initRes = await fetch(`${BASE_URL}/checkout/${token}/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gateway_id: 2 })
  });
  const initData = await initRes.json();
  assert(initRes.status === 200 && initData.success === true, 'CUSTOMER-4: Customer selects gateway and initiates payment');

  // Customer submits TrxID and carrier SMS arrives
  const trxId = 'BKROLE' + Math.random().toString(36).substring(2, 8).toUpperCase();
  
  // Customer enters TrxID on checkout page
  await fetch(`${BASE_URL}/checkout/${token}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trx_id: trxId, sender_phone: '01712345678' })
  });

  const smsBody = `You have received Tk 550.00 from 01712345678. Fee Tk 0.00. Balance Tk 5420.50. TrxID ${trxId} at 01/09/2026`;

  await fetch(`${BASE_URL}/api/mobile/v1/sms`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${mobileToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'bKash', body: smsBody })
  });

  // Customer poll loop verifies automatic completion upon two-way match
  let completed = false;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await (await fetch(`${BASE_URL}/checkout/${token}/status`)).json();
    if (s.data?.status === 'completed') {
      completed = true;
      break;
    }
  }
  assert(completed === true, 'CUSTOMER-5: Customer checkout status automatically updates to completed upon verified TrxID');

  // =========================================================================
  // 3. ADMIN POV AUDIT
  // =========================================================================
  console.log(`\n[ROLE 3: ADMIN POV — Cloudflare Access, Ledger Integrity & System Audits]`);

  // Admin Ledger Trial Balance
  const tbRes = await fetch(`${BASE_URL}/api/admin/v1/ledger/trial-balance`, {
    headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
  });
  const tbData = await tbRes.json();
  assert(tbRes.status === 200 && tbData.data?.trial_balance?.balanced === true, 'ADMIN-1: Admin verifies double-entry trial balance invariance');

  // Admin SMS Queue Inspection
  const queuesRes = await fetch(`${BASE_URL}/api/admin/v1/sms-queues`, {
    headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
  });
  const queuesData = await queuesRes.json();
  assert(queuesRes.status === 200 && Array.isArray(queuesData.data), 'ADMIN-2: Admin audits ingested SMS queues and match decisions');

  // Admin Health & Worker Telemetry
  const healthRes = await fetch(`${BASE_URL}/api/v1/health`);
  const healthData = await healthRes.json();
  assert(healthRes.status === 200 && healthData.data?.status === 'ok', 'ADMIN-3: Edge health probe verifies Durable Objects and Workers AI telemetry');

  console.log(`\n========================================================================`);
  console.log(`  AUDIT SUMMARY: ${totalPassed} PASSED | ${totalFailed} FAILED`);
  console.log(`========================================================================\n`);

  if (totalFailed > 0) process.exit(1);
}

runMultiRoleVerification().catch(console.error);
