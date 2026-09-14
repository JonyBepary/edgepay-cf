import pc from 'picocolors';
import * as p from '@clack/prompts';

export function stepHeader(stepNumber: number, title: string): void {
  console.log(`\n${pc.cyan('◐')} ${pc.bold(title)}`);
}

export function stepSuccess(label: string, detail?: string): void {
  console.log(`  ${pc.green('✓')} ${label}${detail ? pc.dim(` (${detail})`) : ''}`);
}

export function stepWarn(label: string): void {
  console.log(`  ${pc.yellow('!')} ${label}`);
}

export function stepError(label: string): void {
  console.log(`  ${pc.red('✗')} ${label}`);
}

export interface StepRunnerOptions<T> {
  startMsg: string;
  successMsg: (result: T) => string;
  failMsg?: string;
}

export async function runStep<T>(
  action: () => Promise<T>,
  opts: StepRunnerOptions<T>,
): Promise<T> {
  const s = p.spinner();
  s.start(opts.startMsg);
  try {
    const result = await action();
    s.stop(opts.successMsg(result));
    return result;
  } catch (err: unknown) {
    const msg = opts.failMsg || (err instanceof Error ? err.message : String(err));
    s.stop(pc.red(`Failed: ${msg}`));
    throw err;
  }
}
