import type { D1Database } from '../types/env';
import { randomUuid } from '../lib/crypto';

export interface Brand {
  id: number;
  merchant_id: number;
  uuid: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  logo_path: string | null;
  brand_color: string | null;
  support_email: string | null;
  support_phone: string | null;
  terms_url: string | null;
  privacy_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Store {
  id: number;
  brand_id: number;
  merchant_id: number;
  uuid: string;
  name: string;
  slug: string;
  timezone: string;
  default_currency: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Gate {
  id: number;
  store_id: number;
  merchant_id: number;
  gateway_id: number;
  label: string;
  mfs_number: string | null;
  currency: string;
  status: 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CheckoutGate {
  id: number;
  label: string;
  currency: string;
  gateway_id: number;
  gateway_slug: string;
  gateway_type: string;
  /** Resolved MFS destination number, or null if none can be determined. */
  destination_number: string | null;
  instructions: string | null;
}

export interface CheckoutBrand {
  id: number;
  name: string;
  logo_path: string | null;
  brand_color: string | null;
  support_email: string | null;
  support_phone: string | null;
  terms_url: string | null;
  privacy_url: string | null;
}

export class HierarchyService {
  constructor(private db: D1Database) {}

  async createBrand(input: {
    merchant_id: number;
    name: string;
    slug: string;
    brand_color?: string;
    support_email?: string;
  }): Promise<Brand> {
    const uuid = randomUuid();
    await this.db.prepare(
      `INSERT INTO op_brands
         (merchant_id, uuid, name, slug, status, brand_color, support_email)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).bind(
      input.merchant_id,
      uuid,
      input.name,
      input.slug,
      input.brand_color ?? null,
      input.support_email ?? null,
    ).run();
    const row = await this.db.prepare(
      `SELECT * FROM op_brands WHERE uuid = ? LIMIT 1`
    ).bind(uuid).first<Brand>();
    if (!row) throw new Error('Brand insert failed');
    return row;
  }

  async listBrands(merchantId: number): Promise<Brand[]> {
    const res = await this.db.prepare(
      `SELECT * FROM op_brands
       WHERE merchant_id = ? AND status = 'active'
       ORDER BY id ASC`
    ).bind(merchantId).all<Brand>();
    return res.results ?? [];
  }

  async getBrand(brandId: number, merchantId: number): Promise<Brand | null> {
    return await this.db.prepare(
      `SELECT * FROM op_brands
       WHERE id = ? AND merchant_id = ? LIMIT 1`
    ).bind(brandId, merchantId).first<Brand>();
  }

  async createStore(input: {
    merchant_id: number;
    brand_id: number;
    name: string;
    slug: string;
    default_currency: string;
    timezone?: string;
  }): Promise<Store> {
    const uuid = randomUuid();
    await this.db.prepare(
      `INSERT INTO op_stores
         (brand_id, merchant_id, uuid, name, slug, timezone, default_currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
    ).bind(
      input.brand_id,
      input.merchant_id,
      uuid,
      input.name,
      input.slug,
      input.timezone ?? 'Asia/Dhaka',
      input.default_currency,
    ).run();
    const row = await this.db.prepare(
      `SELECT * FROM op_stores WHERE uuid = ? LIMIT 1`
    ).bind(uuid).first<Store>();
    if (!row) throw new Error('Store insert failed');
    return row;
  }

  async listStores(brandId: number, merchantId: number): Promise<Store[]> {
    const res = await this.db.prepare(
      `SELECT * FROM op_stores
       WHERE brand_id = ? AND merchant_id = ? AND status = 'active'
       ORDER BY id ASC`
    ).bind(brandId, merchantId).all<Store>();
    return res.results ?? [];
  }

  async getStore(storeId: number, merchantId: number): Promise<Store | null> {
    return await this.db.prepare(
      `SELECT * FROM op_stores
       WHERE id = ? AND merchant_id = ? LIMIT 1`
    ).bind(storeId, merchantId).first<Store>();
  }

  async createGate(input: {
    store_id: number;
    merchant_id: number;
    gateway_id: number;
    label: string;
    currency: string;
    mfs_number?: string | null;
  }): Promise<Gate> {
    await this.db.prepare(
      `INSERT INTO op_gates
         (store_id, merchant_id, gateway_id, label, mfs_number, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).bind(
      input.store_id,
      input.merchant_id,
      input.gateway_id,
      input.label,
      input.mfs_number ?? null,
      input.currency,
    ).run();
    const row = await this.db.prepare(
      `SELECT * FROM op_gates
       WHERE store_id = ? AND gateway_id = ? AND label = ?
       ORDER BY id DESC LIMIT 1`
    ).bind(input.store_id, input.gateway_id, input.label).first<Gate>();
    if (!row) throw new Error('Gate insert failed');
    return row;
  }

  async listGates(storeId: number, merchantId: number): Promise<Gate[]> {
    const res = await this.db.prepare(
      `SELECT * FROM op_gates
       WHERE store_id = ? AND merchant_id = ? AND status != 'archived'
       ORDER BY id ASC`
    ).bind(storeId, merchantId).all<Gate>();
    return res.results ?? [];
  }

  async getGate(gateId: number, merchantId: number): Promise<Gate | null> {
    return await this.db.prepare(
      `SELECT * FROM op_gates
       WHERE id = ? AND merchant_id = ? LIMIT 1`
    ).bind(gateId, merchantId).first<Gate>();
  }

  async resolveDefaultGate(
    merchantId: number,
    gatewayId: number,
  ): Promise<Gate | null> {
    return await this.db.prepare(
      `SELECT pg.* FROM op_gates pg
       JOIN op_brands b ON b.merchant_id = pg.merchant_id AND b.slug = 'main'
       JOIN op_stores s ON s.brand_id = b.id AND s.slug = 'main'
       WHERE pg.merchant_id = ? AND pg.gateway_id = ? AND pg.status = 'active'
       ORDER BY pg.id ASC LIMIT 1`
    ).bind(merchantId, gatewayId).first<Gate>();
  }

  async listGatesForStore(storeId: number): Promise<Gate[]> {
    const res = await this.db.prepare(
      `SELECT * FROM op_gates
       WHERE store_id = ? AND status = 'active'
       ORDER BY id ASC`
    ).bind(storeId).all<Gate>();
    return res.results ?? [];
  }

  async listGatesForCheckout(storeId: number): Promise<CheckoutGate[]> {
    const res = await this.db.prepare(
      `SELECT
         g.id,
         g.label,
         g.currency,
         g.gateway_id,
         gw.slug     AS gateway_slug,
         gw.type     AS gateway_type,
         COALESCE(g.mfs_number, mg.account_number, mg.payment_number) AS destination_number,
         mg.instructions
       FROM op_gates g
       JOIN op_gateways gw ON gw.id = g.gateway_id
       LEFT JOIN op_manual_gateways mg ON mg.gateway_id = g.gateway_id
       WHERE g.store_id = ? AND g.status = 'active'
       ORDER BY g.id ASC`
    ).bind(storeId).all<CheckoutGate>();
    return res.results ?? [];
  }

  /**
   * Merchant-wide fallback. Used when an intent has no store_id — e.g. created
   * before Phase 6b or by a client that didn't supply a gate_id.
   */
  async listGatesForMerchantDefault(merchantId: number): Promise<CheckoutGate[]> {
    const res = await this.db.prepare(
      `SELECT
         g.id,
         g.label,
         g.currency,
         g.gateway_id,
         gw.slug     AS gateway_slug,
         gw.type     AS gateway_type,
         COALESCE(g.mfs_number, mg.account_number, mg.payment_number) AS destination_number,
         mg.instructions
       FROM op_gates g
       JOIN op_gateways gw ON gw.id = g.gateway_id
       LEFT JOIN op_manual_gateways mg ON mg.gateway_id = g.gateway_id
       JOIN op_stores s ON s.id = g.store_id
       JOIN op_brands b ON b.id = s.brand_id
       WHERE g.merchant_id = ? AND g.status = 'active'
         AND b.slug = 'main' AND s.slug = 'main'
       ORDER BY g.id ASC`
    ).bind(merchantId).all<CheckoutGate>();
    return res.results ?? [];
  }

  async getBrandForCheckout(brandId: number, merchantId: number): Promise<CheckoutBrand | null> {
    return await this.db.prepare(
      `SELECT id, name, logo_path, brand_color, support_email, support_phone, terms_url, privacy_url
       FROM op_brands
       WHERE id = ? AND merchant_id = ? LIMIT 1`
    ).bind(brandId, merchantId).first<CheckoutBrand>();
  }
}
