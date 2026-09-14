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
  projectRoot?: string;
  statePath?: string;
}

export function parseArgs(args: string[]): CliFlags {
  return {
    preview: args.includes('--preview'),
    dryRun: args.includes('--dry-run'),
    destroy: args.includes('--destroy'),
    iKnowWhatImDoing: args.includes('--i-know-what-im-doing') || args.includes('--force'),
    verbose: args.includes('--verbose'),
    yes: args.includes('--yes') || args.includes('-y'),
    help: args.includes('--help') || args.includes('-h'),
    version: args.includes('--version') || args.includes('-v'),
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
  --preview               Inspect configuration and verify auth without modifying Cloudflare
  --dry-run               Provision Cloudflare resources and configure project without deploying Worker
  --destroy               Tear down all provisioned resources for this deployment
  --i-know-what-im-doing  Confirm destruction without interactive typing prompt
  --verbose               Show detailed Wrangler command output
  --yes, -y               Non-interactive mode (use defaults and auto-confirm)
  --help, -h              Show this help message
  --version, -v           Show installer version
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

  // -------------------------------------------------------------
  // Teardown flow (--destroy)
  // -------------------------------------------------------------
  if (flags.destroy) {
    if (!state.config) {
      p.log.error('No configuration found in .edgepay-init.json to destroy.');
      process.exitCode = 1;
      return;
    }

    const depName = state.config.deployment_name;

    if (!flags.iKnowWhatImDoing) {
      if (flags.yes || !process.stdin.isTTY) {
        console.error(pc.red(`Error: Refusing to destroy resources in non-interactive mode without --i-know-what-im-doing flag.`));
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
    await saveState(state, statePath);
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
    await saveState(state, statePath);
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
    });
    await saveState(state, statePath);
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
    state.resources = await provisionAll(state.config, state.resources, (step, name) => {
      s.message(`Provisioning ${step}: ${name}...`);
    });
    s.stop('Cloudflare resources provisioned');
    state.provisioned = true;
    await saveState(state, statePath);

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
    await saveState(state, statePath);
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
    await saveState(state, statePath);
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
    });
    s.stop('Secrets safely configured');
    state.secrets_pushed = true;
    await saveState(state, statePath);
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
    await saveState(state, statePath);
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
    await saveState(state, statePath);
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
