import { wrangler } from './wrangler.js';

export interface MigrationOptions {
  accountId?: string;
  configPath?: string;
  cwd?: string;
}

export async function applyMigrations(
  databaseBinding = 'DB',
  opts: MigrationOptions = {},
): Promise<string> {
  const args = ['d1', 'migrations', 'apply', databaseBinding, '--remote'];
  if (opts.configPath) {
    args.push('--config', opts.configPath);
  }

  const output = (await wrangler(args, {
    accountId: opts.accountId,
    cwd: opts.cwd,
    silent: true,
  })) as string;

  return output;
}
