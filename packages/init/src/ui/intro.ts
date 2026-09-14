import pc from 'picocolors';

export function renderIntro(version = '0.5.0'): void {
  const line1 = 'EdgePay Self-Hosted Installer';
  const line2 = `v${version}`;

  console.log('\n' + pc.cyan('  ╭──────────────────────────────────────────╮'));
  console.log(pc.cyan('  │  ') + pc.bold(pc.white(line1.padEnd(40))) + pc.cyan('│'));
  console.log(pc.cyan('  │  ') + pc.dim(line2.padEnd(40)) + pc.cyan('│'));
  console.log(pc.cyan('  ╰──────────────────────────────────────────╯\n'));
}
