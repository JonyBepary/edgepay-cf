import * as p from '@clack/prompts';
import { whoami, login, type WhoamiAccount, type WhoamiResult } from './wrangler.js';

export interface EnsureAuthOptions {
  nonInteractive?: boolean;
  preferredAccountId?: string;
}

export async function ensureAuth(opts: EnsureAuthOptions = {}): Promise<{
  email: string;
  account: WhoamiAccount;
}> {
  let info: WhoamiResult | null = await whoami();

  if (!info || !info.loggedIn || !info.accounts || info.accounts.length === 0) {
    if (opts.nonInteractive) {
      throw new Error('Not authenticated with Cloudflare. Run `wrangler login` or provide CLOUDFLARE_API_TOKEN.');
    }

    p.log.warn('Not signed in to Cloudflare.');
    const shouldLogin = await p.confirm({
      message: 'Open browser to authenticate with Cloudflare?',
      initialValue: true,
    });

    if (p.isCancel(shouldLogin) || !shouldLogin) {
      p.cancel('Cloudflare authentication is required to continue.');
      process.exit(1);
    }

    const s = p.spinner();
    s.start('Waiting for browser authentication...');
    await login();
    s.stop('Authentication completed');

    info = await whoami();
    if (!info || !info.loggedIn || !info.accounts || info.accounts.length === 0) {
      throw new Error('Cloudflare login did not complete successfully. Please run `wrangler login` manually.');
    }
  }

  const accounts = info.accounts;
  let selectedAccount: WhoamiAccount;

  if (opts.preferredAccountId) {
    const found = accounts.find((a) => a.id === opts.preferredAccountId);
    if (found) {
      selectedAccount = found;
    } else {
      selectedAccount = accounts[0];
    }
  } else if (accounts.length === 1 || opts.nonInteractive) {
    selectedAccount = accounts[0];
  } else {
    const choice = await p.select({
      message: 'Select Cloudflare account to deploy to:',
      options: accounts.map((a) => ({
        value: a.id,
        label: `${a.name} (${a.id.slice(0, 8)}...)`,
      })),
    });

    if (p.isCancel(choice)) {
      p.cancel('Account selection cancelled.');
      process.exit(1);
    }

    selectedAccount = accounts.find((a) => a.id === choice) || accounts[0];
  }

  return {
    email: info.email || 'Cloudflare User',
    account: selectedAccount,
  };
}
