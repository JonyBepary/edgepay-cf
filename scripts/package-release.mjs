/**
 * Release Packaging & Integrity Gate Script (V6-001).
 * Ensures zero credential state files or forbidden material can ever be packaged into releases.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

console.log('=== Starting Pre-Packaging Quality & Security Verification Gate ===\n');

// 1. Run all test, typecheck, lint, and verification gates
try {
  console.log('1. Running ESLint...');
  execSync('npm run lint', { stdio: 'inherit' });

  console.log('\n2. Running TypeScript Typecheck...');
  execSync('npm run typecheck', { stdio: 'inherit' });

  console.log('\n3. Verifying Remediation Ledger...');
  execSync('node scripts/verify-remediations.mjs', { stdio: 'inherit' });

  console.log('\n4. Verifying Repository & Configuration Hygiene...');
  execSync('node scripts/verify-config.mjs', { stdio: 'inherit' });

  console.log('\n5. Running Vitest Test Battery...');
  execSync('npm test', { stdio: 'inherit' });
} catch (err) {
  console.error('\n[FATAL] Pre-packaging verification failed. Release package aborted.');
  process.exit(1);
}

// 2. Strict Artifact Tree Scan for Release
console.log('\n6. Checking Release Filesystem Hygiene...');
let scanErrors = 0;

function checkReleaseTree(dir, ignore = ['node_modules', '.git', 'dist', 'coverage', '.system_generated']) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (ignore.includes(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      checkReleaseTree(fullPath, ignore);
    } else {
      if (entry.includes('companion-state.json') && !entry.endsWith('.example')) {
        console.error(`[FAIL] Forbidden state file in release tree: ${fullPath}`);
        scanErrors++;
      }
      if (entry.endsWith('-state.json') && !entry.endsWith('.example')) {
        console.error(`[FAIL] Forbidden state file in release tree: ${fullPath}`);
        scanErrors++;
      }
    }
  }
}

checkReleaseTree('.');

if (scanErrors > 0) {
  console.error(`\n[FATAL] Packaging check failed with ${scanErrors} error(s).`);
  process.exit(1);
}

console.log('✓ Release tree verified clean.');
console.log('\n=== All Packaging Gates Passed Successfully ===\n');
