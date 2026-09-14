import {
  ensureD1,
  ensureKv,
  ensureR2,
  ensureQueue,
  deleteD1,
  deleteKv,
  deleteR2,
  deleteQueue,
} from './wrangler.js';
import type { InitConfig, ProvisionedResources } from './state.js';

export interface ProvisionProgressCallback {
  (step: string, resourceName: string): void;
}

export interface DeploymentQueueNames {
  webhookOut: string;
  webhookOutDlq: string;
  emailOut: string;
  emailOutDlq: string;
  smsParse: string;
  smsParseDlq: string;
  allInProvisionOrder: string[];
  allInTeardownOrder: string[];
}

export interface GetDeploymentQueueNamesOpts {
  projectRoot?: string;
  existingWranglerContent?: string;
  forceLegacy?: boolean;
}

export function detectLegacyQueueBindings(wranglerContent: string): boolean {
  try {
    return (
      /"queue"\s*:\s*"webhook-out"/i.test(wranglerContent) &&
      !/"queue"\s*:\s*"[a-zA-Z0-9_-]+-webhook-out"/i.test(wranglerContent)
    );
  } catch {
    return false;
  }
}

export function getDeploymentQueueNames(
  deploymentName: string,
  opts: GetDeploymentQueueNamesOpts = {},
): DeploymentQueueNames {
  let isLegacy = Boolean(opts.forceLegacy);

  if (!isLegacy && opts.existingWranglerContent) {
    isLegacy = detectLegacyQueueBindings(opts.existingWranglerContent);
  }

  // Preserve unscoped names if legacy mode detected, or for default edgepay-cf
  const isDefaultUnscoped = isLegacy || deploymentName === 'edgepay-cf';
  const prefix = isDefaultUnscoped ? '' : `${deploymentName}-`;

  const webhookOut = `${prefix}webhook-out`;
  const webhookOutDlq = `${prefix}webhook-out-dlq`;
  const emailOut = `${prefix}email-out`;
  const emailOutDlq = `${prefix}email-out-dlq`;
  const smsParse = `${prefix}sms-parse`;
  const smsParseDlq = `${prefix}sms-parse-dlq`;

  return {
    webhookOut,
    webhookOutDlq,
    emailOut,
    emailOutDlq,
    smsParse,
    smsParseDlq,
    allInProvisionOrder: [
      webhookOutDlq,
      webhookOut,
      emailOutDlq,
      emailOut,
      smsParseDlq,
      smsParse,
    ],
    allInTeardownOrder: [
      webhookOut,
      emailOut,
      smsParse,
      webhookOutDlq,
      emailOutDlq,
      smsParseDlq,
    ],
  };
}

export interface ProvisionAllOpts {
  adoptExisting?: boolean;
  projectRoot?: string;
  onProgress?: ProvisionProgressCallback;
}

export async function provisionAll(
  config: InitConfig,
  existingResources?: ProvisionedResources,
  onProgressOrOpts?: ProvisionProgressCallback | ProvisionAllOpts,
): Promise<ProvisionedResources> {
  const opts: ProvisionAllOpts =
    typeof onProgressOrOpts === 'function'
      ? { onProgress: onProgressOrOpts }
      : onProgressOrOpts ?? {};

  const onProgress = opts.onProgress;
  const accountId = config.account_id;
  const adoptExisting = opts.adoptExisting;
  const resources: ProvisionedResources = {
    queues: [],
  };

  // 1. D1 Database
  onProgress?.('d1', config.d1_name);
  resources.d1_name = config.d1_name;
  resources.d1_id = await ensureD1(config.d1_name, {
    accountId,
    expectedExistingId: existingResources?.d1_id,
    adoptExisting,
  });

  // 2. KV Namespace
  onProgress?.('kv', config.kv_name);
  resources.kv_name = config.kv_name;
  resources.kv_id = await ensureKv(config.kv_name, {
    accountId,
    expectedExistingId: existingResources?.kv_id,
    adoptExisting,
  });

  // 3. R2 Bucket
  onProgress?.('r2', config.r2_name);
  resources.r2_name = await ensureR2(config.r2_name, {
    accountId,
    expectedExistingId: existingResources?.r2_name,
    adoptExisting,
  });

  // 4. Queues & DLQs: check for legacy unscoped queue bindings in existing project wrangler.jsonc
  let existingWranglerContent: string | undefined;
  if (opts.projectRoot) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      existingWranglerContent = await fs.readFile(path.join(opts.projectRoot, 'wrangler.jsonc'), 'utf-8');
    } catch {
      // no existing wrangler.jsonc
    }
  }

  const queuePlan = getDeploymentQueueNames(config.deployment_name, { existingWranglerContent });
  for (const q of queuePlan.allInProvisionOrder) {
    onProgress?.('queue', q);
    await ensureQueue(q, {
      accountId,
      expectedExistingId: existingResources?.queues?.find((x) => x === q),
      adoptExisting,
    });
    resources.queues!.push(q);
  }

  return resources;
}

export interface DestroyResult {
  deleted: string[];
  errors: Array<{ resource: string; error: string }>;
}

export async function destroyAll(
  config: InitConfig,
  resources?: ProvisionedResources,
  onProgress?: ProvisionProgressCallback,
): Promise<DestroyResult> {
  const accountId = config.account_id;
  const deleted: string[] = [];
  const errors: Array<{ resource: string; error: string }> = [];

  // 1. D1 Database
  const d1Name = resources?.d1_name ?? config.d1_name;
  if (d1Name) {
    onProgress?.('delete-d1', d1Name);
    try {
      await deleteD1(d1Name, accountId);
      deleted.push(`d1:${d1Name}`);
    } catch (err: any) {
      errors.push({ resource: `d1:${d1Name}`, error: err.message });
    }
  }

  // 2. KV Namespace
  const kvTarget = resources?.kv_id ?? config.kv_name;
  if (kvTarget) {
    onProgress?.('delete-kv', kvTarget);
    try {
      await deleteKv(kvTarget, accountId);
      deleted.push(`kv:${kvTarget}`);
    } catch (err: any) {
      errors.push({ resource: `kv:${kvTarget}`, error: err.message });
    }
  }

  // 3. R2 Bucket
  const r2Name = resources?.r2_name ?? config.r2_name;
  if (r2Name) {
    onProgress?.('delete-r2', r2Name);
    try {
      await deleteR2(r2Name, accountId);
      deleted.push(`r2:${r2Name}`);
    } catch (err: any) {
      errors.push({ resource: `r2:${r2Name}`, error: err.message });
    }
  }

  // 4. Queues: Primary queues FIRST, then dead-letter queues
  const queuePlan = getDeploymentQueueNames(config.deployment_name);
  const queuesToTeardown = resources?.queues && resources.queues.length > 0
    ? [
        ...resources.queues.filter((q) => !q.endsWith('-dlq')),
        ...resources.queues.filter((q) => q.endsWith('-dlq')),
      ]
    : queuePlan.allInTeardownOrder;

  for (const q of queuesToTeardown) {
    onProgress?.('delete-queue', q);
    try {
      await deleteQueue(q, accountId);
      deleted.push(`queue:${q}`);
    } catch (err: any) {
      errors.push({ resource: `queue:${q}`, error: err.message });
    }
  }

  return { deleted, errors };
}
