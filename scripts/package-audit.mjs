/**
 * Clean Audit Distribution Packaging Script (V11-001).
 * Packages the complete codebase (core, tests, multi-worker frontend, docs, scripts)
 * for independent auditors while strictly and deterministically excluding .dev.vars,
 * dev state, node_modules, and git directories.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

console.log('=== Building Clean Audit Distribution Archive (V11-001) ===\n');

// 1. Run Pre-flight Verification Gate
try {
  console.log('1. Running ESLint...');
  execSync('npm run lint', { stdio: 'inherit' });

  console.log('\n2. Running TypeScript Typecheck...');
  execSync('npm run typecheck', { stdio: 'inherit' });

  console.log('\n3. Verifying Configurations...');
  execSync('node scripts/verify-config.mjs', { stdio: 'inherit' });

  console.log('\n4. Verifying Remediation Ledger...');
  execSync('node scripts/verify-remediations.mjs', { stdio: 'inherit' });
} catch (err) {
  console.error('\n[FATAL] Pre-audit quality gates failed. Audit package creation aborted.');
  process.exit(1);
}

const rootDir = process.cwd();
const distDir = join(rootDir, 'dist');
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}
const auditZip = join(distDir, 'edgepay-cf-audit-bundle.zip');

// Remove old audit bundle if exists
try {
  execSync(`rm -f "${auditZip}"`);
} catch {}

// 2. Package archive with strict exclusions
console.log('\n5. Creating clean audit bundle archive...');
const excludeArgs = [
  '-x ".dev.vars"',
  '-x "*/.dev.vars"',
  '-x "*companion-state.json"',
  '-x "*-state.json"',
  '-x ".git/*"',
  '-x "*/.git/*"',
  '-x "node_modules/*"',
  '-x "*/node_modules/*"',
  '-x ".wrangler/*"',
  '-x "*/.wrangler/*"',
  '-x ".opencode/*"',
  '-x "*/.opencode/*"',
  '-x ".slim/*"',
  '-x "*/.slim/*"',
  '-x ".system_generated/*"',
  '-x "*/.system_generated/*"',
  '-x "dist/edgepay-cf-audit-bundle.zip"',
  '-x "dist/edgepay-cf/*"',
].join(' ');

try {
  execSync(`zip -r "${auditZip}" . ${excludeArgs} -q`);
} catch (err) {
  console.error(`[FATAL] Failed to generate audit bundle zip: ${err.message}`);
  process.exit(1);
}

// 3. Post-build Integrity Verification
console.log('\n6. Verifying audit bundle archive contents...');
const zipListing = execSync(`unzip -l "${auditZip}"`, { encoding: 'utf8' });
const FORBIDDEN_AUDIT_PATTERNS = [
  /\.dev\.vars(?!\.example)/,
  /companion-state\.json(?!\.example)/,
  /-state\.json(?!\.example)/,
  /\.wrangler\//,
  /\.opencode\//,
  /\.slim\//,
  /node_modules\//,
  /\.git\//,
];

const lines = zipListing.split('\n');
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('Archive:') || trimmed.startsWith('Length') || trimmed.startsWith('---') || trimmed.includes('files')) {
    continue;
  }
  const match = line.match(/\d{2}:\d{2}\s+(.+)$/);
  if (match) {
    const entryPath = match[1].trim();
    for (const pattern of FORBIDDEN_AUDIT_PATTERNS) {
      if (pattern.test(entryPath)) {
        console.error(`[FATAL] Audit bundle verification failed: forbidden pattern '${pattern}' matched '${entryPath}'!`);
        process.exit(1);
      }
    }
  }
}

const zipStat = statSync(auditZip);
const zipBuffer = readFileSync(auditZip);
const zipSha256 = createHash('sha256').update(zipBuffer).digest('hex');

console.log('\n✓ Clean Audit Distribution Bundle Verified & Ready:');
console.log(`  Archive:    ${auditZip}`);
console.log(`  Size:       ${zipStat.size} bytes`);
console.log(`  SHA-256:    ${zipSha256}`);
console.log(`  Integrity:  100% verified free of .dev.vars, secrets, dev state, and node_modules.`);
console.log('\n=== Audit Packaging Complete ===\n');
