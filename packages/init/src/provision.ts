import {
  ensureD1,
  ensureKv,
  ensureR2,
  ensureQueue,
  deleteD1,
  deleteKv,
  deleteR2,
  deleteQueue,
  removeQueueConsumer,
  deleteWorker,
  deleteWorkflow,
  type WranglerExecutor,
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
  existingWranglerContent?: string;
  forceLegacy?: boolean;
}

export function detectLegacyQueueBindings(
  wranglerContent: string,
  deploymentName?: string,
): boolean {
  try {
    if (deploymentName) {
      // Must verify that the config defines THIS exact deployment as its worker name
      const nameMatch = wranglerContent.match(/"name"\s*:\s*"([^"]+)"/);
      if (!nameMatch || nameMatch[1] !== deploymentName) {
        return false;
      }
    }
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
    isLegacy = detectLegacyQueueBindings(opts.existingWranglerContent, deploymentName);
  }

  // Preserve unscoped names only when explicitly confirmed as a legacy upgrade of this same deployment
  const prefix = isLegacy ? '' : `${deploymentName}-`;

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
      webhookOutDlq,
      emailOut,
      emailOutDlq,
      smsParse,
      smsParseDlq,
    ],
  };
}

export interface ProvisionAllOpts {
  adoptExisting?: boolean;
  projectRoot?: string;
  onProgress?: ProvisionProgressCallback;
  _executor?: WranglerExecutor;
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
  const _executor = opts._executor;
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
    _executor,
  });

  // 2. KV Namespace
  onProgress?.('kv', config.kv_name);
  resources.kv_name = config.kv_name;
  resources.kv_id = await ensureKv(config.kv_name, {
    accountId,
    expectedExistingId: existingResources?.kv_id,
    adoptExisting,
    _executor,
  });

  // 3. R2 Bucket
  onProgress?.('r2', config.r2_name);
  resources.r2_name = await ensureR2(config.r2_name, {
    accountId,
    expectedExistingId: existingResources?.r2_name,
    adoptExisting,
    _executor,
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
      _executor,
    });
    resources.queues!.push(q);
  }

  return resources;
}

export interface DestroyResult {
  deleted: string[];
  errors: Array<{ resource: string; error: string }>;
}

export interface DestroyAllOpts {
  onProgress?: ProvisionProgressCallback;
  _executor?: WranglerExecutor;
}

export async function destroyAll(
  config: InitConfig,
  resources?: ProvisionedResources,
  optsOrProgress?: ProvisionProgressCallback | DestroyAllOpts,
): Promise<DestroyResult> {
  const onProgress = typeof optsOrProgress === 'function' ? optsOrProgress : optsOrProgress?.onProgress;
  const _executor = typeof optsOrProgress === 'object' ? optsOrProgress._executor : undefined;
  const accountId = config.account_id;
  const deleted: string[] = [];
  const errors: Array<{ resource: string; error: string }> = [];

  // Determine queues to teardown (primary queues before dead-letter queues)
  const queuePlan = getDeploymentQueueNames(config.deployment_name);
  const queuesToTeardown = resources?.queues && resources.queues.length > 0
    ? [
        ...resources.queues.filter((q) => !q.endsWith('-dlq')),
        ...resources.queues.filter((q) => q.endsWith('-dlq')),
      ]
    : queuePlan.allInTeardownOrder;

  // Step 1: Detach queue consumers BEFORE deleting Worker (Cloudflare code 10064 prevents Worker deletion while bound as consumer)
  // Only primary queues have consumer workers attached; DLQs do not.
  const consumerQueues = queuesToTeardown.filter((q) => !q.endsWith('-dlq'));
  for (const q of consumerQueues) {
    onProgress?.('detach-queue-consumer', q);
    try {
      await removeQueueConsumer(q, config.deployment_name, accountId, _executor);
      deleted.push(`consumer:${q}->${config.deployment_name}`);
    } catch (err: any) {
      errors.push({ resource: `consumer:${q}->${config.deployment_name}`, error: err.message });
    }
  }

  // Step 2: Delete Worker
  onProgress?.('delete-worker', config.deployment_name);
  try {
    await deleteWorker(config.deployment_name, accountId, _executor);
    deleted.push(`worker:${config.deployment_name}`);
  } catch (err: any) {
    errors.push({ resource: `worker:${config.deployment_name}`, error: err.message });
  }

  // Step 3: Delete Queues: Primary queues FIRST, then dead-letter queues
  for (const q of queuesToTeardown) {
    onProgress?.('delete-queue', q);
    try {
      await deleteQueue(q, accountId, _executor);
      deleted.push(`queue:${q}`);
    } catch (err: any) {
      errors.push({ resource: `queue:${q}`, error: err.message });
    }
  }

  // Step 4: D1 Database (by UUID to avoid stale config name resolution error 7404)
  const d1Target = resources?.d1_id || resources?.d1_name || config.d1_name;
  if (d1Target) {
    onProgress?.('delete-d1', d1Target);
    try {
      await deleteD1(d1Target, accountId, _executor);
      deleted.push(`d1:${d1Target}`);
    } catch (err: any) {
      errors.push({ resource: `d1:${d1Target}`, error: err.message });
    }
  }

  // Step 5: KV Namespace
  const kvTarget = resources?.kv_id || resources?.kv_name || config.kv_name;
  if (kvTarget) {
    onProgress?.('delete-kv', kvTarget);
    try {
      await deleteKv(kvTarget, accountId, _executor);
      deleted.push(`kv:${kvTarget}`);
    } catch (err: any) {
      errors.push({ resource: `kv:${kvTarget}`, error: err.message });
    }
  }

  // Step 6: R2 Bucket
  const r2Name = resources?.r2_name ?? config.r2_name;
  if (r2Name) {
    onProgress?.('delete-r2', r2Name);
    try {
      await deleteR2(r2Name, accountId, _executor);
      deleted.push(`r2:${r2Name}`);
    } catch (err: any) {
      errors.push({ resource: `r2:${r2Name}`, error: err.message });
    }
  }

  // Step 7: Workflows (best-effort cleanup)
  for (const wf of ['refund-reconciliation', 'reconciliation-sweep']) {
    try {
      await deleteWorkflow(wf, accountId, _executor);
    } catch {
      // Best-effort cleanup
    }
  }

  return { deleted, errors };
}
