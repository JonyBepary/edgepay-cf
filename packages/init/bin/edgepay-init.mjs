#!/usr/bin/env node

import { runInstaller } from '../dist/index.js';

runInstaller().catch((err) => {
  console.error('\nInstallation failed:', err?.message || err);
  console.log('Re-run this command to resume from the last successful step.\n');
  process.exit(1);
});
