import { wrangler } from './wrangler.js';
import type { InitConfig } from './state.js';

export interface DeployOptions {
  accountId?: string;
  configPath?: string;
  cwd?: string;
}

export function extractDeploymentUrl(output: string): string | null {
  const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9_.-]*workers\.dev/i)
    || output.match(/https:\/\/[a-zA-Z0-9_.-]+\.[a-zA-Z]{2,}(?:\/[a-zA-Z0-9_.-]*)*\b/i);

  if (match) {
    return match[0];
  }
  return null;
}

export async function deploy(
  config: InitConfig,
  opts: DeployOptions = {},
): Promise<string> {
  const args = ['deploy'];
  if (opts.configPath) {
    args.push('--config', opts.configPath);
  }

  const output = (await wrangler(args, {
    accountId: opts.accountId,
    cwd: opts.cwd,
    silent: true,
  })) as string;

  const url = extractDeploymentUrl(output);
  if (url) {
    return url;
  }

  return `https://${config.deployment_name}.workers.dev`;
}
