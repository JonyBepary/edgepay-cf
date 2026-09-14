import { execa } from 'execa';

export interface PrereqCheckResult {
  ok: boolean;
  nodeVersion: string;
  wranglerVersion?: string;
  gitVersion?: string;
  errors: string[];
}

export async function checkPrereqs(): Promise<PrereqCheckResult> {
  const errors: string[] = [];
  const nodeVersion = process.version;
  const majorNode = parseInt(process.versions.node.split('.')[0], 10);

  if (Number.isNaN(majorNode) || majorNode < 22) {
    errors.push(`Node.js 22+ is required (detected ${nodeVersion}). Please upgrade Node.js.`);
  }

  let wranglerVersion: string | undefined;
  try {
    const res = await execa('npx', ['wrangler', '--version'], { timeout: 15000 });
    wranglerVersion = res.stdout.trim().split('\n').pop()?.trim();
  } catch (err: any) {
    const detail = err?.shortMessage || err?.message || String(err);
    errors.push(`wrangler CLI is not available or failed to execute (${detail}). Please ensure npm/npx is working and Node.js >= 22 is used.`);
  }

  let gitVersion: string | undefined;
  try {
    const res = await execa('git', ['--version'], { timeout: 10000 });
    gitVersion = res.stdout.trim();
  } catch {
    errors.push('git is not installed or not available on PATH.');
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    ok: true,
    nodeVersion,
    wranglerVersion,
    gitVersion,
    errors,
  };
}
