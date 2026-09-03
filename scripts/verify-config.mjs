/**
 * Configuration and Secret Hygiene Verification Script (V4-004, V4-002, V5-001, V5-003, V6-001, V6-003, V7-001, V7-002).
 * Performs direct filesystem tree scanning + git tracking checks + JSONC parsed config validation.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

let errors = 0;

// Helper to strip single-line and multi-line comments from JSONC
function stripJsonComments(str) {
  return str.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? '' : m));
}

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
      // Forbidden state files (e.g. .companion-state.json or any *-state.json)
      const isStateFile = (entry.includes('companion-state.json') || entry.endsWith('-state.json')) && !entry.endsWith('.example');
      if (isStateFile) {
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

// 3. Check wrangler configs with JSONC parser (V7-002, V11-002, V11-005)
const coreConfigFiles = ['wrangler.jsonc', 'wrangler.dev.jsonc', 'wrangler.staging.jsonc'];
const frontendConfigFiles = [
  'frontend/apps/admin/wrangler.jsonc',
  'frontend/apps/checkout/wrangler.jsonc',
  'frontend/apps/hub/wrangler.jsonc',
  'frontend/apps/merchant/wrangler.jsonc',
];
const allConfigFiles = [...coreConfigFiles, ...frontendConfigFiles];

for (const file of allConfigFiles) {
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    const stripped = stripJsonComments(raw);
    try {
      const parsed = JSON.parse(stripped);

      // Verify compatibility_date is pinned across all 7 configs (V11-005)
      if (parsed.compatibility_date !== '2026-07-21') {
        console.error(`[FAIL] compatibility_date in ${file} must be '2026-07-21' (found '${parsed.compatibility_date}')`);
        errors++;
      }

      // Verify core parsed JSON structure across all root configs (V8-002)
      if (coreConfigFiles.includes(file)) {
        if (!parsed.analytics_engine_datasets || !Array.isArray(parsed.analytics_engine_datasets)) {
          console.error(`[FAIL] Active analytics_engine_datasets must be declared in ${file}`);
          errors++;
        }
      }

      // Verify frontend config assets binding (V11-002)
      if (frontendConfigFiles.includes(file)) {
        if (!parsed.assets || !parsed.assets.binding) {
          console.error(`[FAIL] Static assets binding must be declared in ${file}`);
          errors++;
        }
      }
    } catch (parseErr) {
      console.error(`[FAIL] Invalid JSONC in ${file}: ${parseErr.message}`);
      errors++;
    }
  } else {
    console.error(`[FAIL] Expected configuration file missing: ${file}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`Config & secret hygiene verification failed with ${errors} error(s).`);
  process.exit(1);
}

console.log('✓ Configuration and repository hygiene verified (direct filesystem tree scan + git check + JSONC parser).');
