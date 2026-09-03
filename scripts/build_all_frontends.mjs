/**
 * EdgePay Frontend Synchronizer
 * Synchronizes public/assets/ and frontend/apps/ distribution bundles.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

function write(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  console.log(`✓ Synchronized ${filePath} (${content.length} bytes)`);
}

// 1. Synchronize Master Hub HTML
const hubContent = readFileSync('public/assets/design-system/index.html', 'utf8');
write('frontend/apps/hub/public/index.html', hubContent);

// 2. Synchronize Standalone Checkout
const checkoutContent = readFileSync('public/assets/checkout/index.html', 'utf8');
write('frontend/apps/checkout/public/index.html', checkoutContent);

// 3. Synchronize Standalone Merchant
const merchantContent = readFileSync('public/assets/merchant/index.html', 'utf8');
write('frontend/apps/merchant/public/index.html', merchantContent);

// 4. Synchronize Standalone Admin
const adminContent = readFileSync('public/assets/admin/index.html', 'utf8');
write('frontend/apps/admin/public/index.html', adminContent);

console.log('\n★ All frontend application assets synchronized successfully from edgepay-frontend-v2!');
