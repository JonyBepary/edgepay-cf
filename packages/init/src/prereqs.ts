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

  if (Number.isNaN(majorNode) || majorNode < 20) {
    errors.push(`Node.js 20+ is required (detected ${nodeVersion}). Please upgrade Node.js.`);
  }

  let wranglerVersion: string | undefined;
  try {
    const res = await execa('npx', ['wrangler', '--version'], { timeout: 15000 });
    wranglerVersion = res.stdout.trim().split('\n').pop()?.trim();
  } catch {
    errors.push('wrangler CLI is not available. Please ensure npm/npx is working.');
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
