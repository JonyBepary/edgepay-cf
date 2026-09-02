/**
 * Configuration and Secret Hygiene Verification Script (V4-004, V4-002, V5-001, V5-003).
 * Performs direct filesystem tree scanning + git tracking checks.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

let errors = 0;

// 1. Direct filesystem tree scan for forbidden state files
function scanTree(dir, ignoreDirs = ['node_modules', '.git', 'dist', 'coverage', '.system_generated']) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (ignoreDirs.includes(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      scanTree(fullPath, ignoreDirs);
    } else {
      // Forbidden state files (e.g. .companion-state.json)
      if (entry.includes('companion-state.json') && !entry.endsWith('.example')) {
        console.error(`[FAIL] Forbidden state file detected in tree: ${fullPath}`);
        errors++;
      }
      if (entry.endsWith('-state.json') && !entry.endsWith('.example')) {
        console.error(`[FAIL] Forbidden state file detected in tree: ${fullPath}`);
        errors++;
      }

      // Check code/config files for hardcoded live API keys (pattern: sk_live_<alphanumeric>, whsec_<alphanumeric>)
      if (
        !fullPath.includes('/tests/') &&
        !fullPath.endsWith('.md') &&
        !fullPath.endsWith('.example') &&
        !fullPath.endsWith('.png') &&
        !fullPath.endsWith('.jpg') &&
        !fullPath.endsWith('.svg')
      ) {
        try {
          const content = readFileSync(fullPath, 'utf8');
          if (/sk_live_[0-9a-zA-Z]{24,}/.test(content) || /whsec_[0-9a-zA-Z]{24,}/.test(content)) {
            console.error(`[FAIL] Live secret token detected in: ${fullPath}`);
            errors++;
          }
        } catch {}
      }
    }
  }
}

scanTree('.');

// 2. Check if forbidden files are tracked in git (if in a git repo)
try {
  const trackedFiles = execSync('git ls-files', { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  if (trackedFiles.includes('.dev.vars')) {
    console.error('[FAIL] .dev.vars must not be tracked in git');
    errors++;
  }
  if (trackedFiles.some(f => f.includes('companion-state.json') && !f.endsWith('.example'))) {
    console.error('[FAIL] companion-state.json must not be tracked in git');
    errors++;
  }
} catch {
  // Not in a git repo (e.g. zip distribution), filesystem scan covers it
}

// 3. Check wrangler configs for Analytics Engine dataset declaration or activation guidance
const configFiles = ['wrangler.jsonc', 'wrangler.dev.jsonc', 'wrangler.staging.jsonc'];
for (const file of configFiles) {
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes('analytics_engine_datasets')) {
      console.error(`[FAIL] analytics_engine_datasets must be referenced in ${file}`);
      errors++;
    }
  }
}

if (errors > 0) {
  console.error(`Config & secret hygiene verification failed with ${errors} error(s).`);
  process.exit(1);
}

console.log('✓ Configuration and repository hygiene verified (direct filesystem tree scan + git check).');
