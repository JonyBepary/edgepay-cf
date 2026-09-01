import { describe, it, expect } from 'vitest';
import { isAllowedWebhookUrl } from '../src/lib/url-guard';

describe('SSRF & Webhook URL Guard Security Suite', () => {
  it('blocks private IPv4 addresses in dotted notation', () => {
    expect(isAllowedWebhookUrl('https://127.0.0.1/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://10.0.0.5/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://192.168.1.1/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://172.16.0.10/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://172.31.255.255/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedWebhookUrl('https://0.0.0.0/hook')).toBe(false);
  });

  it('blocks encoded IPv4 variations (integer, hex, octal)', () => {
    expect(isAllowedWebhookUrl('https://2130706433/hook')).toBe(false); // 127.0.0.1
    expect(isAllowedWebhookUrl('https://0x7f000001/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://0177.0.0.1/hook')).toBe(false);
  });

  it('blocks private and special IPv6 addresses', () => {
    expect(isAllowedWebhookUrl('https://[::1]/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://[fc00::1]/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://[fd12:3456:789a::1]/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://[fe80::1]/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::ffff:127.0.0.1]/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::ffff:10.0.0.1]/hook')).toBe(false);
  });

  it('blocks localhost and internal domain names', () => {
    expect(isAllowedWebhookUrl('https://localhost/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://service.internal/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://server.local/hook')).toBe(false);
    expect(isAllowedWebhookUrl('https://app.localhost/hook')).toBe(false);
  });

  it('blocks non-HTTPS protocols by default', () => {
    expect(isAllowedWebhookUrl('http://api.merchant.com/hook')).toBe(false);
    expect(isAllowedWebhookUrl('ftp://api.merchant.com/hook')).toBe(false);
    expect(isAllowedWebhookUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedWebhookUrl('javascript:alert(1)')).toBe(false);
  });

  it('permits valid public HTTPS webhook endpoints', () => {
    expect(isAllowedWebhookUrl('https://api.my-ecommerce.com/webhooks/edgepay')).toBe(true);
    expect(isAllowedWebhookUrl('https://checkout.partner-store.org/events')).toBe(true);
    expect(isAllowedWebhookUrl('https://webhook.site/12345-67890')).toBe(true);
  });
});
