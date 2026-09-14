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

export function getDeploymentQueueNames(deploymentName: string): DeploymentQueueNames {
  const isDefault = deploymentName === 'edgepay-cf';
  const prefix = isDefault ? '' : `${deploymentName}-`;

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

export async function provisionAll(
  config: InitConfig,
  existingResources?: ProvisionedResources,
  onProgress?: ProvisionProgressCallback,
): Promise<ProvisionedResources> {
  const accountId = config.account_id;
  const resources: ProvisionedResources = {
    queues: [],
  };

  // 1. D1 Database
  onProgress?.('d1', config.d1_name);
  resources.d1_name = config.d1_name;
  resources.d1_id = await ensureD1(config.d1_name, {
    accountId,
    expectedExistingId: existingResources?.d1_id,
  });

  // 2. KV Namespace
  onProgress?.('kv', config.kv_name);
  resources.kv_name = config.kv_name;
  resources.kv_id = await ensureKv(config.kv_name, {
    accountId,
    expectedExistingId: existingResources?.kv_id,
  });

  // 3. R2 Bucket
  onProgress?.('r2', config.r2_name);
  resources.r2_name = await ensureR2(config.r2_name, {
    accountId,
    expectedExistingId: existingResources?.r2_name,
  });

  // 4. Queues & DLQs
  const queuePlan = getDeploymentQueueNames(config.deployment_name);
  for (const q of queuePlan.allInProvisionOrder) {
    onProgress?.('queue', q);
    await ensureQueue(q, {
      accountId,
      expectedExistingId: existingResources?.queues?.find((x) => x === q),
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
