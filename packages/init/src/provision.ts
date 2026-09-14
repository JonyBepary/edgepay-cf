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

export async function destroyAll(
  config: InitConfig,
  resources?: ProvisionedResources,
  onProgress?: ProvisionProgressCallback,
): Promise<void> {
  const accountId = config.account_id;

  // Queues
  const queues = resources?.queues ?? [
    'webhook-out',
    'webhook-out-dlq',
    'email-out',
    'email-out-dlq',
    'sms-parse',
    'sms-parse-dlq',
  ];
  for (const q of queues) {
    onProgress?.('delete-queue', q);
    await deleteQueue(q, accountId);
  }

  // R2
  const r2Name = resources?.r2_name ?? config.r2_name;
  onProgress?.('delete-r2', r2Name);
  await deleteR2(r2Name, accountId);

  // KV
  if (resources?.kv_id) {
    onProgress?.('delete-kv', resources.kv_id);
    await deleteKv(resources.kv_id, accountId);
  }

  // D1
  const d1Name = resources?.d1_name ?? config.d1_name;
  onProgress?.('delete-d1', d1Name);
  await deleteD1(d1Name, accountId);
}
