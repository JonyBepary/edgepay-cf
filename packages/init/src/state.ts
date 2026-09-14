import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_STATE_FILE = '.edgepay-init.json';

export interface InitSecrets {
  jwt_secret: string;
  app_key: string;
  encryption_key: string;
}

export interface InitConfig {
  deployment_name: string;
  account_id: string;
  account_name: string;
  primary_currency: string;
  merchant_name: string;
  generate_secrets: boolean;
  d1_name: string;
  kv_name: string;
  r2_name: string;
  secrets?: InitSecrets;
}

export interface ProvisionedResources {
  d1_id?: string;
  d1_name?: string;
  kv_id?: string;
  kv_name?: string;
  r2_name?: string;
  queues?: string[];
}

export interface InitState {
  version: 1;
  started_at: string;
  prereqs_done?: boolean;
  auth_done?: boolean;
  config?: InitConfig;
  provisioned?: boolean;
  resources?: ProvisionedResources;
  config_rendered?: boolean;
  migrations_applied?: boolean;
  secrets_pushed?: boolean;
  deployed?: boolean;
  deployment_url?: string;
  verified?: boolean;
}

export function sanitizeState(state: InitState): InitState {
  const copy: InitState = JSON.parse(JSON.stringify(state));
  if (copy.config && copy.config.secrets) {
    delete copy.config.secrets;
  }
  return copy;
}

export async function loadState(filePath: string = DEFAULT_STATE_FILE): Promise<InitState> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as InitState;
    if (parsed && parsed.version === 1) {
      return parsed;
    }
  } catch {
    // File missing or invalid JSON: initialize clean state
  }
  return { version: 1, started_at: new Date().toISOString() };
}

export async function saveState(state: InitState, filePath: string = DEFAULT_STATE_FILE): Promise<void> {
  const dir = path.dirname(path.resolve(filePath));
  await fs.mkdir(dir, { recursive: true });
  const sanitized = sanitizeState(state);
  await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
}

export async function clearState(filePath: string = DEFAULT_STATE_FILE): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
