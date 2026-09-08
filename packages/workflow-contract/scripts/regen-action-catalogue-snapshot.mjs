/**
 * Regenerates the CROSS-LANGUAGE parity fixture for the ACTION catalogue
 * (`src/__tests__/fixtures/action-catalogue.snapshot.json`) from `ACTION_CATALOGUE` — the
 * action twin of `regen-node-registry-snapshot.mjs`, and with the same caveat: it regenerates
 * the TypeScript PROJECTION only. `action_catalogue.py` must then be edited to match, and
 * `test_action_catalogue_parity.py` is what proves it was.
 *
 *   pnpm --filter @arcaai/workflow-contract regen:action-snapshot
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '../src/__tests__/fixtures/action-catalogue.snapshot.json');

const { ACTION_CATALOGUE } = await import(path.join(here, '../src/action-catalogue.ts'));

const DEFAULT_COMMENT =
  'The cross-language ACTION-catalogue parity fixture (TASK-893 Phase 2). `ACTION_CATALOGUE` (packages/workflow-contract/src/action-catalogue.ts) and `action_catalogue.py` (apps/harness/src/harness/temporal/interpreter/) both project onto this file — asserted from action-catalogue-parity.test.ts (TS) and test_action_catalogue_parity.py (Python). Same field set as node-registry.snapshot.json minus `implemented` (every action is dispatchable by construction): `outputKeys` maps EVERY output port name to the runtime key it carries, or null for a control port. Entries sorted by key. Regenerate with `pnpm --filter @arcaai/workflow-contract regen:action-snapshot`.';

const entries = Object.values(ACTION_CATALOGUE)
  .map((descriptor) => ({
    key: descriptor.key,
    activityName: descriptor.activityName,
    critical: descriptor.critical,
    externalWrite: descriptor.externalWrite,
    defaultTimeoutSeconds: descriptor.defaultTimeoutSeconds,
    defaultMaxAttempts: descriptor.defaultMaxAttempts,
    entitlementKey: descriptor.entitlementKey ?? null,
    outputKeys: Object.fromEntries(descriptor.ports.outputs.map((port) => [port.name, port.outputKey ?? null])),
    lane: descriptor.lane,
  }))
  .sort((a, b) => a.key.localeCompare(b.key));

const existing = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : {};
writeFileSync(FIXTURE, `${JSON.stringify({ _comment: existing._comment ?? DEFAULT_COMMENT, entries }, null, 2)}\n`);
console.log(`wrote ${entries.length} entries to ${path.relative(process.cwd(), FIXTURE)}`);
