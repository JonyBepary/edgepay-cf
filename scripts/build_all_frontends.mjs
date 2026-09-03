import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

function write(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  console.log(`✓ Wrote ${filePath} (${content.length} bytes)`);
}

// 1. Master Hub HTML from the already written hub file
const hubContent = readFileSync('public/assets/design-system/index.html', 'utf8');
write('frontend/apps/hub/public/index.html', hubContent);

// 2. Focused Standalone Checkout
const checkoutHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EdgePay Checkout — Amber Bites</title>
  <!-- Authentic Sanzo Wada Natural Harmony & Editorial Typography Stack -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" defer></script>
  <style>
    :root {
      --ink: #12181F; --muted: #5B6470; --paper: #EEF1EA; --surface: #FFFFFF;
      --line: #D8DCD2; --line-light: #ECEEE8; --accent: #C97F1E; --accent-soft: #FBF3E6;
      --teal-bg: #DCEEE8; --teal-text: #0B6E5C; --marigold-bg: #F3E3C7; --marigold-text: #8A5A0F;
      --bkash: #D6296B; --nagad: #EA7A1C; --rocket: #6D3FA0; --card: #3A424B;
      --font-sans: 'Public Sans', -apple-system, sans-serif;
      --font-serif: 'Fraunces', Georgia, serif;
      --font-mono: 'IBM Plex Mono', monospace;
      --radius: 10px; --radius-lg: 16px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: #E7EBE1; color: var(--ink); line-height: 1.5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
    .epx-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .epx-serif { font-family: var(--font-serif); font-optical-sizing: auto; }
    .checkout-card { width: 100%; max-width: 420px; background: #FFFFFF; border-radius: var(--radius-lg); border: 1px solid var(--line); overflow: hidden; height: fit-content; box-shadow: 0 14px 34px -10px rgba(18,24,31,.12); }
    .checkout-steps { display: flex; gap: 6px; padding: 18px 22px 0; }
    .checkout-steps span { flex: 1; height: 3px; border-radius: 2px; background: #E7E9E2; transition: background .3s; }
    .checkout-steps span.done { background: var(--accent); }
    .checkout-amount { font-size: 38px; font-weight: 600; color: var(--ink); margin: 2px 0 0; }
    .method { display: flex; align-items: center; gap: 14px; padding: 13px 14px; border: 1.5px solid var(--line); border-radius: 10px; margin-bottom: 9px; cursor: pointer; transition: all .14s; }
    .method:hover { border-color: #B8BDB2; background: #FAFAF8; }
    .method.is-selected { border-color: var(--accent); background: var(--accent-soft); }
    .method__icon { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #fff; flex-shrink: 0; }
    .btn { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-family: inherit; }
    .btn--accent { background: var(--accent); color: #FFF8EE; }
    .btn--primary { background: #12181F; color: #EEF1EA; }
    .card { background: #FFFFFF; border: 1px solid var(--line); border-radius: var(--radius); }
    .card-pad { padding: 16px 18px; }
    .field label { display: block; font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 5px; }
    .field input { width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; background: #FCFCFA; }
  </style>
</head>
<body>
  <div class="checkout-card">
    <div class="checkout-steps">
      <span id="chk-step-bar-1" class="done"></span>
      <span id="chk-step-bar-2"></span>
      <span id="chk-step-bar-3"></span>
    </div>

    <!-- Step 1: Rail Selection -->
    <div id="chk-step-1" style="padding: 20px 24px 26px;">
      <div style="font-size: 12px; color: var(--muted); margin-bottom: 2px;">Amber Bites</div>
      <div class="checkout-amount epx-serif">৳1,250.00</div>
      <div style="font-size: 12px; color: var(--muted); margin: 2px 0 20px;">Order #AB-3021 · 2 items</div>
      
      <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">Choose how to pay</div>
      <div class="method is-selected" id="meth-bkash" onclick="selectCheckoutMethod('bkash')">
        <div class="method__icon" style="background: var(--bkash);">bK</div>
        <div><div style="font-size: 13.5px; font-weight: 600;">bKash</div><div style="font-size: 11.5px; color: var(--muted);">Personal Send Money</div></div>
      </div>
      <div class="method" id="meth-nagad" onclick="selectCheckoutMethod('nagad')">
        <div class="method__icon" style="background: var(--nagad);">Na</div>
        <div><div style="font-size: 13.5px; font-weight: 600;">Nagad</div><div style="font-size: 11.5px; color: var(--muted);">Personal Send Money</div></div>
      </div>
      <div class="method" id="meth-rocket" onclick="selectCheckoutMethod('rocket')">
        <div class="method__icon" style="background: var(--rocket);">Ro</div>
        <div><div style="font-size: 13.5px; font-weight: 600;">Rocket</div><div style="font-size: 11.5px; color: var(--muted);">DBBL MFS</div></div>
      </div>
      <div class="method" id="meth-card" onclick="selectCheckoutMethod('card')">
        <div class="method__icon" style="background: var(--card);">💳</div>
        <div><div style="font-size: 13.5px; font-weight: 600;">Debit / Credit Card</div><div style="font-size: 11.5px; color: var(--muted);">Visa, Mastercard</div></div>
      </div>

      <button class="btn btn--accent" style="width: 100%; justify-content: center; margin-top: 16px; padding: 12px 0; font-size: 14px;" onclick="goToCheckoutStep(2)">Continue</button>
      <div style="display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; font-size: 11.5px; color: var(--muted);">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Secured by EdgePay · Cloudflare Edge
      </div>
    </div>

    <!-- Step 2: Send Money & TrxID -->
    <div id="chk-step-2" style="padding: 20px 24px 26px; display: none;">
      <button onclick="goToCheckoutStep(1)" style="background: none; border: none; display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); cursor: pointer; padding: 0; margin-bottom: 14px; font-family: inherit;">
        ← Back
      </button>
      <div class="card card-pad" style="margin-bottom: 16px; background: #FBF3E6; border-color: #EAD3A5;">
        <div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">Send exactly</div>
        <div class="epx-mono" style="font-size: 22px; font-weight: 700;">৳1,250.00</div>
        <div style="font-size: 12px; color: var(--muted); margin: 8px 0 4px;">To this <span id="target-rail-name">bKash</span> Personal number</div>
        <div class="epx-mono" style="font-size: 16px; font-weight: 700; color: var(--ink);">01815-300789</div>
      </div>
      <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">Then confirm your payment</div>
      <div class="field"><label>Transaction ID from confirmation SMS</label><input id="inp-trxid" placeholder="e.g. BL9A4K8M10" class="epx-mono" style="font-weight: 600; text-transform: uppercase;"></div>
      <div class="field" style="margin-top: 12px;"><label>Number you sent from</label><input placeholder="017XX-XXXXXX" class="epx-mono"></div>
      <button class="btn btn--accent" style="width: 100%; justify-content: center; margin-top: 18px; padding: 12px 0; font-size: 14px;" onclick="verifyPaymentSubmission()">Verify payment</button>
    </div>

    <!-- Step 3: Confirmation Receipt -->
    <div id="chk-step-3" style="padding: 38px 26px 30px; text-align: center; display: none;">
      <div style="width: 58px; height: 58px; border-radius: 50%; background: var(--teal-bg); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--teal-text)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div style="font-size: 18px; font-weight: 700; margin-bottom: 4px;">Payment confirmed</div>
      <p style="font-size: 13px; color: var(--muted); margin: 0 0 20px;">Amber Bites has been notified. Your order #AB-3021 is confirmed.</p>
      <div class="card card-pad" style="text-align: left; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px;"><span style="color: var(--muted);">Amount</span><span class="epx-mono" style="font-weight: 600;">৳1,250.00</span></div>
        <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px;"><span style="color: var(--muted);">Paid via</span><span style="font-weight: 600;" id="res-rail">bKash Personal</span></div>
        <div style="display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px;"><span style="color: var(--muted);">Reference</span><span class="epx-mono" style="font-weight: 600;">edgepay_trx_9F21A</span></div>
      </div>
      <button class="btn btn--primary" style="width: 100%; justify-content: center; padding: 12px 0; font-size: 14px;" onclick="goToCheckoutStep(1)">Return to Amber Bites</button>
    </div>
  </div>

  <script>
    let selectedRail = 'bKash Personal';
    function selectCheckoutMethod(m) {
      document.querySelectorAll('#chk-step-1 .method').forEach(el => el.classList.remove('is-selected'));
      document.getElementById('meth-' + m).classList.add('is-selected');
      const names = { bkash: 'bKash Personal', nagad: 'Nagad Personal', rocket: 'Rocket Personal', card: 'Debit / Credit Card' };
      selectedRail = names[m] || 'bKash Personal';
      document.getElementById('target-rail-name').textContent = selectedRail;
      document.getElementById('res-rail').textContent = selectedRail;
    }

    function goToCheckoutStep(step) {
      document.getElementById('chk-step-1').style.display = step === 1 ? 'block' : 'none';
      document.getElementById('chk-step-2').style.display = step === 2 ? 'block' : 'none';
      document.getElementById('chk-step-3').style.display = step === 3 ? 'block' : 'none';
      document.getElementById('chk-step-bar-1').className = step >= 1 ? 'done' : '';
      document.getElementById('chk-step-bar-2').className = step >= 2 ? 'done' : '';
      document.getElementById('chk-step-bar-3').className = step >= 3 ? 'done' : '';
    }

    function verifyPaymentSubmission() {
      goToCheckoutStep(3);
    }
  </script>
</body>
</html>`;

write('frontend/apps/checkout/public/index.html', checkoutHtml);
write('public/assets/checkout/index.html', checkoutHtml);

// 3. Standalone Merchant
const merchantHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EdgePay Merchant — Amber Bites Operations Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #12181F; --muted: #5B6470; --paper: #EEF1EA; --surface: #FFFFFF;
      --line: #D8DCD2; --line-light: #ECEEE8; --accent: #C97F1E; --accent-soft: #FBF3E6;
      --teal-bg: #DCEEE8; --teal-text: #0B6E5C; --marigold-bg: #F3E3C7; --marigold-text: #8A5A0F;
      --rust-bg: #F5E1DC; --rust-text: #A83E2C; --gray-bg: #E7E9E2; --gray-text: #5B6470;
      --font-sans: 'Public Sans', -apple-system, sans-serif;
      --font-mono: 'IBM Plex Mono', monospace;
      --radius: 10px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: var(--paper); color: var(--ink); line-height: 1.5; -webkit-font-smoothing: antialiased; }
    .epx-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .app-shell { display: flex; min-height: 100vh; }
    .app-sidebar { width: 210px; flex-shrink: 0; background: #FFFFFF; border-right: 1px solid var(--line); padding: 22px 14px; display: flex; flex-direction: column; gap: 4px; }
    .app-sidebar__brand { font-weight: 700; font-size: 16px; padding: 0 10px 20px; line-height: 1.3; }
    .app-sidebar__brand small { font-size: 11px; font-weight: 400; color: var(--muted); display: block; margin-top: 2px; }
    .nav-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; cursor: pointer; border: none; background: transparent; text-align: left; font-family: inherit; }
    .nav-item:hover { background: #F3F5EF; color: var(--ink); }
    .nav-item.active { background: #12181F; color: #EEF1EA; font-weight: 600; }
    .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .app-main { flex: 1; min-width: 0; padding: 28px 32px; overflow-y: auto; }
    .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; gap: 12px; flex-wrap: wrap; }
    .page-head h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
    .page-head p { font-size: 13px; color: var(--muted); margin: 3px 0 0; }
    .btn { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-family: inherit; }
    .btn--primary { background: #12181F; color: #EEF1EA; }
    .btn--accent { background: var(--accent); color: #FFF8EE; }
    .btn--ghost { background: transparent; border-color: var(--line); color: var(--ink); }
    .btn--danger-ghost { background: transparent; border-color: #E3C4BC; color: #A83E2C; }
    .card { background: #FFFFFF; border: 1px solid var(--line); border-radius: var(--radius); }
    .card-pad { padding: 18px 20px; }
    .stat-row { display: grid; gap: 14px; margin-bottom: 22px; }
    .stat-card { background: #FFFFFF; border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
    .stat-card__label { font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 6px; }
    .stat-card__value { font-size: 22px; font-weight: 600; color: var(--ink); }
    table.dtable { width: 100%; border-collapse: collapse; font-size: 13px; }
    .dtable th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11.5px; padding: 0 14px 10px; border-bottom: 1px solid var(--line); text-transform: uppercase; letter-spacing: .04em; }
    .dtable td { padding: 12px 14px; border-bottom: 1px solid var(--line-light); vertical-align: middle; }
    .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 20px; }
    .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .badge--teal { background: var(--teal-bg); color: var(--teal-text); }
    .badge--marigold { background: var(--marigold-bg); color: var(--marigold-text); }
    .badge--rust { background: var(--rust-bg); color: var(--rust-text); }
    .badge--gray { background: var(--gray-bg); color: var(--gray-text); }
    .gw-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 12px; background: #FFF; }
    .gw-card__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .gw-form { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--line); display: flex; flex-direction: column; gap: 12px; }
    .field label { display: block; font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 5px; }
    .field input { width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; background: #FCFCFA; }
    .pair-code { font-size: 34px; letter-spacing: 6px; font-weight: 700; background: #12181F; color: #EEF1EA; padding: 16px 26px; border-radius: 10px; display: inline-block; }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="app-sidebar__brand">Amber Bites<small>EdgePay Merchant Operations</small></div>
      <button class="nav-item active" id="mer-nav-dashboard" onclick="switchMerchantTab('dashboard')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
        Dashboard
      </button>
      <button class="nav-item" id="mer-nav-gateways" onclick="switchMerchantTab('gateways')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        Gateways
      </button>
      <button class="nav-item" id="mer-nav-pairing" onclick="switchMerchantTab('pairing')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="20" x="5" y="2" rx="2"/><line x1="12" x2="12.01" y1="18" y2="18"/></svg>
        Mobile pairing
      </button>
      <button class="nav-item" id="mer-nav-developers" onclick="switchMerchantTab('developers')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
        Developers
      </button>
    </aside>
    <main class="app-main">
      <!-- Dashboard Tab -->
      <div id="mer-tab-dashboard">
        <div class="page-head"><div><h2>Dashboard</h2><p>Today's volume and recent activity</p></div></div>
        <div class="stat-row" style="grid-template-columns: repeat(3, 1fr);">
          <div class="stat-card"><div class="stat-card__label">Today's volume</div><div class="stat-card__value epx-mono">৳8,930.00</div></div>
          <div class="stat-card"><div class="stat-card__label">Transactions</div><div class="stat-card__value epx-mono">14</div></div>
          <div class="stat-card"><div class="stat-card__label">Awaiting SMS</div><div class="stat-card__value epx-mono">2</div></div>
        </div>
        <div class="card card-pad">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 12px;">Recent transactions</div>
          <table class="dtable">
            <thead><tr><th>Reference</th><th>Gateway</th><th>Amount</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              <tr><td class="epx-mono" style="font-size: 12px; font-weight: 600;">edgepay_trx_9F21A</td><td>bKash Personal</td><td class="epx-mono">৳1,250.00</td><td><span class="badge badge--teal">completed</span></td><td class="epx-mono" style="color: var(--muted); font-size: 12px;">2m ago</td></tr>
              <tr><td class="epx-mono" style="font-size: 12px; font-weight: 600;">edgepay_trx_9F20B</td><td>Nagad</td><td class="epx-mono">৳640.00</td><td><span class="badge badge--marigold">pending</span></td><td class="epx-mono" style="color: var(--muted); font-size: 12px;">6m ago</td></tr>
              <tr><td class="epx-mono" style="font-size: 12px; font-weight: 600;">edgepay_trx_9F19C</td><td>bKash Personal</td><td class="epx-mono">৳3,200.00</td><td><span class="badge badge--teal">completed</span></td><td class="epx-mono" style="color: var(--muted); font-size: 12px;">14m ago</td></tr>
              <tr><td class="epx-mono" style="font-size: 12px; font-weight: 600;">edgepay_trx_9F18D</td><td>Rocket</td><td class="epx-mono">৳480.00</td><td><span class="badge badge--rust">failed</span></td><td class="epx-mono" style="color: var(--muted); font-size: 12px;">22m ago</td></tr>
              <tr><td class="epx-mono" style="font-size: 12px; font-weight: 600;">edgepay_trx_9F17E</td><td>bKash Personal</td><td class="epx-mono">৳1,980.00</td><td><span class="badge badge--gray">refunded</span></td><td class="epx-mono" style="color: var(--muted); font-size: 12px;">1h ago</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Gateways Tab -->
      <div id="mer-tab-gateways" style="display: none;">
        <div class="page-head"><div><h2>Payment gateways</h2><p>Configure the rails you accept from your customers</p></div></div>
        <div class="gw-card">
          <div class="gw-card__row">
            <div><div class="gw-card__name">bKash Personal</div><div class="gw-card__fields">Personal number: 01815-300789</div></div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="badge badge--teal">Connected</span>
              <button class="btn btn--ghost" onclick="toggleGwForm('bkash')">Manage</button>
            </div>
          </div>
          <div class="gw-form" id="gw-form-bkash" style="display: none;">
            <div class="field"><label>Receiving Mobile Number</label><input value="01815300789"></div>
            <div style="display: flex; gap: 8px;"><button class="btn btn--accent" onclick="alert('Saved bKash settings')">Save and test</button></div>
          </div>
        </div>
        <div class="gw-card">
          <div class="gw-card__row">
            <div><div class="gw-card__name">Nagad Send Money</div><div class="gw-card__fields">Personal account number</div></div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="badge badge--gray">Not connected</span>
              <button class="btn btn--ghost" onclick="toggleGwForm('nagad')">Connect</button>
            </div>
          </div>
          <div class="gw-form" id="gw-form-nagad" style="display: none;">
            <div class="field"><label>Nagad Account Number</label><input placeholder="017XXXXXXXX"></div>
            <div style="display: flex; gap: 8px;"><button class="btn btn--accent" onclick="alert('Saved Nagad settings')">Save and test</button></div>
          </div>
        </div>
      </div>

      <!-- Pairing Tab -->
      <div id="mer-tab-pairing" style="display: none;">
        <div class="page-head"><div><h2>Mobile pairing</h2><p>Pair a physical phone to forward incoming payment SMS</p></div></div>
        <div class="card card-pad" style="margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--teal-text);"></span>
            <span style="font-weight: 600; font-size: 14px;">Shop counter Pixel 7</span>
          </div>
          <p style="font-size: 12px; color: var(--muted); margin: 0 0 12px 18px;">Last check-in 30 seconds ago · battery 88%</p>
          <button class="btn btn--danger-ghost" style="margin-left: 18px;">Unpair this device</button>
        </div>
        <div class="card card-pad">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">Pair another device</div>
          <p style="font-size: 12px; color: var(--muted); margin-bottom: 14px;">Open EdgePay Android companion app, tap "Pair device", and enter this code.</p>
          <div id="pairing-code-display" style="display: none;">
            <div class="pair-code epx-mono">482 913</div>
            <p style="font-size: 12px; color: var(--muted); margin-top: 10px;">Expires in <span class="epx-mono" style="font-weight: 600;">9:47</span></p>
          </div>
          <button class="btn btn--accent" id="btn-gen-pair" onclick="generatePairCode()">Generate pairing code</button>
        </div>
      </div>

      <!-- Developers Tab -->
      <div id="mer-tab-developers" style="display: none;">
        <div class="page-head"><div><h2>Developers</h2><p>API keys and payment webhooks</p></div></div>
        <div class="card card-pad" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 13px; font-weight: 600;">API keys</div>
            <button class="btn btn--ghost" onclick="alert('Creating key')">＋ Create key</button>
          </div>
          <table class="dtable">
            <thead><tr><th>Name</th><th>Key prefix</th><th>Scopes</th><th>Last used</th></tr></thead>
            <tbody>
              <tr><td style="font-weight: 600;">Production backend</td><td class="epx-mono" style="font-size: 12px;">op_live_a1b2••••</td><td><span class="badge badge--teal">read, write</span></td><td class="epx-mono" style="color: var(--muted); font-size: 12px;">5m ago</td></tr>
            </tbody>
          </table>
        </div>
        <div class="card card-pad">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Payment notifications (Webhooks)</div>
          <p style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">Signed HMAC-SHA256 payload delivered on every payment state transition.</p>
          <div class="field"><label>Endpoint URL</label><input value="https://amberbites.com/api/edgepay/webhook" readonly></div>
          <div style="display: flex; gap: 8px; margin: 12px 0 16px;">
            <button class="btn btn--ghost" onclick="sendTestWebhook()">Send test event</button>
            <span id="webhook-toast" style="font-size: 12px; color: var(--teal-text); font-weight: 600; display: none; align-items: center;">✓ 200 OK Delivered in 38ms</span>
          </div>
        </div>
      </div>
    </main>
  </div>
  <script>
    function switchMerchantTab(tab) {
      document.querySelectorAll('.app-sidebar .nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('mer-nav-' + tab).classList.add('active');
      document.getElementById('mer-tab-dashboard').style.display = tab === 'dashboard' ? 'block' : 'none';
      document.getElementById('mer-tab-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('mer-tab-pairing').style.display = tab === 'pairing' ? 'block' : 'none';
      document.getElementById('mer-tab-developers').style.display = tab === 'developers' ? 'block' : 'none';
    }
    function toggleGwForm(gw) {
      const f = document.getElementById('gw-form-' + gw);
      f.style.display = f.style.display === 'none' ? 'flex' : 'none';
    }
    function generatePairCode() {
      document.getElementById('pairing-code-display').style.display = 'block';
      document.getElementById('btn-gen-pair').style.display = 'none';
    }
    function sendTestWebhook() {
      const toast = document.getElementById('webhook-toast');
      toast.style.display = 'inline-flex';
      setTimeout(() => { toast.style.display = 'none'; }, 2500);
    }
  </script>
</body>
</html>`;

write('frontend/apps/merchant/public/index.html', merchantHtml);
write('public/assets/merchant/index.html', merchantHtml);

// 4. Standalone Admin
const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EdgePay Admin — Platform Operations & Tenant Management</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #12181F; --muted: #5B6470; --paper: #EEF1EA; --surface: #FFFFFF;
      --line: #D8DCD2; --line-light: #ECEEE8; --accent: #C97F1E; --accent-soft: #FBF3E6;
      --teal-bg: #DCEEE8; --teal-text: #0B6E5C; --marigold-bg: #F3E3C7; --marigold-text: #8A5A0F;
      --font-sans: 'Public Sans', -apple-system, sans-serif;
      --font-mono: 'IBM Plex Mono', monospace;
      --radius: 10px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-sans); background: var(--paper); color: var(--ink); line-height: 1.5; -webkit-font-smoothing: antialiased; }
    .epx-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .app-shell { display: flex; min-height: 100vh; }
    .app-sidebar { width: 210px; flex-shrink: 0; background: #FFFFFF; border-right: 1px solid var(--line); padding: 22px 14px; display: flex; flex-direction: column; gap: 4px; }
    .app-sidebar__brand { font-weight: 700; font-size: 16px; padding: 0 10px 20px; line-height: 1.3; }
    .app-sidebar__brand small { font-size: 11px; font-weight: 400; color: var(--muted); display: block; margin-top: 2px; }
    .nav-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #3A424B; cursor: pointer; border: none; background: transparent; text-align: left; font-family: inherit; }
    .nav-item:hover { background: #F3F5EF; color: var(--ink); }
    .nav-item.active { background: #12181F; color: #EEF1EA; font-weight: 600; }
    .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .app-main { flex: 1; min-width: 0; padding: 28px 32px; overflow-y: auto; }
    .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; gap: 12px; flex-wrap: wrap; }
    .page-head h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
    .page-head p { font-size: 13px; color: var(--muted); margin: 3px 0 0; }
    .btn { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-family: inherit; }
    .btn--accent { background: var(--accent); color: #FFF8EE; }
    .btn--ghost { background: transparent; border-color: var(--line); color: var(--ink); }
    .card { background: #FFFFFF; border: 1px solid var(--line); border-radius: var(--radius); }
    .card-pad { padding: 18px 20px; }
    .stat-row { display: grid; gap: 14px; margin-bottom: 22px; }
    .stat-card { background: #FFFFFF; border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
    .stat-card__label { font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 6px; }
    .stat-card__value { font-size: 22px; font-weight: 600; color: var(--ink); }
    table.dtable { width: 100%; border-collapse: collapse; font-size: 13px; }
    .dtable th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11.5px; padding: 0 14px 10px; border-bottom: 1px solid var(--line); text-transform: uppercase; letter-spacing: .04em; }
    .dtable td { padding: 12px 14px; border-bottom: 1px solid var(--line-light); vertical-align: middle; }
    .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 20px; }
    .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .badge--teal { background: var(--teal-bg); color: var(--teal-text); }
    .badge--marigold { background: var(--marigold-bg); color: var(--marigold-text); }
    .field input { width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; font-family: inherit; background: #FCFCFA; }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="app-sidebar__brand">EdgePay <span style="color: var(--accent);">Admin</span><small>Platform Console</small></div>
      <button class="nav-item active" id="adm-nav-merchants" onclick="switchAdminTab('merchants')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/></svg>
        Merchants
      </button>
      <button class="nav-item" id="adm-nav-analytics" onclick="switchAdminTab('analytics')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
        Analytics
      </button>
      <button class="nav-item" id="adm-nav-devices" onclick="switchAdminTab('devices')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="20" x="5" y="2" rx="2"/><line x1="12" x2="12.01" y1="18" y2="18"/></svg>
        Devices &amp; SMS
      </button>
    </aside>
    <main class="app-main">
      <div id="adm-tab-merchants">
        <div class="page-head">
          <div>
            <h2>Merchants</h2>
            <p>3 active brands on this platform deployment</p>
          </div>
          <button class="btn btn--accent" onclick="triggerAddMerchant()">＋ Provision merchant</button>
        </div>
        <div style="display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; align-items: start;">
          <div class="card">
            <table class="dtable">
              <thead><tr><th>Brand</th><th>Gateways</th><th>Domain</th><th>Status</th></tr></thead>
              <tbody>
                <tr class="selectable is-selected" onclick="selectMerchant(1)">
                  <td style="font-weight: 600;">Amber Bites</td>
                  <td>bKash Personal, Nagad</td>
                  <td><span class="badge badge--teal">verified</span></td>
                  <td><span class="badge badge--teal">active</span></td>
                </tr>
                <tr class="selectable" onclick="selectMerchant(2)">
                  <td style="font-weight: 600;">Dhaka Threads</td>
                  <td>bKash Personal</td>
                  <td><span class="badge badge--marigold">pending</span></td>
                  <td><span class="badge badge--teal">active</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="card card-pad" id="merchant-detail-panel">
            <div style="font-weight: 700; font-size: 16px; margin-bottom: 2px;">Amber Bites</div>
            <div style="font-size: 12px; color: var(--muted); margin-bottom: 18px;" class="epx-mono">pay.amberbites.com</div>
            <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Payment gateways</div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line-light);">
              <span style="font-size: 13px;">bKash Personal</span>
              <button class="btn btn--ghost" style="padding: 4px 10px; font-size: 12px;">Reset</button>
            </div>
            <div style="font-size: 13px; font-weight: 600; margin: 18px 0 8px;">Mobile pairing</div>
            <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--teal-text); font-weight: 500;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--teal-text);"></span>
              Shop counter Pixel 7 reporting (30s ago)
            </div>
            <div style="font-size: 13px; font-weight: 600; margin: 18px 0 8px;">Custom domain DNS</div>
            <div class="field"><input value="pay.amberbites.com" readonly style="font-family: var(--font-mono); font-size: 12.5px;"></div>
            <button class="btn btn--ghost" style="margin-top: 10px;" onclick="alert('DNS verified')">Re-verify DNS TXT</button>
          </div>
        </div>
      </div>
      <div id="adm-tab-analytics" style="display: none;">
        <div class="page-head"><div><h2>Analytics</h2><p>Cross-tenant telemetry</p></div></div>
        <div class="stat-row" style="grid-template-columns: repeat(4, 1fr);">
          <div class="stat-card"><div class="stat-card__label">Revenue (7d)</div><div class="stat-card__value epx-mono">৳3,65,600</div></div>
          <div class="stat-card"><div class="stat-card__label">Transactions today</div><div class="stat-card__value epx-mono">128</div></div>
          <div class="stat-card"><div class="stat-card__label">Success rate</div><div class="stat-card__value epx-mono">94.2%</div></div>
          <div class="stat-card"><div class="stat-card__label">Active merchants</div><div class="stat-card__value epx-mono">3</div></div>
        </div>
      </div>
      <div id="adm-tab-devices" style="display: none;">
        <div class="page-head"><div><h2>Devices &amp; SMS</h2><p>Forwarding phones and queue</p></div></div>
        <div class="card card-pad">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 12px;">Paired devices</div>
          <table class="dtable">
            <thead><tr><th>Merchant</th><th>Device</th><th>Last check-in</th><th>Status</th></tr></thead>
            <tbody><tr><td>Amber Bites</td><td>Shop counter Pixel 7</td><td>30s ago</td><td><span class="badge badge--teal">active</span></td></tr></tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
  <script>
    function switchAdminTab(tab) {
      document.querySelectorAll('.app-sidebar .nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('adm-nav-' + tab).classList.add('active');
      document.getElementById('adm-tab-merchants').style.display = tab === 'merchants' ? 'block' : 'none';
      document.getElementById('adm-tab-analytics').style.display = tab === 'analytics' ? 'block' : 'none';
      document.getElementById('adm-tab-devices').style.display = tab === 'devices' ? 'block' : 'none';
    }
    function triggerAddMerchant() {
      const name = prompt('Merchant name:');
      if (name) alert('Provision merchant initiated. AES-256-GCM claim token: EPK-CLAIM-8942A9KF3');
    }
  </script>
</body>
</html>`;

write('frontend/apps/admin/public/index.html', adminHtml);
write('public/assets/admin/index.html', adminHtml);

console.log('🎉 All 8 assets successfully written and synchronized!');
