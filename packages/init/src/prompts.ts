import * as p from '@clack/prompts';
import { z } from 'zod';
import { generateSecrets } from './secrets.js';
import type { InitConfig } from './state.js';
import type { WhoamiAccount } from './wrangler.js';

export const ConfigSchema = z.object({
  deployment_name: z.string().min(3).max(63).regex(/^[a-z0-9-_]+$/, 'Lowercase alphanumeric, hyphen, underscore only'),
  primary_currency: z.string().min(3).max(3).toUpperCase(),
  merchant_name: z.string().min(2).max(100),
  generate_secrets: z.boolean(),
});

export interface PromptOptions {
  nonInteractive?: boolean;
  defaults?: Partial<InitConfig>;
}

export async function gatherConfig(
  account: WhoamiAccount,
  opts: PromptOptions = {},
): Promise<InitConfig> {
  if (opts.nonInteractive) {
    const deployment_name = opts.defaults?.deployment_name || 'edgepay-prod';
    const primary_currency = (opts.defaults?.primary_currency || 'BDT').toUpperCase();
    const merchant_name = opts.defaults?.merchant_name || 'EdgePay Store';
    const secrets = opts.defaults?.secrets || generateSecrets();

    return {
      deployment_name,
      account_id: account.id,
      account_name: account.name,
      primary_currency,
      merchant_name,
      generate_secrets: true,
      d1_name: `${deployment_name}-db`,
      kv_name: `${deployment_name}-kv`,
      r2_name: `${deployment_name}-assets`,
      secrets,
    };
  }

  // 1. Deployment name
  const deploymentNameRes = await p.text({
    message: 'Deployment name',
    placeholder: 'edgepay-prod',
    defaultValue: opts.defaults?.deployment_name || 'edgepay-prod',
    validate: (value) => {
      const parsed = ConfigSchema.shape.deployment_name.safeParse(value || 'edgepay-prod');
      if (!parsed.success) return parsed.error.issues[0].message;
    },
  });
  if (p.isCancel(deploymentNameRes)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  const deployment_name = (deploymentNameRes || 'edgepay-prod').trim();

  // 2. Primary currency
  const currencyRes = await p.select({
    message: 'Primary currency',
    options: [
      { value: 'BDT', label: 'BDT (Bangladeshi Taka)' },
      { value: 'USD', label: 'USD (US Dollar)' },
      { value: 'EUR', label: 'EUR (Euro)' },
      { value: 'GBP', label: 'GBP (British Pound)' },
      { value: 'INR', label: 'INR (Indian Rupee)' },
    ],
    initialValue: opts.defaults?.primary_currency || 'BDT',
  });
  if (p.isCancel(currencyRes)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  const primary_currency = String(currencyRes);

  // 3. Merchant / Store name
  const merchantNameRes = await p.text({
    message: 'Merchant / Store name',
    placeholder: 'Acme Store',
    defaultValue: opts.defaults?.merchant_name || 'Acme Store',
    validate: (value) => {
      if (!value || value.trim().length < 2) return 'Store name must be at least 2 characters';
    },
  });
  if (p.isCancel(merchantNameRes)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  const merchant_name = (merchantNameRes || 'Acme Store').trim();

  // 4. Generate secrets automatically
  const genSecretsRes = await p.confirm({
    message: 'Generate cryptographic secrets automatically? (JWT_SECRET, APP_KEY, ENCRYPTION_KEY)',
    initialValue: true,
  });
  if (p.isCancel(genSecretsRes)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  const generate_secrets = Boolean(genSecretsRes);

  const secrets = opts.defaults?.secrets || generateSecrets();

  return {
    deployment_name,
    account_id: account.id,
    account_name: account.name,
    primary_currency,
    merchant_name,
    generate_secrets,
    d1_name: `${deployment_name}-db`,
    kv_name: `${deployment_name}-kv`,
    r2_name: `${deployment_name}-assets`,
    secrets,
  };
}
