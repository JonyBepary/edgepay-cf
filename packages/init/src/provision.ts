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

export async function provisionAll(
  config: InitConfig,
  onProgress?: ProvisionProgressCallback,
): Promise<ProvisionedResources> {
  const accountId = config.account_id;
  const resources: ProvisionedResources = {
    queues: [],
  };

  // 1. D1 Database
  onProgress?.('d1', config.d1_name);
  resources.d1_name = config.d1_name;
  resources.d1_id = await ensureD1(config.d1_name, accountId);

  // 2. KV Namespace
  onProgress?.('kv', config.kv_name);
  resources.kv_name = config.kv_name;
  resources.kv_id = await ensureKv(config.kv_name, accountId);

  // 3. R2 Bucket
  onProgress?.('r2', config.r2_name);
  resources.r2_name = await ensureR2(config.r2_name, accountId);

  // 4. Queues & DLQs
  const queuesToProvision = [
    'webhook-out-dlq',
    'webhook-out',
    'email-out-dlq',
    'email-out',
    'sms-parse-dlq',
    'sms-parse',
  ];

  for (const q of queuesToProvision) {
    onProgress?.('queue', q);
    await ensureQueue(q, accountId);
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
  const primaryQueues = ['webhook-out', 'email-out', 'sms-parse'];
  const dlqQueues = ['webhook-out-dlq', 'email-out-dlq', 'sms-parse-dlq'];

  for (const q of primaryQueues) {
    onProgress?.('delete-queue', q);
    try {
      await deleteQueue(q, accountId);
      deleted.push(`queue:${q}`);
    } catch (err: any) {
      errors.push({ resource: `queue:${q}`, error: err.message });
    }
  }

  for (const q of dlqQueues) {
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
