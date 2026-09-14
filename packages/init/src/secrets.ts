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

export const DEV_VARS_MARKER = '# managed by @edgepay/init - DO NOT COMMIT TO VERSION CONTROL';

export async function readDevVars(projectRoot: string = process.cwd()): Promise<Partial<InitSecrets>> {
  const filePath = path.join(projectRoot, '.dev.vars');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Scoped safety: refuse to read an unmanaged foreign .dev.vars
    if (!raw.includes(DEV_VARS_MARKER)) {
      return {};
    }

    const result: Partial<InitSecrets> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue; // Skip comments

      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1);
        if (val.endsWith('\r')) val = val.slice(0, -1);

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
  let existingContent = '';
  try {
    existingContent = await fs.readFile(filePath, 'utf-8');
  } catch {
    // file does not exist yet
  }

  const lines = existingContent.split('\n');
  const otherLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === DEV_VARS_MARKER) continue;
    if (trimmed.startsWith('#')) {
      otherLines.push(line);
      continue;
    }
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      if (key !== 'JWT_SECRET' && key !== 'APP_KEY' && key !== 'ENCRYPTION_KEY') {
        otherLines.push(line);
      }
    } else {
      otherLines.push(line);
    }
  }

  const outputLines = [
    DEV_VARS_MARKER,
    ...otherLines,
    `JWT_SECRET=${secrets.jwt_secret}`,
    `APP_KEY=${secrets.app_key}`,
    `ENCRYPTION_KEY=${secrets.encryption_key}`,
    '',
  ];

  const content = outputLines.join('\n');
  await fs.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
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
