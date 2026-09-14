import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    it('--preview mode performs zero disk mutations and does not create state file', async () => {
      const { runInstaller } = await import('../src/index.js');
      const testStateFile = path.join(tmpDir, '.edgepay-init.json');

      await runInstaller([
        '--preview',
        '--yes',
        `--statePath=${testStateFile}`,
        `--projectRoot=${tmpDir}`,
      ]);

      const fileExists = await fs.access(testStateFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    }, 15000);

    it('--preview mode skips cloud auth when existing state has auth_done and config', async () => {
      const authModule = await import('../src/auth.js');
      const ensureAuthSpy = vi.spyOn(authModule, 'ensureAuth');
      const { runInstaller } = await import('../src/index.js');
      const testStateFile = path.join(tmpDir, '.edgepay-init-preview.json');
      await saveState(
        {
          version: 1,
          started_at: '2026-09-14T00:00:00Z',
          prereqs_done: true,
          auth_done: true,
          config: {
            deployment_name: 'existing-preview-dep',
            account_id: 'acc-123',
            account_name: 'Existing Acc',
            primary_currency: 'BDT',
            merchant_name: 'Preview Store',
            generate_secrets: false,
            d1_name: 'existing-preview-dep-db',
            kv_name: 'existing-preview-dep-kv',
            r2_name: 'existing-preview-dep-r2',
          },
        },
        testStateFile,
      );

      const beforeMtime = (await fs.stat(testStateFile)).mtimeMs;
      await runInstaller([
        '--preview',
        '--yes',
        `--statePath=${testStateFile}`,
        `--projectRoot=${tmpDir}`,
      ]);
      const afterMtime = (await fs.stat(testStateFile)).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
      expect(ensureAuthSpy).not.toHaveBeenCalled();
      ensureAuthSpy.mockRestore();
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

    it('refuses to silently rotate secrets when an unmanaged legacy .dev.vars exists with credentials', async () => {
      const { readDevVars } = await import('../src/secrets.js');
      const foreignDir = path.join(tmpDir, 'foreign');
      await fs.mkdir(foreignDir, { recursive: true });
      await fs.writeFile(
        path.join(foreignDir, '.dev.vars'),
        'JWT_SECRET=foreign_jwt\nAPP_KEY=foreign_app\nENCRYPTION_KEY=foreign_enc\n',
      );

      // Without adoptLegacyDevVars: must throw clear error to prevent secret rotation
      await expect(readDevVars(foreignDir)).rejects.toThrow(
        /Existing \.dev\.vars found without @edgepay\/init management header/,
      );

      // With adoptLegacyDevVars: preserves the legacy secrets
      const adopted = await readDevVars(foreignDir, { adoptLegacyDevVars: true });
      expect(adopted.jwt_secret).toBe('foreign_jwt');
      expect(adopted.app_key).toBe('foreign_app');
      expect(adopted.encryption_key).toBe('foreign_enc');
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

    it('readDevVars with adoptLegacyDevVars: true preserves unmanaged credentials without rotation', async () => {
      const { readDevVars } = await import('../src/secrets.js');
      const legacyDir = path.join(tmpDir, 'legacy-adopt-test');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(
        path.join(legacyDir, '.dev.vars'),
        'JWT_SECRET=legacy_hex_secret_1234567890abcdef\nAPP_KEY=legacy_app_key_123\nENCRYPTION_KEY=legacy_enc_key_123\n',
      );

      // Without flag: throws
      await expect(readDevVars(legacyDir)).rejects.toThrow(/Existing \.dev\.vars found without @edgepay\/init management header/);

      // With flag: returns existing secrets intact without rotation
      const adopted = await readDevVars(legacyDir, { adoptLegacyDevVars: true });
      expect(adopted.jwt_secret).toBe('legacy_hex_secret_1234567890abcdef');
      expect(adopted.app_key).toBe('legacy_app_key_123');
      expect(adopted.encryption_key).toBe('legacy_enc_key_123');
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
        vars: { DEFAULT_CURRENCY: string; APP_NAME: string; APP_DOMAIN: string; APP_URL: string; ALLOWED_ORIGINS: string };
        d1_databases: Array<{ binding: string; database_id: string; database_name: string }>;
        kv_namespaces: Array<{ binding: string; id: string }>;
        r2_buckets: Array<{ binding: string; bucket_name: string }>;
      };

      expect(written.name).toBe('prod-pay');
      expect(written.vars.DEFAULT_CURRENCY).toBe('BDT');
      expect(written.vars.APP_NAME).toBe('My New Store');
      expect(written.vars.APP_DOMAIN).toBe('prod-pay.workers.dev');
      expect(written.vars.APP_URL).toBe('https://prod-pay.workers.dev');
      expect(written.vars.ALLOWED_ORIGINS).toBe('https://prod-pay.workers.dev');
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
    it('parses all flags correctly with distinct preview, dryRun, and adoption semantics', () => {
      expect(parseArgs(['--preview', '--verbose'])).toEqual({
        dryRun: false,
        preview: true,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: true,
        yes: false,
        help: false,
        version: false,
        adoptLegacyDevVars: false,
        adoptExistingResources: false,
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
        adoptLegacyDevVars: false,
        adoptExistingResources: false,
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
        adoptLegacyDevVars: false,
        adoptExistingResources: false,
      });

      expect(parseArgs(['--adopt-legacy-dev-vars'])).toEqual({
        dryRun: false,
        preview: false,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: false,
        yes: false,
        help: false,
        version: false,
        adoptLegacyDevVars: true,
        adoptExistingResources: false,
      });

      expect(parseArgs(['--adopt-existing-resources'])).toEqual({
        dryRun: false,
        preview: false,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: false,
        yes: false,
        help: false,
        version: false,
        adoptLegacyDevVars: false,
        adoptExistingResources: true,
      });

      expect(parseArgs(['--adopt-existing'])).toEqual({
        dryRun: false,
        preview: false,
        destroy: false,
        iKnowWhatImDoing: false,
        verbose: false,
        yes: false,
        help: false,
        version: false,
        adoptLegacyDevVars: false,
        adoptExistingResources: true,
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
        adoptLegacyDevVars: false,
        adoptExistingResources: false,
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
        adoptLegacyDevVars: false,
        adoptExistingResources: false,
      });
    });
  });

  describe('Cloudflare Resource Adoption Protection', () => {
    it('refuses to adopt a foreign D1 database when UUID does not match expectedExistingId', async () => {
      const { ensureD1 } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue([{ name: 'test-db', uuid: 'foreign-d1-uuid' }]);
      await expect(
        ensureD1('test-db', { expectedExistingId: 'my-session-uuid', _executor: mockExec }),
      ).rejects.toThrow(/Refusing to adopt existing Cloudflare resource/);
    });

    it('adopts existing D1 database when UUID matches expectedExistingId', async () => {
      const { ensureD1 } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue([{ name: 'test-db', uuid: 'my-session-uuid' }]);
      const res = await ensureD1('test-db', { expectedExistingId: 'my-session-uuid', _executor: mockExec });
      expect(res).toBe('my-session-uuid');
    });

    it('refuses to adopt a foreign KV namespace when ID does not match expectedExistingId', async () => {
      const { ensureKv } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'foreign-kv-id', title: 'test-kv' }]));
      await expect(
        ensureKv('test-kv', { expectedExistingId: 'my-session-kv-id', _executor: mockExec }),
      ).rejects.toThrow(/Refusing to adopt existing Cloudflare resource/);
    });

    it('adopts existing KV namespace when ID matches expectedExistingId', async () => {
      const { ensureKv } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'my-session-kv-id', title: 'test-kv' }]));
      const res = await ensureKv('test-kv', { expectedExistingId: 'my-session-kv-id', _executor: mockExec });
      expect(res).toBe('my-session-kv-id');
    });

    it('refuses to adopt a foreign R2 bucket when ID does not match expectedExistingId', async () => {
      const { ensureR2 } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue('name: test-bucket\ncreated: 2026-09-01');
      await expect(
        ensureR2('test-bucket', { expectedExistingId: 'other-bucket', _executor: mockExec }),
      ).rejects.toThrow(/Refusing to adopt existing Cloudflare resource/);
    });

    it('adopts existing R2 bucket when name matches expectedExistingId', async () => {
      const { ensureR2 } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue('name: test-bucket\ncreated: 2026-09-01');
      const res = await ensureR2('test-bucket', { expectedExistingId: 'test-bucket', _executor: mockExec });
      expect(res).toBe('test-bucket');
    });

    it('refuses to adopt a foreign Queue when ID does not match expectedExistingId', async () => {
      const { ensureQueue } = await import('../src/wrangler.js');
      const mockTable = `
┌──────────────────────────────────┬─────────────────┬──────────
│ id                               │ name            │ created_on
├──────────────────────────────────┼─────────────────┼──────────
│ queue-uuid-123                   │ test-queue      │ 2026-09-01
└──────────────────────────────────┴─────────────────┴──────────
`;
      const mockExec = vi.fn().mockResolvedValue(mockTable);
      await expect(
        ensureQueue('test-queue', { expectedExistingId: 'other-queue', _executor: mockExec }),
      ).rejects.toThrow(/Refusing to adopt existing Cloudflare resource/);
    });

    it('adopts existing Queue when name matches expectedExistingId', async () => {
      const { ensureQueue } = await import('../src/wrangler.js');
      const mockTable = `
┌──────────────────────────────────┬─────────────────┬──────────
│ id                               │ name            │ created_on
├──────────────────────────────────┼─────────────────┼──────────
│ queue-uuid-123                   │ test-queue      │ 2026-09-01
└──────────────────────────────────┴─────────────────┴──────────
`;
      const mockExec = vi.fn().mockResolvedValue(mockTable);
      const res = await ensureQueue('test-queue', { expectedExistingId: 'test-queue', _executor: mockExec });
      expect(res).toBe('test-queue');
    });

    it('does not falsely match a dead-letter queue as a primary queue in ensureQueue', async () => {
      const { ensureQueue, parseQueueList } = await import('../src/wrangler.js');
      const mockTable = `
┌──────────────────────────────────┬─────────────────┬──────────
│ id                               │ name            │ created_on
├──────────────────────────────────┼─────────────────┼──────────
│ queue-uuid-dlq                   │ webhook-out-dlq │ 2026-09-01
└──────────────────────────────────┴─────────────────┴──────────
`;
      const parsed = parseQueueList(mockTable);
      expect(parsed).toEqual([{ id: 'queue-uuid-dlq', name: 'webhook-out-dlq' }]);
      expect(parsed.find((q) => q.name === 'webhook-out')).toBeUndefined();

      // ensureQueue('webhook-out') must NOT throw "Refusing to adopt" because webhook-out is not in the list!
      const mockExec = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'queues' && args[1] === 'list') return mockTable;
        if (args[0] === 'queues' && args[1] === 'create') return 'Created queue webhook-out';
        return '';
      });
      const res = await ensureQueue('webhook-out', { _executor: mockExec });
      expect(res).toBe('webhook-out');
      expect(mockExec).toHaveBeenCalledWith(['queues', 'create', 'webhook-out'], expect.anything());
    });

    it('refuses to adopt existing D1 database when no expectedExistingId and adoptExisting is false, providing guidance', async () => {
      const { ensureD1 } = await import('../src/wrangler.js');
      const mockExec = vi.fn().mockResolvedValue([{ name: 'test-db', uuid: 'preexisting-d1-uuid' }]);
      await expect(
        ensureD1('test-db', { _executor: mockExec }),
      ).rejects.toThrow(/To adopt pre-existing Cloudflare resources into this deployment, re-run with: --adopt-existing-resources/);
    });

    it('successfully adopts existing resources across D1, KV, R2, and Queues when adoptExisting is true', async () => {
      const { ensureD1, ensureKv, ensureR2, ensureQueue } = await import('../src/wrangler.js');

      // D1
      const d1Exec = vi.fn().mockResolvedValue([{ name: 'my-d1', uuid: 'adopted-d1-uuid' }]);
      expect(await ensureD1('my-d1', { adoptExisting: true, _executor: d1Exec })).toBe('adopted-d1-uuid');

      // KV
      const kvExec = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'adopted-kv-id', title: 'my-kv' }]));
      expect(await ensureKv('my-kv', { adoptExisting: true, _executor: kvExec })).toBe('adopted-kv-id');

      // R2
      const r2Exec = vi.fn().mockResolvedValue('name: my-bucket\ncreated: 2026-09-01');
      expect(await ensureR2('my-bucket', { adoptExisting: true, _executor: r2Exec })).toBe('my-bucket');

      // Queue
      const queueTable = `
┌──────────────────────────────────┬─────────────────┬──────────
│ id                               │ name            │ created_on
├──────────────────────────────────┼─────────────────┼──────────
│ queue-uuid-abc                   │ my-queue        │ 2026-09-01
└──────────────────────────────────┴─────────────────┴──────────
`;
      const queueExec = vi.fn().mockResolvedValue(queueTable);
      expect(await ensureQueue('my-queue', { adoptExisting: true, _executor: queueExec })).toBe('my-queue');
    });

    it('warns when parseQueueList table output contains "name" but 0 queues are parsed', async () => {
      const { parseQueueList } = await import('../src/wrangler.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const badTable = `Some output containing the word name but no pipe delimiters`;
      const parsed = parseQueueList(badTable);
      expect(parsed).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('parseQueueList: Table output contained "name" but parsed 0 queues'));

      warnSpy.mockRestore();
    });
  });

  describe('Cloudflare Error Classification & isNotFound', () => {
    it('accurately identifies live-captured Cloudflare resource-not-found errors', async () => {
      const { isNotFound } = await import('../src/wrangler.js');

      // Live captured D1 errors
      expect(
        isNotFound(
          new Error(
            "✘ [ERROR] Couldn't find a D1 DB with name or binding 'nonexistent-db-xyz-999' in your config or the API. Run 'wrangler d1 create nonexistent-db-xyz-999' to create it.",
          ),
        ),
      ).toBe(true);

      // Live captured KV error
      expect(
        isNotFound(
          new Error(
            '✘ [ERROR] A request to the Cloudflare API (/accounts/123/storage/kv/namespaces/456) failed.\n\n  namespace not found [code: 10013]',
          ),
        ),
      ).toBe(true);

      // Live captured R2 error
      expect(
        isNotFound(
          new Error(
            '✘ [ERROR] A request to the Cloudflare API (/accounts/123/r2/buckets/abc) failed.\n\n  The specified bucket does not exist. [code: 10006]',
          ),
        ),
      ).toBe(true);

      // Live captured Queues error
      expect(
        isNotFound(
          new Error(
            '✘ [ERROR] Queue "nonexistent-queue-xyz-999" does not exist. To create it, run: wrangler queues create nonexistent-queue-xyz-999',
          ),
        ),
      ).toBe(true);

      // Live captured Worker error
      expect(
        isNotFound(
          new Error(
            '✘ [ERROR] A request to the Cloudflare API (/accounts/123/workers/services/nonexistent-worker) failed.\n\n  This Worker does not exist on this account. [code: 10090]',
          ),
        ),
      ).toBe(true);
    });

    it('refuses to treat authentication, authorization, or user errors as not-found', async () => {
      const { isNotFound } = await import('../src/wrangler.js');

      expect(isNotFound(new Error('Authentication error [code: 10000]'))).toBe(false);
      expect(isNotFound(new Error('Permission denied [code: 10007]'))).toBe(false);
      expect(isNotFound(new Error('Unauthorized access'))).toBe(false);
      expect(isNotFound(new Error('Forbidden: insufficient permissions'))).toBe(false);
      expect(isNotFound(new Error('User not found [code: 10008]'))).toBe(false);
      expect(isNotFound(new Error('Account not found with ID 12345 [code: 10002]'))).toBe(false);
    });
  });

  describe('Queue Scoping & Teardown Ordering', () => {
    it('scopes queue names for deployments to prevent account collisions', async () => {
      const { getDeploymentQueueNames } = await import('../src/provision.js');

      const defaultQueues = getDeploymentQueueNames('edgepay-cf');
      expect(defaultQueues.webhookOut).toBe('edgepay-cf-webhook-out');
      expect(defaultQueues.webhookOutDlq).toBe('edgepay-cf-webhook-out-dlq');

      const scopedQueues = getDeploymentQueueNames('my-shop');
      expect(scopedQueues.webhookOut).toBe('my-shop-webhook-out');
      expect(scopedQueues.webhookOutDlq).toBe('my-shop-webhook-out-dlq');
      expect(scopedQueues.emailOut).toBe('my-shop-email-out');
      expect(scopedQueues.emailOutDlq).toBe('my-shop-email-out-dlq');
      expect(scopedQueues.smsParse).toBe('my-shop-sms-parse');
      expect(scopedQueues.smsParseDlq).toBe('my-shop-sms-parse-dlq');

      // and the teardown order preserves primary-before-dlq
      expect(scopedQueues.allInTeardownOrder.indexOf('my-shop-webhook-out'))
        .toBeLessThan(scopedQueues.allInTeardownOrder.indexOf('my-shop-webhook-out-dlq'));
      expect(scopedQueues.allInTeardownOrder.indexOf('my-shop-email-out'))
        .toBeLessThan(scopedQueues.allInTeardownOrder.indexOf('my-shop-email-out-dlq'));
      expect(scopedQueues.allInTeardownOrder.indexOf('my-shop-sms-parse'))
        .toBeLessThan(scopedQueues.allInTeardownOrder.indexOf('my-shop-sms-parse-dlq'));
    });

    it('orders primary queues before dead-letter queues in teardown order', async () => {
      const { getDeploymentQueueNames } = await import('../src/provision.js');
      const plan = getDeploymentQueueNames('edgepay-cf');

      const teardownOrder = plan.allInTeardownOrder;
      expect(teardownOrder.indexOf('edgepay-cf-webhook-out')).toBeLessThan(teardownOrder.indexOf('edgepay-cf-webhook-out-dlq'));
      expect(teardownOrder.indexOf('edgepay-cf-email-out')).toBeLessThan(teardownOrder.indexOf('edgepay-cf-email-out-dlq'));
      expect(teardownOrder.indexOf('edgepay-cf-sms-parse')).toBeLessThan(teardownOrder.indexOf('edgepay-cf-sms-parse-dlq'));
    });

    it('detects legacy queue bindings only when deployment name matches existing config', async () => {
      const { detectLegacyQueueBindings, getDeploymentQueueNames } = await import('../src/provision.js');

      const legacyConfig = `
{
  "name": "my-legacy-deployment",
  "queues": {
    "producers": [
      { "binding": "WEBHOOK_QUEUE", "queue": "webhook-out" },
      { "binding": "EMAIL_QUEUE", "queue": "email-out" }
    ]
  }
}
`;
      // Matching deployment name returns true
      expect(detectLegacyQueueBindings(legacyConfig, 'my-legacy-deployment')).toBe(true);

      // Non-matching deployment name (e.g. fresh clone) returns false
      expect(detectLegacyQueueBindings(legacyConfig, 'edgepay-fresh')).toBe(false);

      const scopedConfig = `
{
  "name": "my-new-deployment",
  "queues": {
    "producers": [
      { "binding": "WEBHOOK_QUEUE", "queue": "my-new-deployment-webhook-out" }
    ]
  }
}
`;
      expect(detectLegacyQueueBindings(scopedConfig, 'my-new-deployment')).toBe(false);

      // When existingWranglerContent has legacy bindings for the same deployment name, unscoped queues are preserved
      const queues = getDeploymentQueueNames('my-legacy-deployment', {
        existingWranglerContent: legacyConfig,
      });
      expect(queues.webhookOut).toBe('webhook-out');
      expect(queues.webhookOutDlq).toBe('webhook-out-dlq');

      // For a fresh/different deployment name, queues are scoped even if template had legacy queues
      const freshQueues = getDeploymentQueueNames('edgepay-fresh', {
        existingWranglerContent: legacyConfig,
      });
      expect(freshQueues.webhookOut).toBe('edgepay-fresh-webhook-out');
      expect(freshQueues.webhookOutDlq).toBe('edgepay-fresh-webhook-out-dlq');
    });
  });

  describe('Teardown Safety Gates & Process Isolation', () => {
    it('refuses non-interactive destroy without EDGEPAY_DESTROY_CONFIRMED=yes', async () => {
      const { runInstaller } = await import('../src/index.js');
      const testStateFile = path.join(tmpDir, '.edgepay-init.json');
      await saveState(
        {
          version: 1,
          started_at: 'now',
          config: {
            deployment_name: 'test-dep',
            account_id: '12345',
            account_name: 'Test Acc',
            primary_currency: 'BDT',
            merchant_name: 'Test',
            generate_secrets: false,
            d1_name: 'test-dep-db',
            kv_name: 'test-dep-kv',
            r2_name: 'test-dep-r2',
          },
        },
        testStateFile,
      );

      const origEnv = process.env.EDGEPAY_DESTROY_CONFIRMED;
      delete process.env.EDGEPAY_DESTROY_CONFIRMED;

      process.exitCode = 0;
      await runInstaller([
        '--destroy',
        '--i-know-what-im-doing',
        '--yes',
        `--statePath=${testStateFile}`,
        `--projectRoot=${tmpDir}`,
      ]);

      expect(process.exitCode).toBe(1);
      process.exitCode = 0;

      if (origEnv !== undefined) {
        process.env.EDGEPAY_DESTROY_CONFIRMED = origEnv;
      }
    });

    it('refuses destroy when EDGEPAY_SCRATCH_ACCOUNTS allowlist is configured and account does not match', async () => {
      const { runInstaller } = await import('../src/index.js');
      const testStateFile = path.join(tmpDir, '.edgepay-init.json');
      await saveState(
        {
          version: 1,
          started_at: 'now',
          config: {
            deployment_name: 'test-dep',
            account_id: 'prod-account-999',
            account_name: 'Prod Acc',
            primary_currency: 'BDT',
            merchant_name: 'Test',
            generate_secrets: false,
            d1_name: 'test-dep-db',
            kv_name: 'test-dep-kv',
            r2_name: 'test-dep-r2',
          },
        },
        testStateFile,
      );

      process.env.EDGEPAY_SCRATCH_ACCOUNTS = 'allowed-scratch-account-1,allowed-scratch-account-2';
      process.env.EDGEPAY_DESTROY_CONFIRMED = 'yes';

      process.exitCode = 0;
      await runInstaller([
        '--destroy',
        '--i-know-what-im-doing',
        '--yes',
        `--statePath=${testStateFile}`,
        `--projectRoot=${tmpDir}`,
      ]);

      expect(process.exitCode).toBe(1);
      process.exitCode = 0;

      delete process.env.EDGEPAY_SCRATCH_ACCOUNTS;
      delete process.env.EDGEPAY_DESTROY_CONFIRMED;
    });

    it('executes destroyAll in correct dependency order: detach consumers, delete worker, delete queues, delete D1 by UUID, delete KV, delete R2', async () => {
      const { destroyAll } = await import('../src/provision.js');
      const callLog: string[] = [];
      const executedCommands: Array<{ args: string[]; opts?: any }> = [];
      const mockExecutor = async (args: string[], opts?: any) => {
        executedCommands.push({ args, opts });
        return '';
      };

      const config = {
        deployment_name: 'test-dep',
        account_id: '12345',
        account_name: 'Test Acc',
        primary_currency: 'BDT',
        merchant_name: 'Test Store',
        generate_secrets: false,
        d1_name: 'test-dep-db',
        kv_name: 'test-dep-kv',
        r2_name: 'test-dep-assets',
      };

      const resources = {
        d1_id: 'd1-uuid-999',
        d1_name: 'test-dep-db',
        kv_id: '0123456789abcdef0123456789abcdef',
        kv_name: 'test-dep-kv',
        r2_name: 'test-dep-assets',
        queues: ['test-dep-webhook-out', 'test-dep-webhook-out-dlq'],
      };

      await destroyAll(config, resources, {
        onProgress: (step, resourceName) => {
          callLog.push(`${step}:${resourceName}`);
        },
        _executor: mockExecutor,
      });

      // Detach queue consumer must come first (for primary queues only)
      expect(callLog[0]).toBe('detach-queue-consumer:test-dep-webhook-out');

      // Worker delete must happen before queue deletion
      expect(callLog[1]).toBe('delete-worker:test-dep');

      // Primary queues must be deleted before DLQs
      expect(callLog[2]).toBe('delete-queue:test-dep-webhook-out');
      expect(callLog[3]).toBe('delete-queue:test-dep-webhook-out-dlq');

      // D1 must be deleted with UUID
      expect(callLog[4]).toBe('delete-d1:d1-uuid-999');

      // KV and R2
      expect(callLog[5]).toBe('delete-kv:0123456789abcdef0123456789abcdef');
      expect(callLog[6]).toBe('delete-r2:test-dep-assets');

      // Verify commands executed
      expect(executedCommands[0].args).toEqual(['queues', 'consumer', 'remove', 'test-dep-webhook-out', 'test-dep']);
      expect(executedCommands[1].args).toEqual(['delete', 'test-dep', '--force']);
      expect(executedCommands[2].args).toEqual(['queues', 'delete', 'test-dep-webhook-out']);
      expect(executedCommands[3].args).toEqual(['queues', 'delete', 'test-dep-webhook-out-dlq']);
      expect(executedCommands[4].args).toEqual(['d1', 'delete', 'd1-uuid-999', '--skip-confirmation']);
      expect(executedCommands[5].args).toEqual(['kv', 'namespace', 'delete', '--namespace-id', '0123456789abcdef0123456789abcdef']);
      expect(executedCommands[6].args).toEqual(['r2', 'bucket', 'delete', 'test-dep-assets']);
    });
  });

  describe('Safety & Isolation Regression: Account Resource Collision Guard', () => {
    it('strictly isolates synthetic deployment queues and prevents default production queue collision', async () => {
      const { getDeploymentQueueNames } = await import('../src/provision.js');
      const scratchDeploymentName = 'scratch-isolation-test-123';
      const scopedQueues = getDeploymentQueueNames(scratchDeploymentName);
      const defaultQueues = getDeploymentQueueNames('edgepay-cf');

      expect(scopedQueues.webhookOut).not.toBe(defaultQueues.webhookOut);
      expect(scopedQueues.webhookOut).toBe('scratch-isolation-test-123-webhook-out');

      for (const queueName of scopedQueues.allInTeardownOrder) {
        expect(queueName).toContain(scratchDeploymentName);
        expect(defaultQueues.allInTeardownOrder).not.toContain(queueName);
      }
    });

    it('recovers cleanly when state file was deleted, reusing .dev.vars secrets and adopting resources', async () => {
      const { syncDevVars, readDevVars, generateSecrets } = await import('../src/secrets.js');
      const { provisionAll } = await import('../src/provision.js');

      // 1. Existing .dev.vars with managed header
      const secrets = generateSecrets();
      await syncDevVars(secrets, tmpDir);

      // Reading .dev.vars must find the existing secrets
      const loadedSecrets = await readDevVars(tmpDir);
      expect(loadedSecrets.jwt_secret).toBe(secrets.jwt_secret);

      // 2. Provisioning with adoptExisting: true reuses pre-existing resources without throwing
      const mockExec = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'd1' && args[1] === 'list') return [{ name: 'rec-db', uuid: 'rec-d1-uuid' }];
        if (args[0] === 'kv' && args[1] === 'namespace' && args[2] === 'list')
          return JSON.stringify([{ id: 'rec-kv-id', title: 'rec-kv' }]);
        if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'list')
          return 'name: rec-r2\n';
        if (args[0] === 'queues' && args[1] === 'list')
          return `
┌──────────────────────────────────┬──────────────────────┬──────────
│ id                               │ name                 │ created_on
├──────────────────────────────────┼──────────────────────┼──────────
│ q1                               │ rec-webhook-out      │ 2026-09-01
│ q2                               │ rec-webhook-out-dlq  │ 2026-09-01
│ q3                               │ rec-email-out        │ 2026-09-01
│ q4                               │ rec-email-out-dlq    │ 2026-09-01
│ q5                               │ rec-sms-parse        │ 2026-09-01
│ q6                               │ rec-sms-parse-dlq    │ 2026-09-01
└──────────────────────────────────┴──────────────────────┴──────────
`;
        return '';
      });

      const config = {
        deployment_name: 'rec',
        account_id: 'acc123',
        account_name: 'Recovery Acc',
        primary_currency: 'BDT',
        merchant_name: 'Recovery Store',
        generate_secrets: false,
        d1_name: 'rec-db',
        kv_name: 'rec-kv',
        r2_name: 'rec-r2',
      };

      // In ensureD1/etc., _executor can be passed via provisionAll or ensure*
      const { ensureD1 } = await import('../src/wrangler.js');
      const adoptedD1 = await ensureD1('rec-db', { adoptExisting: true, _executor: mockExec });
      expect(adoptedD1).toBe('rec-d1-uuid');
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
