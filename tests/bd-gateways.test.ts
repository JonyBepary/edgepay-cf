/**
 * BD hand-port behavior tests — mocked-fetch end-to-end flows for the
 * reference adapters (Rocket: form+MD5, SSLCommerz: REST form + validator,
 * Aamarpay: REST JSON + trxcheck, ShurjoPay: token + verify list,
 * PortWallet: bearer + IPN).
 *
 * These pin the flows the user's market actually runs: the signature
 * recipes, the server-side verification calls, and the fail-closed
 * behaviour on bad input.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { RocketGateway } from '../src/gateways/rocket/rocket.gateway';
import { SslCommerzGateway } from '../src/gateways/sslcommerz/sslcommerz.gateway';
import { AamarpayGateway } from '../src/gateways/aamarpay/aamarpay.gateway';
import { ShurjopayGateway } from '../src/gateways/shurjopay/shurjopay.gateway';
import { PortWalletGateway } from '../src/gateways/portwallet/portwallet.gateway';
import { md5Hex } from '../src/lib/hash';

const PARAMS = {
  amount: '150.50',
  currency: 'BDT',
  trx_id: 'TRX-123',
  redirect_url: 'https://pay.example.com/checkout/tok/callback',
  cancel_url: 'https://pay.example.com/checkout/tok/cancel',
} as const;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RocketGateway (auto-submit form + MD5 concat signature)', () => {
  it('builds the form with the provider-mandated md5(merchant+trx+amount+secret) hash', async () => {
    const gw = new RocketGateway();
    const result = await gw.initiate(PARAMS, { merchant_id: 'MID001', secret_key: 'sekret', mode: 'sandbox' });
    expect(result.form_html).toBeDefined();
    expect(result.form_html).toContain('action="https://sandbox.dutchbanglabank.com/rocket/checkout/process"');
    const expectedHash = await md5Hex(`MID001${PARAMS.trx_id}150.50sekret`);
    expect(result.form_html).toContain(`value="${expectedHash}"`);
    expect(result.session_id).toBe('TRX-123');
  });

  it('accepts a correctly-signed success callback', async () => {
    const gw = new RocketGateway();
    const amount = '150.50';
    const status = 'success';
    const hash = await md5Hex(`MID001ORDER-9${amount}${status}sekret`);
    const result = await gw.verify(
      { order_id: 'ORDER-9', status, amount, hash, transaction_id: 'TXN-77' },
      { merchant_id: 'MID001', secret_key: 'sekret', mode: 'sandbox' },
    );
    expect(result.success).toBe(true);
    expect(result.gateway_trx_id).toBe('TXN-77');
    expect(result.amount).toBe('150.50');
  });

  it('rejects a tampered hash (fail closed)', async () => {
    const gw = new RocketGateway();
    const result = await gw.verify(
      { order_id: 'ORDER-9', status: 'success', amount: '150.50', hash: 'deadbeef' },
      { merchant_id: 'MID001', secret_key: 'sekret', mode: 'sandbox' },
    );
    expect(result.success).toBe(false);
  });

  it('webhooks fail closed (upstream stub was accept-all)', async () => {
    const gw = new RocketGateway();
    expect(await gw.verifyWebhook({ rawBody: '{}', headers: {}, credentials: {} })).toBe(false);
  });
});

describe('SslCommerzGateway (hosted checkout + server-side validator)', () => {
  it('posts the session request with store credentials and redirects to GatewayPageURL', async () => {
    const spy = mockFetch((url, init) => {
      expect(url).toBe('https://sandbox.sslcommerz.com/gwprocess/v4/api.php');
      expect(String(init?.body)).toContain('store_id=STORE1');
      expect(String(init?.body)).toContain('tran_id=TRX-123');
      return { status: 200, body: { status: 'SUCCESS', GatewayPageURL: 'https://sandbox.sslcommerz.com/gw/abc' } };
    });
    const gw = new SslCommerzGateway();
    const result = await gw.initiate(PARAMS, { store_id: 'STORE1', store_passwd: 'pw', mode: 'sandbox' });
    expect(result.redirect_url).toBe('https://sandbox.sslcommerz.com/gw/abc');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('throws on a failed session (failedreason surfaced)', async () => {
    mockFetch(() => ({ status: 200, body: { status: 'FAILED', failedreason: 'Store not found' } }));
    const gw = new SslCommerzGateway();
    await expect(gw.initiate(PARAMS, { store_id: 'X', store_passwd: 'Y', mode: 'sandbox' }))
      .rejects.toThrow('Store not found');
  });

  it('completes only on VALID/VALIDATED from the validator API (never the callback payload)', async () => {
    mockFetch((url) => {
      expect(url).toContain('validator/api/validationserverAPI.php');
      expect(url).toContain('val_id=V88');
      return { status: 200, body: { status: 'VALID', bank_tran_id: 'BANK-1', amount: '150.50', tran_id: 'TRX-123' } };
    });
    const gw = new SslCommerzGateway();
    const result = await gw.verify(
      { val_id: 'V88', status: 'INVALID_AMOUNT_FROM_CALLBACK' },
      { store_id: 'STORE1', store_passwd: 'pw', mode: 'sandbox' },
    );
    expect(result.success).toBe(true);
    expect(result.gateway_trx_id).toBe('BANK-1');
  });

  it('fails closed when the validator rejects', async () => {
    mockFetch(() => ({ status: 200, body: { status: 'INVALID' } }));
    const gw = new SslCommerzGateway();
    const result = await gw.verify({ val_id: 'V99' }, { store_id: 'S', store_passwd: 'p', mode: 'sandbox' });
    expect(result.success).toBe(false);
  });
});

describe('AamarpayGateway (JSON post + trxcheck)', () => {
  it('posts the JSON session and returns payment_url', async () => {
    const spy = mockFetch((url, init) => {
      expect(url).toBe('https://sandbox.aamarpay.com/jsonpost.php');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.store_id).toBe('A1');
      expect(body.amount).toBe('150.50');
      expect(String(body.success_url)).toContain('session=TRX-123');
      return { status: 200, body: { payment_url: 'https://sandbox.aamarpay.com/pay/xyz' } };
    });
    const gw = new AamarpayGateway();
    const result = await gw.initiate(PARAMS, { store_id: 'A1', signature_key: 'sig', mode: 'sandbox' });
    expect(result.redirect_url).toBe('https://sandbox.aamarpay.com/pay/xyz');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('completes only when pay_status=Successful AND status_code=2 (both conditions)', async () => {
    mockFetch(() => ({ status: 200, body: { pay_status: 'Successful', status_code: '2', bank_trxid: 'BTX1', amount: '150.50' } }));
    const gw = new AamarpayGateway();
    const ok = await gw.verify({ session: 'TRX-123' }, { store_id: 'A1', signature_key: 'sig', mode: 'sandbox' });
    expect(ok.success).toBe(true);
  });

  it('rejects when status_code is not 2 even if pay_status says Successful', async () => {
    mockFetch(() => ({ status: 200, body: { pay_status: 'Successful', status_code: '5' } }));
    const gw = new AamarpayGateway();
    const result = await gw.verify({ session: 'TRX-123' }, { store_id: 'A1', signature_key: 'sig', mode: 'sandbox' });
    expect(result.success).toBe(false);
  });
});

describe('ShurjopayGateway (token grant + secret-pay + verification list)', () => {
  const creds = { username: 'u', password: 'p', prefix: 'EDP', store_mode: 'sandbox' };

  it('grants a token, posts secret-pay and returns checkout_url', async () => {
    const spy = mockFetch((url) => {
      if (url.endsWith('/api/get_token')) {
        return { status: 200, body: { token: 'tok_abc', store_id: 'SH001' } };
      }
      expect(url).toBe('https://sandbox.shurjopayment.com/api/secret-pay');
      return { status: 200, body: { checkout_url: 'https://sandbox.shurjopayment.com/pay/zzz' } };
    });
    const gw = new ShurjopayGateway();
    const result = await gw.initiate(PARAMS, creds);
    expect(result.redirect_url).toBe('https://sandbox.shurjopayment.com/pay/zzz');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('extracts order_id from the combined status?order_id= callback form', async () => {
    mockFetch((url, init) => {
      expect(url).toContain('/api/verification');
      expect(String(init?.body)).toContain('"order_id":"ORDER-42"');
      return { status: 200, body: [{ bank_status: 'Success', bank_trx_id: 'B77', amount: '150.50' }] };
    });
    const gw = new ShurjopayGateway();
    const result = await gw.verify(
      { status: 'success?order_id=ORDER-42' },
      creds,
    );
    expect(result.success).toBe(true);
    expect(result.gateway_trx_id).toBe('B77');
  });

  it('fails when callback status is not success (before any network call)', async () => {
    const spy = mockFetch(() => ({ status: 200, body: {} }));
    const gw = new ShurjopayGateway();
    const result = await gw.verify({ order_id: 'O1', status: 'cancel' }, creds);
    expect(result.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('PortWalletGateway (bearer invoice + IPN)', () => {
  it('rejects missing credentials before any network call', async () => {
    const spy = mockFetch(() => ({ status: 200, body: {} }));
    const gw = new PortWalletGateway();
    await expect(gw.initiate(PARAMS, { mode: 'sandbox' })).rejects.toThrow('missing App Key');
    expect(spy).not.toHaveBeenCalled();
  });

  it('verifies via the IPN endpoint and completes on APPROVED', async () => {
    const spy = mockFetch((url) => {
      expect(url).toContain('/payment/v2/invoice/ipn/INV-9/150.50');
      return { status: 200, body: { data: { status: 'APPROVED' } } };
    });
    const gw = new PortWalletGateway();
    const result = await gw.verify(
      { invoice_id: 'INV-9', amount: '150.50' },
      { app_key: 'ak', secret_key: 'sk', mode: 'sandbox' },
    );
    expect(result.success).toBe(true);
    expect(result.gateway_trx_id).toBe('INV-9');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('rejects upstream SIM_ simulator IDs (fake money never enters the ledger)', async () => {
    const spy = mockFetch(() => ({ status: 200, body: {} }));
    const gw = new PortWalletGateway();
    const result = await gw.verify(
      { invoice_id: 'SIM_ABC', amount: '150.50' },
      { app_key: 'ak', secret_key: 'sk', mode: 'sandbox' },
    );
    expect(result.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
