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

  const renderedJson = JSON.stringify(parsed, null, 2);
  await fs.writeFile(targetPath, renderedJson, 'utf-8');
  return targetPath;
}
