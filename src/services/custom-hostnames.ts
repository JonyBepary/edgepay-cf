/**
 * Custom Hostnames Service — replaces the DNS TXT verification pipeline.
 *
 * v0.1.0 implemented DNS TXT verification by:
 *   - Generating a random token
 *   - Asking the merchant to publish _edgepay-verification.{domain} TXT
 *   - Polling Cloudflare DNS-over-HTTPS API until the record appeared
 *   - Manually activating the domain in op_domains
 *
 * This was reinventing what Cloudflare for SaaS Custom Hostnames does
 * natively: API-driven hostname provisioning with automatic DV certificate
 * issuance, renewal, and DNS validation — all managed by Cloudflare.
 *
 * v0.2.0 calls the Custom Hostnames API instead. The merchant experience:
 *   1. Merchant enters their domain in the admin UI (e.g. pay.brand.com)
 *   2. EdgePay-CF calls POST /zones/{zone}/custom_hostnames
 *   3. Cloudflare returns the CNAME target the merchant must point to
 *   4. Merchant adds the CNAME; Cloudflare auto-issues SSL cert + activates
 *   5. EdgePay-CF polls the Custom Hostname status until active
 *
 * No TXT verification code. No manual DNS resolution logic. No certificate
 * management. All handled by the platform.
 */

import type { Env } from '../types/env';

export interface ProvisionHostnameInput {
  merchant_id: number;
  domain: string;        // e.g. pay.brand.com
  type: 'checkout' | 'api';
  custom_metadata?: Record<string, unknown>;
}

export interface ProvisionHostnameResult {
  hostname_id: string;
  status: 'pending' | 'active' | 'moved' | 'disowned' | 'deactivated';
  ssl_status: 'pending_validation' | 'pending_issuance' | 'pending_deployment' | 'active' | 'expired';
  cname_target: string;        // the *.cloudflareenterprise.com target
  ownership_verification?: {
    name: string;
    value: string;
  };
}

export class CustomHostnamesService {
  constructor(private readonly env: Env) {}

  /**
   * Provision a custom hostname for a merchant's brand domain.
   * Returns the CNAME target the merchant must point to.
   */
  async provision(input: ProvisionHostnameInput): Promise<ProvisionHostnameResult> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/custom_hostnames`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hostname: input.domain,
          ssl: {
            method: 'http',          // DV via HTTP validation
            type: 'dv',
            wildcard: false,
            settings: {
              min_tls_version: '1.2',
              http2: 'on',
            },
          },
          custom_metadata: {
            merchant_id: input.merchant_id,
            type: input.type,
            ...input.custom_metadata,
          },
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Custom Hostnames API failed: ${response.status} ${err}`);
    }

    const data = await response.json() as {
      result: {
        id: string;
        status: string;
        ssl: { status: string };
        ownership_verification?: { name: string; value: string };
      };
    };

    return {
      hostname_id: data.result.id,
      status: data.result.status as ProvisionHostnameResult['status'],
      ssl_status: data.result.ssl.status as ProvisionHostnameResult['ssl_status'],
      // CNAME target — merchant points their hostname here
      cname_target: `${this.env.CF_ZONE_ID}.cloudflareenterprise.com`,
      ownership_verification: data.result.ownership_verification,
    };
  }

  /**
   * Check the status of a provisioned hostname.
   * Used by the DnsVerificationJob (now: HostnameActivationJob) to poll
   * for activation. Once status === 'active' && ssl_status === 'active',
   * the domain is ready to receive traffic.
   */
  async getStatus(hostnameId: string): Promise<ProvisionHostnameResult> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/custom_hostnames/${hostnameId}`,
      {
        headers: { 'Authorization': `Bearer ${this.env.CF_API_TOKEN}` },
      },
    );

    if (!response.ok) {
      throw new Error(`Custom Hostnames API failed: ${response.status}`);
    }

    const data = await response.json() as {
      result: {
        id: string;
        status: string;
        ssl: { status: string };
        ownership_verification?: { name: string; value: string };
      };
    };

    return {
      hostname_id: data.result.id,
      status: data.result.status as ProvisionHostnameResult['status'],
      ssl_status: data.result.ssl.status as ProvisionHostnameResult['ssl_status'],
      cname_target: `${this.env.CF_ZONE_ID}.cloudflareenterprise.com`,
      ownership_verification: data.result.ownership_verification,
    };
  }

  /**
   * Delete a custom hostname (when a merchant removes a domain).
   */
  async delete(hostnameId: string): Promise<void> {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/custom_hostnames/${hostnameId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.env.CF_API_TOKEN}` },
      },
    );
  }
}

/**
 * v0.2.0 DomainMiddleware — much simpler than v0.1.0:
 *   - Look up the hostname_id + merchant_id from op_domains
 *   - If active, set c.set('merchantId', ...)
 *   - No DNS TXT verification, no KV cache invalidation, no manual SSL
 *   - The Custom Hostnames API handles all of that
 *
 * The lookup is still KV-cached (5-min TTL) to avoid D1 read per request.
 */
export async function resolveDomainContext(
  env: Env,
  hostname: string,
): Promise<{ merchant_id: number; type: 'checkout' | 'api' | 'admin'; domain_record: unknown } | null> {
  const cacheKey = `domain-v2:${hostname}`;
  const cached = await env.KV.get(cacheKey, 'json');
  if (cached) return cached as { merchant_id: number; type: 'checkout' | 'api' | 'admin'; domain_record: unknown };

  const row = await env.DB.prepare(

    `SELECT d.merchant_id, d.type, d.cf_hostname_id, d.status, d.ssl_status
     FROM op_domains d
     WHERE d.domain = ? AND d.status = 'active' AND d.ssl_status = 'active'
     LIMIT 1`
).bind(hostname).first<{ merchant_id: number; type: 'checkout' | 'api' | 'admin'; cf_hostname_id: string; status: string; ssl_status: string }>();

  if (!row) return null;

  const result = {
    merchant_id: row.merchant_id,
    type: row.type,
    domain_record: row,
  };

  // Cache for 5 minutes
  await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
  return result;
}
