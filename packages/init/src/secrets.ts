import crypto from 'node:crypto';
import { wrangler } from './wrangler.js';
import type { InitConfig, InitSecrets } from './state.js';

export function generateSecrets(): InitSecrets {
  return {
    jwt_secret: crypto.randomBytes(32).toString('hex'),
    app_key: crypto.randomBytes(32).toString('base64'),
    encryption_key: crypto.randomBytes(32).toString('base64'),
  };
}

export interface PushSecretsOptions {
  accountId?: string;
  configPath?: string;
}

export async function pushSecret(
  key: string,
  value: string,
  workerName: string,
  opts: PushSecretsOptions = {},
): Promise<void> {
  const args = ['secret', 'put', key, '--name', workerName];
  if (opts.configPath) {
    args.push('--config', opts.configPath);
  }

  await wrangler(args, {
    input: value,
    accountId: opts.accountId,
    silent: true,
  });
}

export async function pushAllSecrets(
  config: InitConfig,
  opts: PushSecretsOptions = {},
): Promise<void> {
  const secrets = config.secrets;
  const workerName = config.deployment_name;

  await pushSecret('JWT_SECRET', secrets.jwt_secret, workerName, opts);
  await pushSecret('APP_KEY', secrets.app_key, workerName, opts);
  await pushSecret('ENCRYPTION_KEY', secrets.encryption_key, workerName, opts);
}
