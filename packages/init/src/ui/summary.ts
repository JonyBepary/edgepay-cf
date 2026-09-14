import pc from 'picocolors';

export interface SummaryData {
  url: string;
  deploymentName: string;
  currency: string;
  accountName: string;
}

export function renderSuccessSummary(data: SummaryData): void {
  const line1 = '✅ Installation complete';
  const line2 = `URL: ${data.url}`;
  const line3 = 'Next step: open the URL to create your';
  const line4 = 'admin account and begin accepting payments.';

  console.log('\n' + pc.green('  ┌──────────────────────────────────────────┐'));
  console.log(pc.green('  │  ') + pc.bold(pc.white(line1.padEnd(40))) + pc.green('│'));
  console.log(pc.green('  │                                          │'));
  console.log(pc.green('  │  ') + pc.cyan(line2.padEnd(40)) + pc.green('│'));
  console.log(pc.green('  │                                          │'));
  console.log(pc.green('  │  ') + pc.white(line3.padEnd(40)) + pc.green('│'));
  console.log(pc.green('  │  ') + pc.white(line4.padEnd(40)) + pc.green('│'));
  console.log(pc.green('  └──────────────────────────────────────────┘\n'));
}

export function renderDryRunSummary(data: SummaryData): void {
  console.log('\n' + pc.yellow('  ┌──────────────────────────────────────────┐'));
  console.log(pc.yellow('  │  ') + pc.bold(pc.white('[DRY-RUN] Resources Provisioned'.padEnd(40))) + pc.yellow('│'));
  console.log(pc.yellow('  │                                          │'));
  console.log(pc.yellow('  │  ') + pc.white(`Deployment: ${data.deploymentName}`.padEnd(40)) + pc.yellow('│'));
  console.log(pc.yellow('  │  ') + pc.white(`Account:    ${data.accountName}`.padEnd(40)) + pc.yellow('│'));
  console.log(pc.yellow('  │                                          │'));
  console.log(pc.yellow('  │  ') + pc.dim('Worker was NOT deployed (--dry-run).'.padEnd(40)) + pc.yellow('│'));
  console.log(pc.yellow('  └──────────────────────────────────────────┘\n'));
}

export function renderDestroySummary(deploymentName: string): void {
  console.log('\n' + pc.red('  ┌──────────────────────────────────────────┐'));
  console.log(pc.red('  │  ') + pc.bold(pc.white('🗑️  Teardown Complete'.padEnd(40))) + pc.red('│'));
  console.log(pc.red('  │                                          │'));
  console.log(pc.red('  │  ') + pc.white(`Cleaned resources for: ${deploymentName}`.padEnd(40)) + pc.red('│'));
  console.log(pc.red('  └──────────────────────────────────────────┘\n'));
}
