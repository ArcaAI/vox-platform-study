/** The committed `policy-keys.json` (lane W2a1), read as the tests' catalogue — never a stand-in. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REAL_CATALOGUE_PATH = fileURLToPath(new URL('../../../../../../apps/guardrail/src/guardrail/tests/contracts/policy-keys.json', import.meta.url));
export const realCatalogue: { schemaVersion: 1; keys: Array<Record<string, unknown>> } = JSON.parse(readFileSync(REAL_CATALOGUE_PATH, 'utf8'));
