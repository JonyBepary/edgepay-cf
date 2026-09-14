import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadState, saveState, clearState, type InitState } from '../src/state.js';
import { generateSecrets } from '../src/secrets.js';
import { renderWranglerConfig } from '../src/render-config.js';
import { extractDeploymentUrl } from '../src/deploy.js';
import { extractJson } from '../src/wrangler.js';
import { ConfigSchema } from '../src/prompts.js';
import { parseArgs } from '../src/index.js';
import { checkPrereqs } from '../src/prereqs.js';

describe('@edgepay/init - Installer Suite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edgepay-init-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('State Management & Resume Support', () => {
    it('initializes clean default state when file does not exist', async () => {
      const stateFile = path.join(tmpDir, 'state.json');
      const state = await loadState(stateFile);
      expect(state.version).toBe(1);
      expect(state.prereqs_done).toBeUndefined();
      expect(state.started_at).toBeDefined();
    });

    it('persists and resumes partial state across runs', async () => {
      const stateFile = path.join(tmpDir, 'state.json');
      const partialState: InitState = {
        version: 1,
        started_at: new Date().toISOString(),
        prereqs_done: true,
        auth_done: true,
        config: {
          deployment_name: 'test-edgepay',
          account_id: 'acc123',
          account_name: 'Test Account',
          primary_currency: 'BDT',
          merchant_name: 'Test Store',
          generate_secrets: true,
          d1_name: 'test-edgepay-db',
          kv_name: 'test-edgepay-kv',
          r2_name: 'test-edgepay-assets',
          secrets: generateSecrets(),
        },
      };

      await saveState(partialState, stateFile);
      const resumed = await loadState(stateFile);

      expect(resumed.prereqs_done).toBe(true);
      expect(resumed.auth_done).toBe(true);
      expect(resumed.config?.deployment_name).toBe('test-edgepay');
      // Secrets must NEVER be written to the state file
      expect(resumed.config?.secrets).toBeUndefined();
      const rawJson = await fs.readFile(stateFile, 'utf-8');
      expect(rawJson).not.toContain('jwt_secret');
      expect(rawJson).not.toContain('app_key');
      expect(rawJson).not.toContain('encryption_key');
    });

    it('clears state file when clearState is called', async () => {
      const stateFile = path.join(tmpDir, 'state.json');
      await saveState({ version: 1, started_at: 'now' }, stateFile);
      expect(await fs.stat(stateFile)).toBeDefined();

      await clearState(stateFile);
      const reloaded = await loadState(stateFile);
      expect(reloaded.prereqs_done).toBeUndefined();
    });
  });

  describe('Secret Generation & Storage', () => {
    it('generates cryptographically secure secrets with correct lengths and encodings', () => {
      const s = generateSecrets();

      // JWT_SECRET: 32 random bytes as hex = 64 characters
      expect(s.jwt_secret).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(s.jwt_secret)).toBe(true);

      // APP_KEY: 32 random bytes as base64 = 44 characters
      expect(s.app_key).toHaveLength(44);
      expect(/^[A-Za-z0-9+/]+={0,2}$/.test(s.app_key)).toBe(true);

      // ENCRYPTION_KEY: 32 random bytes as base64 = 44 characters
      expect(s.encryption_key).toHaveLength(44);
      expect(/^[A-Za-z0-9+/]+={0,2}$/.test(s.encryption_key)).toBe(true);

      // Each generation must be unique
      const s2 = generateSecrets();
      expect(s.jwt_secret).not.toBe(s2.jwt_secret);
      expect(s.app_key).not.toBe(s2.app_key);
      expect(s.encryption_key).not.toBe(s2.encryption_key);
    });

    it('syncs and reads secrets from .dev.vars with strict 0o600 permissions and marker', async () => {
      const { syncDevVars, readDevVars, DEV_VARS_MARKER } = await import('../src/secrets.js');
      const originalSecrets = generateSecrets();

      await syncDevVars(originalSecrets, tmpDir);

      const devVarsFile = path.join(tmpDir, '.dev.vars');
      const stat = await fs.stat(devVarsFile);
      // Mode must not have any permissions for group or others (0o077 mask must be 0)
      expect(stat.mode & 0o077).toBe(0);

      const rawContent = await fs.readFile(devVarsFile, 'utf-8');
      expect(rawContent).toContain(DEV_VARS_MARKER);

      const readBack = await readDevVars(tmpDir);
      expect(readBack.jwt_secret).toBe(originalSecrets.jwt_secret);
      expect(readBack.app_key).toBe(originalSecrets.app_key);
      expect(readBack.encryption_key).toBe(originalSecrets.encryption_key);
    });

    it('refuses to read secrets from an unmanaged foreign .dev.vars file', async () => {
      const { readDevVars } = await import('../src/secrets.js');
      const foreignDir = path.join(tmpDir, 'foreign');
      await fs.mkdir(foreignDir, { recursive: true });
      await fs.writeFile(
        path.join(foreignDir, '.dev.vars'),
        'JWT_SECRET=foreign_jwt\nAPP_KEY=foreign_app\nENCRYPTION_KEY=foreign_enc\n',
      );

      const readForeign = await readDevVars(foreignDir);
      expect(readForeign).toEqual({});
    });

    it('preserves existing custom keys and comments in .dev.vars', async () => {
      const { syncDevVars, DEV_VARS_MARKER } = await import('../src/secrets.js');
      const devVarsFile = path.join(tmpDir, '.dev.vars');
      await fs.writeFile(
        devVarsFile,
        `${DEV_VARS_MARKER}\n# custom note\nCUSTOM_VAR="my value with spaces"\n`,
      );

      const secrets = generateSecrets();
      await syncDevVars(secrets, tmpDir);

      const content = await fs.readFile(devVarsFile, 'utf-8');
      expect(content).toContain('# custom note');
      expect(content).toContain('CUSTOM_VAR="my value with spaces"');
      expect(content).toContain(`JWT_SECRET=${secrets.jwt_secret}`);
    });

    it('.dev.vars is gitignored', async () => {
      const { execa } = await import('execa');
      const { stdout } = await execa('git', ['check-ignore', '.dev.vars']);
      expect(stdout.trim()).toBe('.dev.vars');
    });
  });

  describe('Config Rendering', () => {
    it('renders clean wrangler.jsonc with provisioned resource bindings', async () => {
      const baseConfig = path.join(tmpDir, 'base.jsonc');
      await fs.writeFile(
        baseConfig,
        JSON.stringify({
          name: 'placeholder',
          vars: { DEFAULT_CURRENCY: 'USD', APP_NAME: 'Old' },
        }),
      );

      const targetConfig = path.join(tmpDir, 'wrangler.jsonc');
      const config = {
        deployment_name: 'prod-pay',
        account_id: 'acc1',
        account_name: 'My Acc',
        primary_currency: 'BDT',
        merchant_name: 'My New Store',
        generate_secrets: true,
        d1_name: 'prod-pay-db',
        kv_name: 'prod-pay-kv',
        r2_name: 'prod-pay-assets',
        secrets: generateSecrets(),
      };

      const resources = {
        d1_name: 'prod-pay-db',
        d1_id: 'd1-uuid-12345',
        kv_name: 'prod-pay-kv',
        kv_id: 'kv-id-67890',
        r2_name: 'prod-pay-assets',
        queues: ['webhook-out'],
      };

      await renderWranglerConfig(config, resources, {
        baseConfigPath: baseConfig,
        targetConfigPath: targetConfig,
        projectRoot: tmpDir,
      });

      const written = JSON.parse(await fs.readFile(targetConfig, 'utf-8')) as {
        name: string;
        vars: { DEFAULT_CURRENCY: string; APP_NAME: string };
        d1_databases: Array<{ binding: string; database_id: string; database_name: string }>;
        kv_namespaces: Array<{ binding: string; id: string }>;
        r2_buckets: Array<{ binding: string; bucket_name: string }>;
      };

      expect(written.name).toBe('prod-pay');
      expect(written.vars.DEFAULT_CURRENCY).toBe('BDT');
      expect(written.vars.APP_NAME).toBe('My New Store');
      expect(written.d1_databases[0].database_id).toBe('d1-uuid-12345');
      expect(written.kv_namespaces[0].id).toBe('kv-id-67890');
      expect(written.r2_buckets[0].bucket_name).toBe('prod-pay-assets');
    });

    it('removes wrangler.toml if present to prevent ambiguous config error', async () => {
      const tomlFile = path.join(tmpDir, 'wrangler.toml');
      await fs.writeFile(tomlFile, 'name = "legacy"');

      const config = {
        deployment_name: 'prod-pay',
        account_id: 'acc1',
        account_name: 'My Acc',
        primary_currency: 'BDT',
        merchant_name: 'Store',
        generate_secrets: true,
        d1_name: 'db',
        kv_name: 'kv',
        r2_name: 'r2',
        secrets: generateSecrets(),
      };

      await renderWranglerConfig(config, {}, { projectRoot: tmpDir });

      await expect(fs.stat(tomlFile)).rejects.toThrow();
    });
  });

  describe('Wrangler Output Extraction & Deployment URL Parsing', () => {
    it('extracts JSON from Wrangler CLI text output with headers', () => {
      const raw = `
 ⛅️ wrangler 4.127.1
────────────────────
[
  {
    "uuid": "4bb2ca10-2499-4eea-84e8-d8105958e8f8",
    "name": "edgepay-cf"
  }
]
`;
      const parsed = extractJson<Array<{ uuid: string; name: string }>>(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].uuid).toBe('4bb2ca10-2499-4eea-84e8-d8105958e8f8');
    });

    it('extracts deployment URL from wrangler deploy output', () => {
      const output1 = `
Uploaded 47 assets
Total Upload: 104.23 KiB / gzip: 28.51 KiB
Uploaded edgepay-cf (3.21 sec)
Published edgepay-cf (1.05 sec)
  https://edgepay-cf.bm-jonybepary.workers.dev
Current Version ID: abc-123
`;
      expect(extractDeploymentUrl(output1)).toBe('https://edgepay-cf.bm-jonybepary.workers.dev');

      const output2 = `Deployment complete: https://my-custom-subdomain.workers.dev`;
      expect(extractDeploymentUrl(output2)).toBe('https://my-custom-subdomain.workers.dev');

      const output3 = `No url found`;
      expect(extractDeploymentUrl(output3)).toBeNull();
    });
  });

  describe('CLI Argument Parsing', () => {
    it('parses all flags correctly with distinct preview and dryRun semantics', () => {
      expect(parseArgs(['--preview', '--verbose'])).toEqual({
        dryRun: false,
        preview: true,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: true,
        yes: false,
        help: false,
        version: false,
      });

      expect(parseArgs(['--dry-run'])).toEqual({
        dryRun: true,
        preview: false,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: false,
        yes: false,
        help: false,
        version: false,
      });

      expect(parseArgs(['--destroy', '--i-know-what-im-doing', '-y'])).toEqual({
        dryRun: false,
        preview: false,
        destroy: true,
        iKnowWhatImDoing: true,
        verbose: false,
        yes: true,
        help: false,
        version: false,
      });

      expect(parseArgs(['--help'])).toEqual({
        dryRun: false,
        preview: false,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: false,
        yes: false,
        help: true,
        version: false,
      });

      expect(parseArgs(['--version'])).toEqual({
        dryRun: false,
        preview: false,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: false,
        yes: false,
        help: false,
        version: true,
      });
    });
  });

  describe('Cloudflare Error Classification & isNotFound', () => {
    it('accurately identifies resource-not-found errors', async () => {
      const { isNotFound } = await import('../src/wrangler.js');

      expect(isNotFound(new Error('Database not found: edgepay-db [code: 7000]'))).toBe(true);
      expect(isNotFound(new Error('Namespace not found [code: 10014]'))).toBe(true);
      expect(isNotFound(new Error('The specified bucket does not exist [code: 10006]'))).toBe(true);
      expect(isNotFound(new Error('Could not find queue: webhook-out [code: 11001]'))).toBe(true);
    });

    it('refuses to treat authentication, authorization, or user errors as not-found', async () => {
      const { isNotFound } = await import('../src/wrangler.js');

      expect(isNotFound(new Error('Authentication error [code: 10000]'))).toBe(false);
      expect(isNotFound(new Error('Permission denied [code: 10007]'))).toBe(false);
      expect(isNotFound(new Error('Unauthorized access'))).toBe(false);
      expect(isNotFound(new Error('Forbidden: insufficient permissions'))).toBe(false);
      expect(isNotFound(new Error('User not found in organization'))).toBe(false);
      expect(isNotFound(new Error('Account not found with ID 12345'))).toBe(false);
    });
  });

  describe('Queue Scoping & Teardown Ordering', () => {
    it('scopes queue names for non-default deployments to prevent account collisions', async () => {
      const { getDeploymentQueueNames } = await import('../src/provision.js');

      const defaultQueues = getDeploymentQueueNames('edgepay-cf');
      expect(defaultQueues.webhookOut).toBe('webhook-out');
      expect(defaultQueues.webhookOutDlq).toBe('webhook-out-dlq');

      const scopedQueues = getDeploymentQueueNames('store-abc');
      expect(scopedQueues.webhookOut).toBe('store-abc-webhook-out');
      expect(scopedQueues.webhookOutDlq).toBe('store-abc-webhook-out-dlq');
      expect(scopedQueues.emailOut).toBe('store-abc-email-out');
      expect(scopedQueues.smsParse).toBe('store-abc-sms-parse');
    });

    it('orders primary queues before dead-letter queues in teardown order', async () => {
      const { getDeploymentQueueNames } = await import('../src/provision.js');
      const plan = getDeploymentQueueNames('edgepay-cf');

      const teardownOrder = plan.allInTeardownOrder;
      expect(teardownOrder.indexOf('webhook-out')).toBeLessThan(teardownOrder.indexOf('webhook-out-dlq'));
      expect(teardownOrder.indexOf('email-out')).toBeLessThan(teardownOrder.indexOf('email-out-dlq'));
      expect(teardownOrder.indexOf('sms-parse')).toBeLessThan(teardownOrder.indexOf('sms-parse-dlq'));
    });
  });

  describe('Schema Validation', () => {
    it('validates deployment names', () => {
      expect(ConfigSchema.shape.deployment_name.safeParse('edgepay-prod').success).toBe(true);
      expect(ConfigSchema.shape.deployment_name.safeParse('edgepay_store_1').success).toBe(true);
      expect(ConfigSchema.shape.deployment_name.safeParse('ep').success).toBe(false); // < 3 chars
      expect(ConfigSchema.shape.deployment_name.safeParse('Invalid Name!').success).toBe(false); // invalid chars
    });

    it('validates primary currency', () => {
      expect(ConfigSchema.shape.primary_currency.safeParse('BDT').success).toBe(true);
      expect(ConfigSchema.shape.primary_currency.safeParse('USD').success).toBe(true);
      expect(ConfigSchema.shape.primary_currency.safeParse('BD').success).toBe(false);
      expect(ConfigSchema.shape.primary_currency.safeParse('USDT').success).toBe(false);
    });
  });

  describe('Prerequisites Verification', () => {
    it('passes prerequisite check in current test environment', async () => {
      const res = await checkPrereqs();
      expect(res.ok).toBe(true);
      expect(res.nodeVersion).toBeDefined();
      expect(res.wranglerVersion).toBeDefined();
      expect(res.gitVersion).toBeDefined();
    });
  });
});
