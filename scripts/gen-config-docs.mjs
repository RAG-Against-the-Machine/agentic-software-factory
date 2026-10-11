#!/usr/bin/env node
/**
 * Regenerate .env.example and docs/CONFIGURATION.md from the settings catalogue.
 *   pnpm gen:config            write them
 *   pnpm gen:config --check    exit 1 if they are stale (CI)
 * Requires @asf/shared to be built.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderEnvExample, renderConfigDoc } from '../packages/shared/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [[join(root, '.env.example'), renderEnvExample()], [join(root, 'docs/CONFIGURATION.md'), renderConfigDoc()]];
const check = process.argv.includes('--check');
let stale = 0;
for (const [path, body] of targets) {
  const current = (() => { try { return readFileSync(path, 'utf8'); } catch { return ''; } })();
  if (current === body) continue;
  if (check) { console.error(`stale: ${path} (run pnpm gen:config)`); stale++; }
  else { writeFileSync(path, body); console.log(`wrote ${path}`); }
}
process.exit(stale ? 1 : 0);
