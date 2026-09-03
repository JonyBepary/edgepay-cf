/**
 * Clean Hand-off Packaging Script (V10-001).
 * Generates an untainted external distribution archive from the verified clean staging tree,
 * strictly guaranteeing zero .dev.vars, zero runtime state, and zero forbidden binaries.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

console.log('=== Building Verified Clean Hand-off Distribution Archive (V10-001) ===\n');

// 1. Ensure clean release build & staging gate passes first
try {
  execSync('node scripts/package-release.mjs', { stdio: 'inherit' });
} catch (err) {
  console.error('\n[FATAL] Staging packaging failed. Hand-off archive creation aborted.');
  process.exit(1);
}

const distDir = join(process.cwd(), 'dist');
const handoffZip = join(distDir, 'edgepay-cf-clean-handoff.zip');

// 2. Package handoff zip from clean staging tree
try {
  console.log('\nCompressing verified clean tree into hand-off distribution archive...');
  execSync(`cd "${distDir}" && zip -r edgepay-cf-clean-handoff.zip edgepay-cf -q`);
} catch (err) {
  console.error(`[FATAL] Failed to create hand-off zip archive: ${err.message}`);
  process.exit(1);
}

// 3. Post-build integrity verification on hand-off archive
const zipStat = statSync(handoffZip);
const zipBuffer = readFileSync(handoffZip);
const zipSha256 = createHash('sha256').update(zipBuffer).digest('hex');

const zipListing = execSync(`unzip -l "${handoffZip}"`, { encoding: 'utf8' });
const FORBIDDEN_HANDOFF_PATTERNS = [
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
    for (const pattern of FORBIDDEN_HANDOFF_PATTERNS) {
      if (pattern.test(entryPath)) {
        console.error(`[FATAL] Hand-off archive verification failed: pattern '${pattern}' matched entry '${entryPath}'!`);
        process.exit(1);
      }
    }
  }
}

console.log(`\n✓ Clean Hand-off Archive Ready for Distribution:`);
console.log(`  Archive:    ${handoffZip}`);
console.log(`  Size:       ${zipStat.size} bytes`);
console.log(`  SHA-256:    ${zipSha256}`);
console.log(`  Integrity:  100% verified free of .dev.vars, dev state, and stray binaries.`);
console.log('\n=== Hand-off Packaging Complete ===\n');
