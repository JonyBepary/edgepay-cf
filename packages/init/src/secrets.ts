import fs from 'node:fs/promises';
import path from 'node:path';
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
  projectRoot?: string;
}

export async function readDevVars(projectRoot: string = process.cwd()): Promise<Partial<InitSecrets>> {
  const filePath = path.join(projectRoot, '.dev.vars');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const result: Partial<InitSecrets> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        if (key === 'JWT_SECRET') result.jwt_secret = val;
        if (key === 'APP_KEY') result.app_key = val;
        if (key === 'ENCRYPTION_KEY') result.encryption_key = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function syncDevVars(
  secrets: InitSecrets,
  projectRoot: string = process.cwd(),
): Promise<void> {
  const filePath = path.join(projectRoot, '.dev.vars');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // file does not exist yet
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const map = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
  }

  map.set('JWT_SECRET', secrets.jwt_secret);
  map.set('APP_KEY', secrets.app_key);
  map.set('ENCRYPTION_KEY', secrets.encryption_key);

  const out = Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

  await fs.writeFile(filePath, out, 'utf-8');
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
): Promise<InitSecrets> {
  let secrets = config.secrets;

  if (!secrets || !secrets.jwt_secret || !secrets.app_key || !secrets.encryption_key) {
    const devVars = await readDevVars(opts.projectRoot);
    if (devVars.jwt_secret && devVars.app_key && devVars.encryption_key) {
      secrets = devVars as InitSecrets;
    } else {
      secrets = generateSecrets();
    }
    config.secrets = secrets;
  }

  await syncDevVars(secrets, opts.projectRoot);

  const workerName = config.deployment_name;
  await pushSecret('JWT_SECRET', secrets.jwt_secret, workerName, opts);
  await pushSecret('APP_KEY', secrets.app_key, workerName, opts);
  await pushSecret('ENCRYPTION_KEY', secrets.encryption_key, workerName, opts);

  return secrets;
}
