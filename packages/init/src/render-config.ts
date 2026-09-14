import fs from 'node:fs/promises';
import path from 'node:path';
import type { InitConfig, ProvisionedResources } from './state.js';

export interface RenderConfigOptions {
  baseConfigPath?: string;
  targetConfigPath?: string;
  projectRoot?: string;
}

export async function renderWranglerConfig(
  config: InitConfig,
  resources: ProvisionedResources,
  opts: RenderConfigOptions = {},
): Promise<string> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const targetPath = opts.targetConfigPath ?? path.join(projectRoot, 'wrangler.jsonc');
  const basePath = opts.baseConfigPath ?? targetPath;

  // Prevent Wrangler config ambiguity by removing wrangler.toml if present
  const tomlPath = path.join(projectRoot, 'wrangler.toml');
  await fs.unlink(tomlPath).catch(() => {});

  let rawContent: string | null = null;
  try {
    rawContent = await fs.readFile(basePath, 'utf-8');
  } catch {
    // If basePath is not found, we'll build a clean config
  }

  let parsed: Record<string, unknown> = {};
  if (rawContent) {
    try {
      // Clean comments if standard JSON parse, or use regex replacements to preserve comments
      parsed = JSON.parse(
        rawContent.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1'),
      ) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  // Update top-level name
  parsed.name = config.deployment_name;

  // Update vars
  const vars = (parsed.vars ?? {}) as Record<string, unknown>;
  vars.APP_NAME = config.merchant_name;
  vars.DEFAULT_CURRENCY = config.primary_currency;
  vars.ENVIRONMENT = 'production';
  parsed.vars = vars;

  // Update D1 database binding
  parsed.d1_databases = [
    {
      binding: 'DB',
      database_name: resources.d1_name ?? config.d1_name,
      database_id: resources.d1_id ?? 'pending',
      migrations_dir: 'migrations',
    },
  ];

  // Update KV namespace binding
  parsed.kv_namespaces = [
    {
      binding: 'KV',
      id: resources.kv_id ?? 'pending',
    },
  ];

  // Update R2 bucket binding
  parsed.r2_buckets = [
    {
      binding: 'R2',
      bucket_name: resources.r2_name ?? config.r2_name,
    },
  ];

  // Update Queues if provisioned
  if (resources.queues && resources.queues.length >= 6) {
    const webhookOut = resources.queues.find((q) => q.endsWith('webhook-out')) ?? 'webhook-out';
    const webhookDlq = resources.queues.find((q) => q.endsWith('webhook-out-dlq')) ?? 'webhook-out-dlq';
    const emailOut = resources.queues.find((q) => q.endsWith('email-out')) ?? 'email-out';
    const emailDlq = resources.queues.find((q) => q.endsWith('email-out-dlq')) ?? 'email-out-dlq';
    const smsParse = resources.queues.find((q) => q.endsWith('sms-parse')) ?? 'sms-parse';
    const smsDlq = resources.queues.find((q) => q.endsWith('sms-parse-dlq')) ?? 'sms-parse-dlq';

    parsed.queues = {
      producers: [
        { queue: webhookOut, binding: 'WEBHOOK_QUEUE' },
        { queue: emailOut, binding: 'EMAIL_QUEUE' },
        { queue: smsParse, binding: 'SMS_QUEUE' },
      ],
      consumers: [
        {
          queue: webhookOut,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
          dead_letter_queue: webhookDlq,
        },
        {
          queue: emailOut,
          max_batch_size: 25,
          max_batch_timeout: 30,
          max_retries: 5,
          dead_letter_queue: emailDlq,
        },
        {
          queue: smsParse,
          max_batch_size: 50,
          max_batch_timeout: 10,
          max_retries: 3,
          dead_letter_queue: smsDlq,
        },
      ],
    };
  }

  const renderedJson = JSON.stringify(parsed, null, 2);
  await fs.writeFile(targetPath, renderedJson, 'utf-8');
  return targetPath;
}
