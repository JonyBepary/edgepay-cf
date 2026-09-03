/**
 * Release Packaging & Integrity Gate Script (V6-001..V10-005).
 * 1. Runs full 5-stage pre-flight verification battery.
 * 2. Creates a clean staging build strictly excluding dev state, hidden dirs, .dev.vars, stray binaries, and audit documents.
 * 3. Inverts binary filter to strict allowlist (V10-003).
 * 4. Generates SHA-256 release-manifest.json.
 * 5. Compresses into dist/edgepay-cf-release.zip and verifies the artifact independently with strict regex matching.
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

  console.log('\n4. Verifying Repository & Configuration Hygiene (All Configs Active)...');
  execSync('node scripts/verify-config.mjs', { stdio: 'inherit' });

  console.log('\n5. Running Vitest Test Battery...');
  execSync('npm test', { stdio: 'inherit' });
} catch (err) {
  console.error('\n[FATAL] Pre-packaging verification failed. Release package aborted.');
  process.exit(1);
}

// 2. Build Clean Distribution Archive in dist/
console.log('\n6. Building & Validating Clean Release Distribution Archive (Strict Allowlist Filter)...');

const distDir = join(process.cwd(), 'dist');
const stagingDir = join(distDir, 'edgepay-cf');
const zipFile = join(distDir, 'edgepay-cf-release.zip');

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(stagingDir, { recursive: true });

const ALLOWED_CODE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.sql', '.html', '.css',
  '.md', '.yml', '.yaml', '.txt', '.example', '.gitignore', '.astro', '.svg'
]);

function isForbiddenInRelease(relPath, fileName, isDir) {
  // 1. Hidden & build directories
  if (isDir) {
    if (fileName.startsWith('.') && fileName !== '.github') {
      return true;
    }
    if (['node_modules', 'dist', 'coverage', '.system_generated', 'Archive', 'frontend_reference'].includes(fileName)) {
      return true;
    }
    return false;
  }

  // 2. Hidden & environment files (.dev.vars, .env, state files - except .example and .gitignore)
  if (fileName === '.dev.vars' || (fileName.startsWith('.dev.vars.') && !fileName.endsWith('.example'))) {
    return true;
  }
  if ((fileName.includes('companion-state.json') || fileName.endsWith('-state.json')) && !fileName.endsWith('.example')) {
    return true;
  }
  if (fileName === '.DS_Store' || fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3') || fileName.endsWith('.sqlite-wal') || fileName.endsWith('.log')) {
    return true;
  }

  // 3. Exclude internal audit reports and correspondence from release package (V9-002)
  if (/EDGEPAY.*AUDIT.*\.md$/i.test(fileName) || relPath.includes('docs/Archive/')) {
    return true;
  }
  if (fileName === 'EdgePay API.json' || fileName.endsWith('.postman_collection.json')) {
    return true;
  }

  // 4. Strict Binary Allowlist (V10-003):
  // Asset images permitted ONLY inside public asset directories
  const isImageOrMedia = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|mp4|webm|pdf)$/i.test(fileName);
  if (isImageOrMedia) {
    if (relPath.startsWith('public/') || relPath.startsWith('sms-phone-mockup/public/')) {
      return false; // permitted
    }
    return true; // forbidden outside designated assets
  }

  // Deny all arbitrary binaries, archives, and executables anywhere
  const isForbiddenBinary = /\.(pdf|zip|tar|gz|7z|rar|exe|bin|iso|docx|xlsx|pptx|mp4|avi|mov)$/i.test(fileName);
  if (isForbiddenBinary) {
    return true;
  }

  // Allowlist text and code extensions
  const extMatch = fileName.match(/\.[0-9a-z_-]+$/i);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  if (ext && !ALLOWED_CODE_EXTENSIONS.has(ext) && !fileName.endsWith('.example')) {
    return true;
  }

  return false;
}

const excludedLog = [];

function copyCleanTree(srcDir, destDir) {
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const relPath = relative(process.cwd(), srcPath);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      if (isForbiddenInRelease(relPath, entry, true)) {
        excludedLog.push(`[DIR]  ${relPath}`);
        continue;
      }
      mkdirSync(destPath, { recursive: true });
      copyCleanTree(srcPath, destPath);
    } else {
      if (isForbiddenInRelease(relPath, entry, false)) {
        excludedLog.push(`[FILE] ${relPath}`);
        continue;
      }
      copyFileSync(srcPath, destPath);
    }
  }
}

copyCleanTree(process.cwd(), stagingDir);

// 3. Scan Staging Directory to Guarantee 100% Hygiene & Generate Hashes
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
      if (isForbiddenInRelease(relPath, entry, false)) {
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
  version: '0.4.5',
  timestamp: new Date().toISOString(),
  staged_file_count: Object.keys(manifestFiles).length,
  manifest_note: 'archive contains staged_file_count + 1 file entries (plus directory path entries in unzip listing)',
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

// 6. Strict Comprehensive Post-Build Zip Listing Verification (V8-004, V9-001..V9-004, V10-003)
const zipStat = statSync(zipFile);
const zipBuffer = readFileSync(zipFile);
const zipSha256 = createHash('sha256').update(zipBuffer).digest('hex');

const zipListing = execSync(`unzip -l "${zipFile}"`, { encoding: 'utf8' });
const FORBIDDEN_ZIP_PATTERNS = [
  /\.dev\.vars(?!\.example)/,
  /companion-state\.json(?!\.example)/,
  /-state\.json(?!\.example)/,
  /\.wrangler\//,
  /\.opencode\//,
  /\.slim\//,
  /\.sqlite/,
  /\.log$/,
  /node_modules\//,
  /\.git\//,
  /EDGEPAY.*AUDIT.*\.md/i,
  /\.(pdf|zip|tar|gz|exe|bin|docx|mp4)$/i,
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
    for (const pattern of FORBIDDEN_ZIP_PATTERNS) {
      if (pattern.test(entryPath)) {
        console.error(`[FATAL] Zip verification failed: forbidden pattern '${pattern}' matched entry '${entryPath}'!`);
        process.exit(1);
      }
    }
  }
}

console.log(`✓ Clean release archive generated and verified successfully:`);
console.log(`  Archive:              ${zipFile}`);
console.log(`  Size:                 ${zipStat.size} bytes`);
console.log(`  SHA-256:              ${zipSha256}`);
console.log(`  Staged Files:         ${Object.keys(manifestFiles).length} files`);
console.log(`  Total File Entries:   ${Object.keys(manifestFiles).length + 1} (including release-manifest.json)`);
console.log(`  Exclusions Applied:   ${excludedLog.length} items filtered`);
console.log('\n  Filtered Items Summary:');
for (const item of excludedLog.slice(0, 15)) {
  console.log(`    - ${item}`);
}
if (excludedLog.length > 15) {
  console.log(`    ... and ${excludedLog.length - 15} more items.`);
}

console.log('\n=== All Packaging Gates Passed Successfully ===\n');
