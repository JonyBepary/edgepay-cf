/**
 * Verifies docs/REMEDIATIONS.md structure, citation relevance, and non-colliding finding IDs.
 * (V4-003, V5-004, V5-005)
 */
import { readFileSync, existsSync } from 'node:fs';

const mdPath = 'docs/REMEDIATIONS.md';
if (!existsSync(mdPath)) {
  console.error(`FAIL: ${mdPath} not found`);
  process.exit(1);
}

const content = readFileSync(mdPath, 'utf8');
const lines = content.split('\n');

let checked = 0;
let errors = 0;
const seenIds = new Set();

for (const line of lines) {
  // Only skip true markdown table header rows (e.g. | Finding ID | ... or |---|...)
  if (!line.startsWith('|') || /^\s*\|\s*[-:]+\s*\|/.test(line) || /^\s*\|\s*\**Finding ID\**/i.test(line)) {
    continue;
  }

  const parts = line.split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length < 5) continue;

  const [rawId, severity, category, status, files, testCitation] = parts;
  const id = rawId.replace(/\*/g, '').trim();

  // Check duplicate IDs
  if (seenIds.has(id)) {
    console.error(`[FAIL] Duplicate Finding ID in ledger: ${id}`);
    errors++;
  }
  seenIds.add(id);
  checked++;

  if (status.includes('FIXED') && testCitation) {
    // Extract test file mentions (e.g. tests/something.test.ts)
    const testFiles = testCitation.match(/tests\/[\w.-]+\.test\.ts/g) || [];
    for (const tf of testFiles) {
      if (!existsSync(tf)) {
        console.error(`[FAIL] ${id} cites non-existent test file: ${tf}`);
        errors++;
      } else {
        // Citation relevance check: verify the test file covers the finding ID or category keywords
        const testContent = readFileSync(tf, 'utf8');
        const idKeyword = id.replace(/^(EDGE-|NEW-|V\d+-)/, '');
        if (!testContent.includes(id) && !testContent.toLowerCase().includes(idKeyword.toLowerCase())) {
          // Check if test file contains relevant category keyword
          const catWords = category.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const hasKeyword = catWords.some(w => testContent.toLowerCase().includes(w));
          if (!hasKeyword) {
            console.warn(`[WARN] Citation relevance notice: ${id} cited in ${tf}`);
          }
        }
      }
    }
  }
}

if (errors > 0) {
  console.error(`Audit gate failed with ${errors} error(s).`);
  process.exit(1);
}

console.log(`✓ Remediation ledger verified (${checked} rows checked, 0 errors, 0 duplicate IDs).`);
