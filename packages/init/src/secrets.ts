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
  adoptLegacyDevVars?: boolean;
}

export const DEV_VARS_MARKER = '# managed by @edgepay/init - DO NOT COMMIT TO VERSION CONTROL';

export interface ReadDevVarsOptions {
  adoptLegacyDevVars?: boolean;
}

export async function readDevVars(
  projectRoot: string = process.cwd(),
  opts: ReadDevVarsOptions = {},
): Promise<Partial<InitSecrets>> {
  const filePath = path.join(projectRoot, '.dev.vars');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return {};
  }

  const hasMarker = raw.includes(DEV_VARS_MARKER);
  const parsedKeys: Partial<InitSecrets> = {};
  let hasAnyKeys = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = line.indexOf('=');
    if (idx > 0) {
      hasAnyKeys = true;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1);
      if (val.endsWith('\r')) val = val.slice(0, -1);

      if (key === 'JWT_SECRET') parsedKeys.jwt_secret = val;
      if (key === 'APP_KEY') parsedKeys.app_key = val;
      if (key === 'ENCRYPTION_KEY') parsedKeys.encryption_key = val;
    }
  }

  if (!hasMarker) {
    if (hasAnyKeys) {
      if (!opts.adoptLegacyDevVars) {
        throw new Error(
          `Existing .dev.vars found without @edgepay/init management header.\n` +
          `Refusing to silently generate new secrets, which would rotate existing credentials and invalidate active JWTs/sessions.\n` +
          `To adopt this existing file and preserve your keys, re-run with: --adopt-legacy-dev-vars\n` +
          `Alternatively, backup and delete .dev.vars if you explicitly intend to generate fresh keys.`,
        );
      }
      return parsedKeys;
    }
    return {};
  }

  return parsedKeys;
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
    const devVars = await readDevVars(opts.projectRoot, {
      adoptLegacyDevVars: opts.adoptLegacyDevVars,
    });
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
