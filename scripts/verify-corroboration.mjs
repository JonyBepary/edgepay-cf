import fs from 'fs';

function loadEnv() {
  if (fs.existsSync('.dev.vars')) {
    const lines = fs.readFileSync('.dev.vars', 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}
loadEnv();

const BASE_URL = process.env.EDGE_PAY_BASE_URL || 'https://edgepay-cf.bm-jonybepary.workers.dev';
const M8_KEY = process.env.EDGE_PAY_KEY || process.env.M8_KEY;

if (!M8_KEY) {
  console.error('ERROR: Missing EDGE_PAY_KEY / M8_KEY. Please set in environment or .dev.vars');
  process.exit(1);
}

async function getFreshJwt() {
  if (!fs.existsSync('sms-phone-mockup/.companion-state.json')) {
    throw new Error('Missing sms-phone-mockup/.companion-state.json. Pair the phone simulator first.');
  }
  const state = JSON.parse(fs.readFileSync('sms-phone-mockup/.companion-state.json', 'utf8'));
  const res = await fetch(BASE_URL + '/api/mobile/v1/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: state.refresh_token })
  });
  const data = await res.json();
  if (!data.success || !data.data?.access_token) {
    throw new Error('Failed to refresh mobile access token: ' + JSON.stringify(data));
  }
  return data.data.access_token;
}

async function testTwoWayCorroboration() {
  const M8_JWT = await getFreshJwt();
  console.log('========================================================================');
  console.log('  TESTING TWO-WAY MANUAL TRXID CORROBORATION ON LIVE CLOUDFLARE EDGE');
  console.log('========================================================================\n');

  // ---------------------------------------------------------------------------
  // SCENARIO 1: Customer Submits TrxID First -> Carrier SMS arrives later
  // ---------------------------------------------------------------------------
  console.log('--- SCENARIO 1: Customer Submits TrxID FIRST -> SMS arrives later ---');
  const trx1 = 'BKTEST' + Math.floor(100000 + Math.random() * 900000);
  
  const p1Res = await fetch(BASE_URL + '/api/v1/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + M8_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '450.00', currency: 'BDT', gateway: 'bkash', description: 'Scenario 1 Order' })
  });
  const p1 = await p1Res.json();
  const token1 = p1.data.token;
  console.log('1. Created Payment Intent #' + p1.data.intent_id + ' (Token: ' + token1.slice(0, 16) + '...)');

  const v1Res = await fetch(BASE_URL + '/checkout/' + token1 + '/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trx_id: trx1, sender_phone: '01711002233' })
  });
  const v1 = await v1Res.json();
  console.log('2. Customer TrxID Submission Result:', v1.data?.status, '-', v1.data?.message);

  console.log('3. Paired phone relays carrier SMS with TrxID:', trx1);
  await fetch(BASE_URL + '/api/mobile/v1/sms', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + M8_JWT, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: 'bKash',
      body: 'You have received Tk 450.00 from 01711002233. Fee Tk 0.00. Balance Tk 25,000.00. TrxID ' + trx1 + ' at 01/09/2026 11:30'
    })
  });

  let s1Completed = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const stRes = await fetch(BASE_URL + '/checkout/' + token1 + '/status');
    const st = await stRes.json();
    if (st.data?.status === 'completed') {
      s1Completed = true;
      console.log('4. ✅ SCENARIO 1 PASSED: Intent completed upon SMS arrival with matched TrxID:', st.data.trx_id);
      break;
    }
  }
  if (!s1Completed) throw new Error('SCENARIO 1 FAILED to complete in time');

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Carrier SMS arrives FIRST -> Customer Submits TrxID Later
  // ---------------------------------------------------------------------------
  console.log('\n--- SCENARIO 2: Carrier SMS arrives FIRST -> Customer Submits TrxID ---');
  const trx2 = 'NGTEST' + Math.floor(100000 + Math.random() * 900000);
  
  const p2Res = await fetch(BASE_URL + '/api/v1/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + M8_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '620.00', currency: 'BDT', gateway: 'nagad', description: 'Scenario 2 Order' })
  });
  const p2 = await p2Res.json();
  const token2 = p2.data.token;
  console.log('1. Created Payment Intent #' + p2.data.intent_id + ' (Token: ' + token2.slice(0, 16) + '...)');

  console.log('2. Phone delivers carrier SMS first to pool (TrxID: ' + trx2 + ')');
  await fetch(BASE_URL + '/api/mobile/v1/sms', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + M8_JWT, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: 'NAGAD',
      body: 'You have received Tk 620.00 from 01822334455. Fee Tk 0.00. Balance Tk 30,000.00. TrxID ' + trx2 + ' at 01/09/2026 11:30'
    })
  });
  await new Promise(r => setTimeout(r, 4000));

  console.log('3. Customer now submits TrxID ' + trx2 + ' on checkout page...');
  const v2Res = await fetch(BASE_URL + '/checkout/' + token2 + '/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trx_id: trx2, sender_phone: '01822334455' })
  });
  const v2 = await v2Res.json();
  let s2Completed = v2.data?.status === 'completed';
  if (!s2Completed) {
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const stRes = await fetch(BASE_URL + '/checkout/' + token2 + '/status');
      const st = await stRes.json();
      if (st.data?.status === 'completed') {
        s2Completed = true;
        break;
      }
    }
  }
  if (s2Completed) {
    console.log('✅ SCENARIO 2 PASSED: Verified and settled successfully from carrier SMS pool!');
  } else {
    throw new Error('SCENARIO 2 FAILED: ' + JSON.stringify(v2));
  }

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Anti-Fraud Guard (Duplicate Replay Attack Blocked)
  // ---------------------------------------------------------------------------
  console.log('\n--- SCENARIO 3: Anti-Fraud Guard (Duplicate Replay Attack) ---');
  const p3Res = await fetch(BASE_URL + '/api/v1/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + M8_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '620.00', currency: 'BDT', gateway: 'nagad', description: 'Scenario 3 Fraud Attempt' })
  });
  const p3 = await p3Res.json();
  const token3 = p3.data.token;

  const v3Res = await fetch(BASE_URL + '/checkout/' + token3 + '/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trx_id: trx2, sender_phone: '01822334455' })
  });
  const v3 = await v3Res.json();
  console.log('Duplicate TrxID response:', v3);
  if (v3.error?.code === 'TRX_ALREADY_USED') {
    console.log('✅ SCENARIO 3 PASSED: Successfully blocked replay attack of already-claimed TrxID!');
  } else {
    throw new Error('SCENARIO 3 FAILED: Did not block duplicate TrxID');
  }

  console.log('\n========================================================================');
  console.log('  ALL TWO-WAY CORROBORATION & ANTI-FRAUD TESTS PASSED 100%! 🚀');
  console.log('========================================================================\n');
}

testTwoWayCorroboration().catch(err => {
  console.error(err);
  process.exit(1);
});
