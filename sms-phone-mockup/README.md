# 📱 Android SMS Phone Mockup & Relay Test Server

An interactive, standalone **Android Smartphone SMS Simulator and Mock Relay Server** for testing Mobile Financial Services (MFS) payment gateways, SMS webhook consumers, and Cloudflare Worker endpoints (such as EdgePay's `/api/mobile/v1/sms`).

---

## 🚀 Quick Start (Run in a Separate Terminal)

No external dependencies required! Runs with pure standard Node.js (v18+).

```bash
# 1. Navigate to the simulator directory
cd sms-phone-mockup

# 2. Start the mockup server
node server.js
# or: npm start
```

Then open your browser or webview window at:
👉 **[http://localhost:3300](http://localhost:3300)**

---

## 🌟 Key Features

- 📱 **Hyper-Realistic Android Smartphone Frame**:
  - Realistic bezel, punch-hole front camera, speaker slit.
  - Live Android status bar (5G, Wi-Fi, battery percentage, real-time clock).
  - Google Messages / Android SMS chat view with brand avatar, verified sender badge, and timestamped message bubbles.
  - Web Audio API synthesizer for realistic Android incoming/outgoing SMS chimes.
- ⚡ **Pre-configured MFS & Banking Presets**:
  - 🌸 **bKash** (Received Money, Merchant Payment, Cash In)
  - 🟠 **Nagad** (Received Money, Cash In, Merchant Payment)
  - 🟣 **Rocket** (Received Money, Cash In)
  - 🟡 **Upay** (Received Money, Cash In)
  - 🟢 **M-Pesa** (Lipa Na M-Pesa, Received)
  - 🏦 **Bank Alert / Custom** (Credit Alert, Custom Provider)
- 🎲 **Smart Randomizers & Variable Builders**:
  - Generates realistic TrxIDs tailored per provider (e.g. `9X7Y2Z1A3B` for bKash, `71NB892X` for Nagad, `8829103823` for Rocket).
  - Randomizes customer phone numbers (`017...`, `018...`, `019...`, etc.).
  - Quick amount presets (`100`, `500`, `1000`, `1500`, `2500`, `5000` BDT) + fee and balance calculators.
- 🔄 **Multi-Format Payload Transmitters**:
  1. **EdgePay Mobile Companion Format**:
     ```json
     {
       "sender": "bKash",
       "body": "You have received Tk 1,500.00 from 01712345678. Ref order#101. Fee Tk 0.00. Balance Tk 5,420.50. TrxID 9X7Y2Z1A3B at 31/08/2026 22:45",
       "received_at": "2026-08-31T22:45:00.000Z"
     }
     ```
  2. **Structured JSON Format**:
     ```json
     {
       "trx_id": "9X7Y2Z1A3B",
       "sender_number": "01712345678",
       "amount": "1500.00",
       "currency": "BDT",
       "sender": "bKash",
       "gateway": "bkash",
       "fee": "0.00",
       "balance": "5420.50",
       "raw_sms": "...",
       "timestamp": "2026-08-31T22:45:00.000Z"
     }
     ```
  3. **Combined / Raw Text**: Full freedom to send custom schemas or raw SMS strings.
- 🎯 **Target & Auth Flexibility**:
  - **Relay Proxy (`/api/forward`)**: Sends requests from the Node backend to any local or remote URL without browser CORS errors.
  - **Auth Headers**: Bearer JWT tokens, `X-API-Key`, or custom headers.
- 📥 **Built-in Mock Server & Live SSE Feed**:
  - Acts as a local mock receiver on `http://localhost:3300/api/mobile/v1/sms` and `http://localhost:3300/mock-webhook`.
  - Real-time Server-Sent Events (SSE) stream shows incoming packets instantly in the webview.
- ⚡ **Automated Batch Load Testing**:
  - Send $N$ messages sequentially with configurable interval (ms) and random provider mix for stress-testing queue consumers and AI parsers.
- 📊 **Live Telemetry & Response Inspector**:
  - View HTTP status codes, latency in milliseconds, response headers, and formatted JSON output.

---

## 🛠️ Testing with EdgePay Cloudflare Worker

When running EdgePay locally with Wrangler (`npm run dev` in the main directory):

1. Start EdgePay Worker:
   ```bash
   npm run dev
   # Runs on http://localhost:8787
   ```
2. Start the SMS Mockup Server in a separate terminal:
   ```bash
   cd sms-phone-mockup
   node server.js
   # Runs on http://localhost:3300
   ```
3. In the SMS Simulator webview (`http://localhost:3300`), select **Target Endpoint**:
   `http://localhost:8787/api/mobile/v1/sms`
4. Click **"🚀 Send SMS to Server"** or **"🎲 Randomize & Send"** to trigger the SMS queue consumer and parser in EdgePay!
