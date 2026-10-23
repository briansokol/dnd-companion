import { findWorkspaceRoot, loadConfig } from '@dnd/shared';
import { join, resolve } from 'node:path';
import { EXPECTED_MINIMUMS, runImport } from './importer.js';

const config = loadConfig();
const root = findWorkspaceRoot(process.cwd());
const dbPath = resolve(root, config.RULES_DB_PATH);

console.log(`Importing Open5e srd-2024 from ${config.OPEN5E_BASE_URL} into ${dbPath}`);
const result = await runImport({
  baseUrl: config.OPEN5E_BASE_URL,
  dbPath,
  seedPath: join(root, 'data/seed/conditions-2024.json'),
  minimums: EXPECTED_MINIMUMS
});

console.table(result.counts);
if (result.unmappedRulesets.length > 0) {
  console.warn(
    `Rulesets missing from RULESET_AUDIENCE, imported as dm: ${result.unmappedRulesets.join(', ')}`
  );
}
console.log('Next: pnpm data:embed');
