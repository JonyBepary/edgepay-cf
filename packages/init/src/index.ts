import fs from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { checkPrereqs } from './prereqs.js';
import { ensureAuth } from './auth.js';
import { gatherConfig } from './prompts.js';
import { provisionAll, destroyAll } from './provision.js';
import { renderWranglerConfig } from './render-config.js';
import { applyMigrations } from './migrate.js';
import { pushAllSecrets } from './secrets.js';
import { deploy } from './deploy.js';
import { verify } from './verify.js';
import { whoami } from './wrangler.js';
import { loadState, saveState, clearState, type InitState } from './state.js';
import { renderIntro } from './ui/intro.js';
import { stepHeader, stepSuccess } from './ui/steps.js';
import { renderSuccessSummary, renderPreviewSummary, renderDryRunSummary, renderDestroySummary } from './ui/summary.js';

export interface CliFlags {
  preview: boolean;
  dryRun: boolean;
  destroy: boolean;
  iKnowWhatImDoing: boolean;
  verbose: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  adoptLegacyDevVars: boolean;
  adoptExistingResources: boolean;
  deploymentName?: string;
  primaryCurrency?: string;
  merchantName?: string;
  projectRoot?: string;
  statePath?: string;
}

export function parseArgs(args: string[]): CliFlags {
  const findArgValue = (prefix: string): string | undefined => {
    const arg = args.find((a) => a.startsWith(`${prefix}=`));
    return arg ? arg.slice(prefix.length + 1) : undefined;
  };

  return {
    preview: args.includes('--preview'),
    dryRun: args.includes('--dry-run'),
    destroy: args.includes('--destroy'),
    iKnowWhatImDoing: args.includes('--i-know-what-im-doing') || args.includes('--force'),
    verbose: args.includes('--verbose'),
    yes: args.includes('--yes') || args.includes('-y'),
    help: args.includes('--help') || args.includes('-h'),
    version: args.includes('--version') || args.includes('-v'),
    adoptLegacyDevVars: args.includes('--adopt-legacy-dev-vars'),
    adoptExistingResources:
      args.includes('--adopt-existing-resources') || args.includes('--adopt-existing'),
    deploymentName: findArgValue('--name') ?? findArgValue('--deployment-name'),
    primaryCurrency: findArgValue('--currency'),
    merchantName: findArgValue('--merchant') ?? findArgValue('--merchant-name'),
    projectRoot: findArgValue('--projectRoot') ?? findArgValue('--project-root'),
    statePath: findArgValue('--statePath') ?? findArgValue('--state-path'),
  };
}

export async function runInstaller(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseArgs(rawArgs);

  if (flags.version) {
    console.log('0.5.0');
    return;
  }

  if (flags.help) {
    console.log(`
EdgePay Self-Hosted Installer

USAGE:
  npx @edgepay/init [OPTIONS]

OPTIONS:
  --preview                   Inspect configuration and verify auth without modifying Cloudflare
  --dry-run                   Provision Cloudflare resources and configure project without deploying Worker
  --destroy                   Tear down all provisioned resources for this deployment
  --i-know-what-im-doing      (CI only) Bypass interactive confirmation for --destroy (requires EDGEPAY_DESTROY_CONFIRMED=yes)
  --adopt-legacy-dev-vars     Adopt existing unmanaged .dev.vars without regenerating/rotating secrets
  --adopt-existing-resources  Adopt pre-existing Cloudflare D1, KV, R2, and Queue resources by name
  --verbose                   Show detailed Wrangler command output
  --yes, -y                   Non-interactive mode (use defaults and auto-confirm)
  --help, -h                  Show this help message
  --version, -v               Show installer version
`);
    return;
  }

  // Non-TTY guard: refuse to hang if running in automated CI without --yes
  if (!process.stdin.isTTY && !flags.yes) {
    console.error(pc.red('Error: Interactive prompt cannot run in a non-interactive (non-TTY) environment.'));
    console.error(pc.yellow('Run with --yes (or -y) to proceed using defaults, or provide an interactive terminal.'));
    process.exitCode = 1;
    return;
  }

  renderIntro('0.5.0');

  const projectRoot = flags.projectRoot ?? process.cwd();
  const statePath = flags.statePath ?? path.join(projectRoot, '.edgepay-init.json');
  const state: InitState = await loadState(statePath);

  const persistState = async () => {
    if (flags.preview) return; // Strictly in-memory during preview: zero disk mutations
    await saveState(state, statePath);
  };

  // -------------------------------------------------------------
  // Teardown flow (--destroy)
  // -------------------------------------------------------------
  if (flags.destroy) {
    if (!state.config) {
      try {
        const wranglerPath = path.join(projectRoot, 'wrangler.jsonc');
        const rawWrangler = await fs.readFile(wranglerPath, 'utf-8');
        const parsed = JSON.parse(
          rawWrangler.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1'),
        ) as any;
        if (parsed?.name) {
          const auth = await whoami();
          const targetAccount = auth?.accounts?.[0];
          if (targetAccount?.id) {
            state.config = {
              deployment_name: parsed.name,
              account_id: targetAccount.id,
              account_name: targetAccount.name || targetAccount.id,
              primary_currency: parsed.vars?.DEFAULT_CURRENCY || 'BDT',
              merchant_name: parsed.vars?.APP_NAME || parsed.name,
              generate_secrets: false,
              d1_name: parsed.d1_databases?.[0]?.database_name || `${parsed.name}-db`,
              kv_name: parsed.kv_namespaces?.[0]?.binding || `${parsed.name}-kv`,
              r2_name: parsed.r2_buckets?.[0]?.bucket_name || `${parsed.name}-assets`,
            };
            const extractedQueues: string[] = [];
            if (Array.isArray(parsed.queues?.producers)) {
              for (const p of parsed.queues.producers) {
                if (p.queue && !extractedQueues.includes(p.queue)) {
                  extractedQueues.push(p.queue);
                }
              }
            }
            if (Array.isArray(parsed.queues?.consumers)) {
              for (const c of parsed.queues.consumers) {
                if (c.queue && !extractedQueues.includes(c.queue)) {
                  extractedQueues.push(c.queue);
                }
                if (c.dead_letter_queue && !extractedQueues.includes(c.dead_letter_queue)) {
                  extractedQueues.push(c.dead_letter_queue);
                }
              }
            }
            state.resources = {
              d1_id: parsed.d1_databases?.[0]?.database_id,
              d1_name: parsed.d1_databases?.[0]?.database_name,
              kv_id: parsed.kv_namespaces?.[0]?.id,
              kv_name: parsed.kv_namespaces?.[0]?.binding,
              r2_name: parsed.r2_buckets?.[0]?.bucket_name,
              queues: extractedQueues.length > 0 ? extractedQueues : undefined,
            };
          }
        }
      } catch {
        // failed to recover from wrangler.jsonc
      }
    }

    if (!state.config) {
      p.log.error('No configuration found in .edgepay-init.json or wrangler.jsonc to destroy.');
      process.exitCode = 1;
      return;
    }

    const depName = state.config.deployment_name;

    // Safety allowlist check (EDGEPAY_SCRATCH_ACCOUNTS)
    if (process.env.EDGEPAY_SCRATCH_ACCOUNTS) {
      const allowedAccounts = process.env.EDGEPAY_SCRATCH_ACCOUNTS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!allowedAccounts.includes(state.config.account_id)) {
        console.error(pc.red(`Error: Refusing to destroy resources on account ${state.config.account_id}.`));
        console.error(
          pc.yellow(
            `Account is not in the EDGEPAY_SCRATCH_ACCOUNTS allowlist (${allowedAccounts.join(', ')}). Add it to EDGEPAY_SCRATCH_ACCOUNTS if this is intentional.`,
          ),
        );
        process.exitCode = 1;
        return;
      }
    }

    if (!flags.iKnowWhatImDoing) {
      if (flags.yes || !process.stdin.isTTY) {
        console.error(
          pc.red(
            `Error: Refusing to destroy resources in non-interactive mode without both --i-know-what-im-doing flag AND environment variable EDGEPAY_DESTROY_CONFIRMED=yes.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      const typedConfirmation = await p.text({
        message: `DANGER: Permanent deletion of D1 database (${state.resources?.d1_name ?? depName}), KV, R2 bucket, and queues.\nType "${depName}" to confirm deletion:`,
        validate(val) {
          if (val !== depName) {
            return `You must type "${depName}" exactly to confirm deletion.`;
          }
        },
      });

      if (p.isCancel(typedConfirmation) || typedConfirmation !== depName) {
        p.cancel('Teardown cancelled. No resources were deleted.');
        return;
      }
    } else {
      // Non-interactive confirmation requires independent environment signal: EDGEPAY_DESTROY_CONFIRMED=yes
      if (flags.yes || !process.stdin.isTTY) {
        if (process.env.EDGEPAY_DESTROY_CONFIRMED !== 'yes') {
          console.error(pc.red('Error: Refusing to destroy resources in non-interactive mode.'));
          console.error(
            pc.yellow(
              'Automated/CI destroy requires both --i-know-what-im-doing flag AND environment variable EDGEPAY_DESTROY_CONFIRMED=yes to prevent accidental deletion.',
            ),
          );
          process.exitCode = 1;
          return;
        }
      }
    }

    const s = p.spinner();
    s.start(`Tearing down Cloudflare resources for ${depName}...`);
    const destroyResult = await destroyAll(state.config, state.resources, (step, name) => {
      s.message(`Deleting ${step}: ${name}...`);
    });
    s.stop('Cloudflare resources teardown finished');

    if (destroyResult.errors.length > 0) {
      p.log.warn('Some resources could not be automatically deleted:');
      for (const err of destroyResult.errors) {
        p.log.warn(`  - ${err.resource}: ${err.error.split('\n')[0]}`);
      }
      process.exitCode = 1;
    }

    await clearState(statePath);
    renderDestroySummary(depName);
    return;
  }

  // -------------------------------------------------------------
  // Step 1: Checking Prerequisites
  // -------------------------------------------------------------
  stepHeader(1, 'Checking prerequisites...');
  if (!state.prereqs_done) {
    const s = p.spinner();
    s.start('Verifying Node.js, wrangler CLI, and git...');
    const prereqs = await checkPrereqs();
    s.stop('Prerequisites verified');
    stepSuccess('Node.js', prereqs.nodeVersion);
    stepSuccess('wrangler CLI', prereqs.wranglerVersion);
    stepSuccess('git', prereqs.gitVersion);
    state.prereqs_done = true;
    await persistState();
  } else {
    stepSuccess('Prerequisites already verified');
  }

  // -------------------------------------------------------------
  // Step 2: Authenticating with Cloudflare
  // -------------------------------------------------------------
  stepHeader(2, 'Authenticating with Cloudflare...');
  let account = state.config
    ? { id: state.config.account_id, name: state.config.account_name }
    : undefined;

  if (!state.auth_done || !account) {
    const authResult = await ensureAuth({
      nonInteractive: flags.yes,
    });
    account = authResult.account;
    stepSuccess('Signed in as', authResult.email);
    stepSuccess('Account', `${account.name} (${account.id.slice(0, 8)}...)`);
    state.auth_done = true;
    await persistState();
  } else {
    stepSuccess('Authenticated with account', `${account.name} (${account.id.slice(0, 8)}...)`);
  }

  // -------------------------------------------------------------
  // Step 3: Gathering Configuration
  // -------------------------------------------------------------
  stepHeader(3, 'Gathering configuration...');
  if (!state.config) {
    state.config = await gatherConfig(account, {
      nonInteractive: flags.yes,
      defaults: {
        deployment_name: flags.deploymentName,
        primary_currency: flags.primaryCurrency,
        merchant_name: flags.merchantName,
      },
    });
    await persistState();
    stepSuccess('Deployment name', state.config.deployment_name);
    stepSuccess('Primary currency', state.config.primary_currency);
    stepSuccess('Merchant name', state.config.merchant_name);
  } else {
    stepSuccess('Using saved configuration', state.config.deployment_name);
  }

  // If in preview mode, display configuration preview without mutating Cloudflare resources
  if (flags.preview) {
    renderPreviewSummary({
      url: `https://${state.config.deployment_name}.workers.dev`,
      deploymentName: state.config.deployment_name,
      currency: state.config.primary_currency,
      accountName: state.config.account_name,
      d1Name: state.config.d1_name,
      kvName: state.config.kv_name,
      r2Name: state.config.r2_name,
    });
    // Preview is strictly read-only: do NOT clear existing state
    return;
  }

  // -------------------------------------------------------------
  // Step 4: Provisioning Cloudflare Resources
  // -------------------------------------------------------------
  stepHeader(4, 'Provisioning Cloudflare resources...');
  if (!state.provisioned || !state.resources) {
    const s = p.spinner();
    s.start('Creating D1 database, KV namespace, R2 bucket, and Queues...');
    state.resources = await provisionAll(state.config, state.resources, {
      projectRoot,
      adoptExisting: flags.adoptExistingResources,
      onProgress(step, name) {
        s.message(`Provisioning ${step}: ${name}...`);
      },
    });
    s.stop('Cloudflare resources provisioned');
    state.provisioned = true;
    await persistState();

    stepSuccess('D1 database', `${state.resources.d1_name} (${state.resources.d1_id?.slice(0, 8)}...)`);
    stepSuccess('KV namespace', `${state.resources.kv_name} (${state.resources.kv_id?.slice(0, 8)}...)`);
    stepSuccess('R2 bucket', state.resources.r2_name);
    stepSuccess('Queues & DLQs', `${state.resources.queues?.length ?? 0} queues active`);
  } else {
    stepSuccess('Resources already provisioned');
  }

  // -------------------------------------------------------------
  // Step 5: Rendering Configuration
  // -------------------------------------------------------------
  stepHeader(5, 'Configuring deployment...');
  if (!state.config_rendered) {
    const s = p.spinner();
    s.start('Writing wrangler.jsonc...');
    await renderWranglerConfig(state.config, state.resources, { projectRoot });
    s.stop('wrangler.jsonc written');
    state.config_rendered = true;
    await persistState();
  } else {
    stepSuccess('Configuration already written');
  }

  // -------------------------------------------------------------
  // Step 6: Applying Database Migrations
  // -------------------------------------------------------------
  stepHeader(6, 'Applying database migrations...');
  if (!state.migrations_applied) {
    const s = p.spinner();
    s.start('Applying D1 schema migrations remotely...');
    await applyMigrations('DB', {
      accountId: state.config.account_id,
      cwd: projectRoot,
    });
    s.stop('All 11 migrations applied');
    state.migrations_applied = true;
    await persistState();
  } else {
    stepSuccess('Migrations already applied');
  }

  // -------------------------------------------------------------
  // Step 7: Setting Cryptographic Secrets
  // -------------------------------------------------------------
  stepHeader(7, 'Setting secrets...');
  if (!state.secrets_pushed) {
    const s = p.spinner();
    s.start('Pushing JWT_SECRET, APP_KEY, and ENCRYPTION_KEY...');
    await pushAllSecrets(state.config, {
      accountId: state.config.account_id,
      projectRoot,
      adoptLegacyDevVars: flags.adoptLegacyDevVars,
    });
    s.stop('Secrets safely configured');
    state.secrets_pushed = true;
    await persistState();
  } else {
    stepSuccess('Secrets already configured');
  }

  // If in dry-run mode, stop here (resources provisioned, Worker not deployed)
  if (flags.dryRun) {
    renderDryRunSummary({
      url: `https://${state.config.deployment_name}.workers.dev`,
      deploymentName: state.config.deployment_name,
      currency: state.config.primary_currency,
      accountName: state.config.account_name,
    });
    return;
  }

  // -------------------------------------------------------------
  // Step 8: Deploying Worker
  // -------------------------------------------------------------
  stepHeader(8, 'Deploying worker...');
  if (!state.deployed || !state.deployment_url) {
    const s = p.spinner();
    s.start('Deploying to Cloudflare Workers...');
    const url = await deploy(state.config, {
      accountId: state.config.account_id,
      cwd: projectRoot,
    });
    s.stop('Published to Cloudflare network');
    state.deployed = true;
    state.deployment_url = url;
    await renderWranglerConfig(state.config, state.resources!, {
      projectRoot,
      deploymentUrl: url,
    });
    await persistState();
    stepSuccess('Deployed Worker', url);
  } else {
    stepSuccess('Already deployed at', state.deployment_url);
  }

  // -------------------------------------------------------------
  // Step 9: Verifying Deployment
  // -------------------------------------------------------------
  stepHeader(9, 'Verifying deployment...');
  if (!state.verified) {
    const s = p.spinner();
    s.start(`Running health check against ${state.deployment_url}...`);
    await verify(state.deployment_url);
    s.stop('Health check passed');
    state.verified = true;
    await persistState();
  } else {
    stepSuccess('Deployment already verified');
  }

  // -------------------------------------------------------------
  // Installation Complete
  // -------------------------------------------------------------
  renderSuccessSummary({
    url: state.deployment_url!,
    deploymentName: state.config.deployment_name,
    currency: state.config.primary_currency,
    accountName: state.config.account_name,
  });

  // Success: clear state file so future runs are clean
  await clearState(statePath);
}
