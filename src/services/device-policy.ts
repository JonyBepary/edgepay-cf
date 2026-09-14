/**
 * Merchant Device Trust Policy & Tier Resolution Service.
 *
 * Implements tiered device security:
 *   - keyless: No hardware key on file (legacy devices, rejected under SIGNATURE_REQUIRED)
 *   - basic: Hardware P-256 key + signature verification (no attestation or attestation stale/unverified)
 *   - attested: Hardware TEE key attestation + verified boot
 *   - strongbox: Dedicated HSM / StrongBox hardware backing + patch level floor
 *
 * Principle:
 *   - Attestation is a fact (stored in op_paired_devices).
 *   - Tier is a computation (derived dynamically per request).
 *   - Policy is a preference (configured per merchant in op_merchant_device_policies).
 */

import type { Env, D1Database } from '../types/env';

export const TIER_RANK = {
  keyless: 0,
  basic: 1,
  attested: 2,
  strongbox: 3,
} as const;

export type DeviceTier = keyof typeof TIER_RANK;

export interface EffectivePolicy {
  min_tier: DeviceTier;
  min_patch_level: string | null;
  strict_pairing: boolean;
}

export interface DeviceFacts {
  public_key: string | null;
  attestation_verified_at: string | null;
  attestation_strong: number;
  attestation_verified_boot: number;
  device_patch_level: string | null;
}

export interface TierComputationOptions {
  maxAttestationAgeMs: number;
  allowUnverifiedBoot?: boolean;
}

export interface TierResult {
  tier: DeviceTier;
  reason?: string;
}

/**
 * Resolves effective policy from platform environment variables and merchant-specific policy row.
 * Precedence rule: Strictest of platform default and merchant policy wins.
 */
export function resolvePolicy(
  env: Env,
  merchantRow: {
    min_tier?: string | null;
    min_patch_level?: string | null;
    strict_pairing?: number | boolean | null;
  } | null,
): EffectivePolicy {
  const platformTier: DeviceTier =
    env.STRONGBOX_REQUIRED === 'true'
      ? 'strongbox'
      : env.ATTESTATION_REQUIRED === 'true'
        ? 'attested'
        : 'basic';

  const merchantTier = (merchantRow?.min_tier ?? 'basic') as DeviceTier;
  const min_tier =
    TIER_RANK[merchantTier] !== undefined && TIER_RANK[merchantTier] > TIER_RANK[platformTier]
      ? merchantTier
      : platformTier;

  return {
    min_tier,
    min_patch_level: merchantRow?.min_patch_level ?? null,
    strict_pairing: merchantRow?.strict_pairing === 1 || merchantRow?.strict_pairing === true,
  };
}

/**
 * Computes device security tier dynamically from stored facts against current policy and options.
 */
export function computeDeviceTier(
  device: DeviceFacts,
  policy: EffectivePolicy,
  opts: TierComputationOptions,
): TierResult {
  if (!device.public_key) {
    return { tier: 'keyless' };
  }

  if (!device.attestation_verified_at) {
    return { tier: 'basic', reason: 'NO_ATTESTATION' };
  }

  const verifiedAt = Date.parse(device.attestation_verified_at);
  if (isNaN(verifiedAt)) {
    return { tier: 'basic', reason: 'NO_ATTESTATION' };
  }

  const age = Date.now() - verifiedAt;
  if (age > opts.maxAttestationAgeMs) {
    return { tier: 'basic', reason: 'ATTESTATION_STALE' };
  }

  if (!opts.allowUnverifiedBoot && device.attestation_verified_boot !== 1) {
    return { tier: 'basic', reason: 'VERIFIED_BOOT_REQUIRED' };
  }

  if (policy.min_patch_level) {
    if (!device.device_patch_level || device.device_patch_level < policy.min_patch_level) {
      return { tier: 'attested', reason: 'PATCH_LEVEL_BELOW_MIN' };
    }
  }

  if (device.attestation_strong === 1) {
    return { tier: 'strongbox' };
  }

  return { tier: 'attested' };
}

/** Enforcement mode as resolved from global override + per-merchant value. */
export type EnforcementMode = 'off' | 'audit' | 'enforce';

/**
 * Resolve the effective enforcement mode.
 * Precedence: global override caps the per-merchant value.
 *   - Global 'off'   → always 'off'
 *   - Global 'audit' → min(merchant, 'audit') — nobody can go higher
 *   - Global 'enforce' → merchant value unchanged
 *   - Global unset   → merchant value
 */
export function resolveEnforcementMode(
  env: { DEVICE_POLICY_GLOBAL_MODE?: string },
  merchantMode: EnforcementMode,
): EnforcementMode {
  const g = env.DEVICE_POLICY_GLOBAL_MODE;
  if (g === 'off') return 'off';
  if (g === 'audit' && merchantMode === 'enforce') return 'audit';
  if (g === 'enforce' || g === undefined) return merchantMode;
  // Unknown global value → fail safe to audit
  return 'audit';
}

export interface PolicyEvaluationResult {
  requiredTier: string;
  achievedTier: string;
  compliant: boolean;
  failureReason?: string;
}

/**
 * Pure decision function. Given an evaluation result and a mode,
 * returns whether the request should be blocked.
 */
export function shouldBlock(
  mode: EnforcementMode,
  result: PolicyEvaluationResult,
): boolean {
  if (mode === 'off' || mode === 'audit') return false;
  return !result.compliant;
}

export interface ActiveOverride {
  id: number;
  expires_at: string;
}

/**
 * Look up an active override for a device.
 * Returns null if none exists, or if it has expired or been revoked.
 * This function never throws — it returns null on any failure.
 */
export async function lookupActiveOverride(
  db: D1Database,
  merchantId: number,
  deviceId: number,
): Promise<ActiveOverride | null> {
  try {
    const row = await db.prepare(
      `SELECT id, expires_at FROM op_device_policy_overrides
       WHERE merchant_id = ? AND device_id = ?
         AND revoked_at IS NULL
         AND expires_at > datetime('now')
       ORDER BY expires_at DESC
       LIMIT 1`
    ).bind(merchantId, deviceId).first<{ id: number; expires_at: string }>();
    return row ?? null;
  } catch {
    return null;
  }
}

export interface DeviceOverrideRow {
  id: number;
  merchant_id: number;
  device_id: number;
  authorized_by: number;
  authorized_at: string;
  reason: string;
  acknowledged_tier: string;
  required_tier: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: number | null;
  revocation_reason: string | null;
}

export interface ServiceResult<T> {
  success: boolean;
  status: number;
  data?: T;
  error?: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

export async function getDeviceOverrideRow(
  db: D1Database,
  merchantId: number,
  deviceId: number,
): Promise<DeviceOverrideRow | null> {
  const row = await db.prepare(
    `SELECT id, merchant_id, device_id, authorized_by, authorized_at, reason, acknowledged_tier,
            required_tier, expires_at, revoked_at, revoked_by, revocation_reason
     FROM op_device_policy_overrides
     WHERE merchant_id = ? AND device_id = ?
     ORDER BY id DESC
     LIMIT 1`
  ).bind(merchantId, deviceId).first<DeviceOverrideRow>();
  return row ?? null;
}

export async function grantDeviceOverride(
  db: D1Database,
  env: Env,
  params: {
    merchantId: number;
    deviceId: number;
    authorizedBy: number;
    actorType: 'admin' | 'api_key';
    reason: unknown;
    expiresInDays: unknown;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<ServiceResult<DeviceOverrideRow>> {
  const { merchantId, deviceId, authorizedBy, actorType, reason, expiresInDays, ipAddress, userAgent } = params;

  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return {
      success: false,
      status: 400,
      error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' },
    };
  }

  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 500) {
    return {
      success: false,
      status: 400,
      error: { code: 'REASON_REQUIRED', message: 'Reason must be between 10 and 500 characters' },
    };
  }

  if (expiresInDays !== 30 && expiresInDays !== 60 && expiresInDays !== 90) {
    return {
      success: false,
      status: 400,
      error: { code: 'INVALID_EXPIRY', message: 'expires_in_days must be 30, 60, or 90' },
    };
  }

  const device = await db.prepare(
    `SELECT id, status, public_key, attestation_verified_at, attestation_strong,
            attestation_verified_boot, device_patch_level
     FROM op_paired_devices
     WHERE id = ? AND merchant_id = ?
     LIMIT 1`
  ).bind(deviceId, merchantId).first<{
    id: number;
    status: string;
    public_key: string | null;
    attestation_verified_at: string | null;
    attestation_strong: number;
    attestation_verified_boot: number;
    device_patch_level: string | null;
  }>();

  if (!device || device.status !== 'active') {
    return {
      success: false,
      status: 404,
      error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found or not active' },
    };
  }

  const existingActive = await db.prepare(
    `SELECT id FROM op_device_policy_overrides
     WHERE merchant_id = ? AND device_id = ?
       AND revoked_at IS NULL
       AND expires_at > datetime('now')
     ORDER BY id DESC
     LIMIT 1`
  ).bind(merchantId, deviceId).first<{ id: number }>();

  if (existingActive) {
    return {
      success: false,
      status: 409,
      error: {
        code: 'OVERRIDE_ALREADY_ACTIVE',
        message: 'An active override already exists for this device',
        override_id: existingActive.id,
        existing_id: existingActive.id,
        id: existingActive.id,
      },
    };
  }

  const activeCount = await db.prepare(
    `SELECT COUNT(*) AS count FROM op_device_policy_overrides
     WHERE merchant_id = ?
       AND revoked_at IS NULL
       AND expires_at > datetime('now')`
  ).bind(merchantId).first<{ count: number }>();

  if ((activeCount?.count ?? 0) >= 20) {
    return {
      success: false,
      status: 429,
      error: {
        code: 'OVERRIDE_QUOTA_EXCEEDED',
        message: 'Active override quota (20) exceeded for merchant. Contact support.',
      },
    };
  }

  const merchantPolicyRow = await db.prepare(
    `SELECT min_tier, min_patch_level, strict_pairing FROM op_merchant_device_policies WHERE merchant_id = ? LIMIT 1`
  ).bind(merchantId).first<{ min_tier?: string | null; min_patch_level?: string | null; strict_pairing?: number | boolean | null }>();

  const effectivePolicy = resolvePolicy(env, merchantPolicyRow);
  const maxAttestationAgeMs = parseInt(env.ATTESTATION_MAX_AGE_DAYS || '30', 10) * 86400000;
  const allowUnverifiedBoot = env.ATTESTATION_ALLOW_UNVERIFIED_BOOT === 'true';

  const tierResult = computeDeviceTier({
    public_key: device.public_key,
    attestation_verified_at: device.attestation_verified_at,
    attestation_strong: device.attestation_strong ?? 0,
    attestation_verified_boot: device.attestation_verified_boot ?? 0,
    device_patch_level: device.device_patch_level,
  }, effectivePolicy, { maxAttestationAgeMs, allowUnverifiedBoot });

  const acknowledgedTier = tierResult.tier;
  const requiredTier = effectivePolicy.min_tier;

  const nowObj = new Date();
  const authorizedAt = nowObj.toISOString();
  const expiresObj = new Date(nowObj.getTime() + expiresInDays * 86400000);
  const expiresAt = expiresObj.toISOString();

  let resolvedAuthorizedBy = authorizedBy;
  if (resolvedAuthorizedBy > 0) {
    const keyUser = await db.prepare(
      `SELECT created_by FROM op_api_keys WHERE id = ? LIMIT 1`
    ).bind(resolvedAuthorizedBy).first<{ created_by: number | null }>();
    if (keyUser?.created_by && keyUser.created_by > 0) {
      resolvedAuthorizedBy = keyUser.created_by;
    }
  }

  const userRow = resolvedAuthorizedBy > 0 ? await db.prepare(
    `SELECT id FROM op_merchant_users WHERE id = ? LIMIT 1`
  ).bind(resolvedAuthorizedBy).first<{ id: number }>() : null;

  if (!userRow) {
    return {
      success: false,
      status: 400,
      error: { code: 'NO_ACTOR_RESOLVED', message: 'Cannot attribute this action to a user' },
    };
  }

  const insertResult = await db.prepare(
    `INSERT INTO op_device_policy_overrides
       (merchant_id, device_id, authorized_by, authorized_at, reason,
        acknowledged_tier, required_tier, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    merchantId,
    deviceId,
    resolvedAuthorizedBy,
    authorizedAt,
    reason.trim(),
    acknowledgedTier,
    requiredTier,
    expiresAt,
  ).run();

  const newId = insertResult.meta?.last_row_id;
  const createdRow = await db.prepare(
    `SELECT id, merchant_id, device_id, authorized_by, authorized_at, reason,
            acknowledged_tier, required_tier, expires_at, revoked_at, revoked_by, revocation_reason
     FROM op_device_policy_overrides
     WHERE id = ? LIMIT 1`
  ).bind(newId).first<DeviceOverrideRow>();

  if (!createdRow) {
    return {
      success: false,
      status: 500,
      error: { code: 'INSERT_FAILED', message: 'Failed to create override' },
    };
  }

  const { metric } = await import('../lib/observability');
  metric(env, 'device_policy_override_granted', {
    merchant_id: merchantId,
    device_id: deviceId,
    value: 1,
  });

  const todayGrants = await db.prepare(
    `SELECT COUNT(*) AS count FROM op_device_policy_overrides
     WHERE merchant_id = ? AND date(authorized_at) = date('now')`
  ).bind(merchantId).first<{ count: number }>();

  if ((todayGrants?.count ?? 0) > 5) {
    metric(env, 'device_policy_override_spike', {
      merchant_id: merchantId,
      value: 1,
    });
  }

  await db.prepare(
    `INSERT INTO op_audit_logs
       (merchant_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, signature, created_at)
     VALUES (?, ?, ?, 'device_policy_override.granted', 'device_policy_override', ?, NULL, ?, ?, ?, 'system', ?)`
  ).bind(
    merchantId,
    resolvedAuthorizedBy || null,
    actorType,
    String(createdRow.id),
    JSON.stringify(createdRow),
    ipAddress ?? null,
    userAgent ?? null,
    authorizedAt,
  ).run();

  return {
    success: true,
    status: 201,
    data: createdRow,
  };
}

export async function revokeDeviceOverride(
  db: D1Database,
  env: Env,
  params: {
    merchantId: number;
    deviceId: number;
    revokedBy: number;
    actorType: 'admin' | 'api_key';
    reason: unknown;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<ServiceResult<DeviceOverrideRow>> {
  const { merchantId, deviceId, revokedBy, actorType, reason, ipAddress, userAgent } = params;

  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return {
      success: false,
      status: 400,
      error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' },
    };
  }

  const activeOverride = await db.prepare(
    `SELECT id, merchant_id, device_id, authorized_by, authorized_at, reason,
            acknowledged_tier, required_tier, expires_at, revoked_at, revoked_by, revocation_reason
     FROM op_device_policy_overrides
     WHERE merchant_id = ? AND device_id = ?
       AND revoked_at IS NULL
       AND expires_at > datetime('now')
     ORDER BY id DESC
     LIMIT 1`
  ).bind(merchantId, deviceId).first<DeviceOverrideRow>();

  if (!activeOverride) {
    return {
      success: false,
      status: 404,
      error: { code: 'OVERRIDE_NOT_FOUND', message: 'No active override found for this device' },
    };
  }

  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500) {
    return {
      success: false,
      status: 400,
      error: { code: 'REASON_REQUIRED', message: 'Reason must be between 5 and 500 characters' },
    };
  }

  let resolvedRevokedBy = revokedBy;
  if (resolvedRevokedBy > 0) {
    const keyUser = await db.prepare(
      `SELECT created_by FROM op_api_keys WHERE id = ? LIMIT 1`
    ).bind(resolvedRevokedBy).first<{ created_by: number | null }>();
    if (keyUser?.created_by && keyUser.created_by > 0) {
      resolvedRevokedBy = keyUser.created_by;
    }
  }

  const userRow = resolvedRevokedBy > 0 ? await db.prepare(
    `SELECT id FROM op_merchant_users WHERE id = ? LIMIT 1`
  ).bind(resolvedRevokedBy).first<{ id: number }>() : null;

  if (!userRow) {
    return {
      success: false,
      status: 400,
      error: { code: 'NO_ACTOR_RESOLVED', message: 'Cannot attribute this action to a user' },
    };
  }

  await db.prepare(
    `UPDATE op_device_policy_overrides
        SET revoked_at = datetime('now'), revoked_by = ?, revocation_reason = ?
      WHERE id = ? AND merchant_id = ?`
  ).bind(resolvedRevokedBy, reason.trim(), activeOverride.id, merchantId).run();

  const updatedRow = await db.prepare(
    `SELECT id, merchant_id, device_id, authorized_by, authorized_at, reason,
            acknowledged_tier, required_tier, expires_at, revoked_at, revoked_by, revocation_reason
     FROM op_device_policy_overrides
     WHERE id = ? LIMIT 1`
  ).bind(activeOverride.id).first<DeviceOverrideRow>();

  if (!updatedRow) {
    return {
      success: false,
      status: 500,
      error: { code: 'UPDATE_FAILED', message: 'Failed to retrieve updated override' },
    };
  }

  const { metric } = await import('../lib/observability');
  metric(env, 'device_policy_override_revoked', {
    merchant_id: merchantId,
    device_id: deviceId,
    value: 1,
  });

  await db.prepare(
    `INSERT INTO op_audit_logs
       (merchant_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, signature, created_at)
     VALUES (?, ?, ?, 'device_policy_override.revoked', 'device_policy_override', ?, ?, ?, ?, ?, 'system', datetime('now'))`
  ).bind(
    merchantId,
    resolvedRevokedBy || null,
    actorType,
    String(updatedRow.id),
    JSON.stringify(activeOverride),
    JSON.stringify(updatedRow),
    ipAddress ?? null,
    userAgent ?? null,
  ).run();

  return {
    success: true,
    status: 200,
    data: updatedRow,
  };
}

