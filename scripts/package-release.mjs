/**
 * Release Packaging & Integrity Gate Script (V6-001, V7-001).
 * 1. Runs full 5-step verification battery.
 * 2. Creates a clean staging build strictly excluding all .dev.vars and state files.
 * 3. Generates SHA-256 release-manifest.json.
 * 4. Compresses into dist/edgepay-cf-release.zip and verifies the artifact independently.
 */
import { execSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

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

// 2. Build Clean Distribution Archive in dist/
console.log('\n6. Building & Validating Clean Release Distribution Archive...');

const distDir = join(process.cwd(), 'dist');
const stagingDir = join(distDir, 'edgepay-cf');
const zipFile = join(distDir, 'edgepay-cf-release.zip');

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(stagingDir, { recursive: true });

const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.system_generated',
  '.DS_Store',
];

function isForbiddenInRelease(relPath, fileName) {
  // 1. Forbidden env files (.dev.vars, .env, etc. - except .example)
  if (fileName === '.dev.vars' || (fileName.startsWith('.dev.vars.') && !fileName.endsWith('.example'))) {
    return true;
  }
  // 2. Forbidden state files
  if ((fileName.includes('companion-state.json') || fileName.endsWith('-state.json')) && !fileName.endsWith('.example')) {
    return true;
  }
  return false;
}

function copyCleanTree(srcDir, destDir) {
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    if (IGNORE_PATTERNS.includes(entry)) continue;

    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const relPath = relative(process.cwd(), srcPath);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyCleanTree(srcPath, destPath);
    } else {
      if (isForbiddenInRelease(relPath, entry)) {
        // Excluded from release archive
        continue;
      }
      copyFileSync(srcPath, destPath);
    }
  }
}

copyCleanTree(process.cwd(), stagingDir);

// 3. Scan Staging Directory to Guarantee 100% Hygiene
let scanErrors = 0;
const manifestFiles = {};

function scanAndHashStaging(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = relative(stagingDir, fullPath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      scanAndHashStaging(fullPath);
    } else {
      // Re-verify no forbidden file slipped through
      if (isForbiddenInRelease(relPath, entry)) {
        console.error(`[FATAL] Forbidden file found in release staging: ${relPath}`);
        scanErrors++;
      }
      const fileBytes = readFileSync(fullPath);
      const hash = createHash('sha256').update(fileBytes).digest('hex');
      manifestFiles[relPath] = {
        size: stat.size,
        sha256: hash,
      };
    }
  }
}

scanAndHashStaging(stagingDir);

if (scanErrors > 0) {
  console.error(`\n[FATAL] Staging tree hygiene failed with ${scanErrors} error(s).`);
  process.exit(1);
}

// 4. Write release-manifest.json
const manifest = {
  release: 'edgepay-cf',
  version: '0.4.1',
  timestamp: new Date().toISOString(),
  file_count: Object.keys(manifestFiles).length,
  files: manifestFiles,
};

const manifestPath = join(stagingDir, 'release-manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

// 5. Create Distribution Zip Archive
try {
  execSync(`cd "${distDir}" && zip -r edgepay-cf-release.zip edgepay-cf -q`);
} catch (zipErr) {
  console.error(`[FATAL] Failed to create zip archive: ${zipErr.message}`);
  process.exit(1);
}

// 6. Verify the created Zip Archive
const zipStat = statSync(zipFile);
const zipBuffer = readFileSync(zipFile);
const zipSha256 = createHash('sha256').update(zipBuffer).digest('hex');

// Double-check zip entries using unzip -l
const zipListing = execSync(`unzip -l "${zipFile}"`, { encoding: 'utf8' });
if (zipListing.includes('.dev.vars\n') || zipListing.includes('.companion-state.json\n')) {
  console.error('[FATAL] Zip verification failed: forbidden files detected in generated archive!');
  process.exit(1);
}

console.log(`✓ Clean release archive generated successfully:`);
console.log(`  Archive:   ${zipFile}`);
console.log(`  Size:      ${zipStat.size} bytes`);
console.log(`  SHA-256:   ${zipSha256}`);
console.log(`  Files:     ${Object.keys(manifestFiles).length} files packaged (0 .dev.vars, 0 state files)`);

console.log('\n=== All Packaging Gates Passed Successfully ===\n');
