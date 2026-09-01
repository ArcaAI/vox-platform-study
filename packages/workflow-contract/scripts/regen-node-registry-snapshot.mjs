/**
 * Regenerates the CROSS-LANGUAGE parity fixture
 * (`src/__tests__/fixtures/node-registry.snapshot.json`) from `WORKFLOW_NODE_REGISTRY`.
 *
 * ## Why a script rather than hand-editing
 *
 * The fixture is the ONE artifact both `node-registry-parity.test.ts` (TS) and
 * `test_node_registry_parity.py` (Python) assert against — neither runtime can import the
 * other's module, so the file IS the contract. Before TASK-847 it was maintained by hand, and
 * hand-maintaining a 56-entry projection of a 56-entry table is how the two drift.
 *
 * This script only ever regenerates the TypeScript PROJECTION. It cannot make the Python side
 * agree, and it deliberately does not try: after running it, `registry.py` must be edited to
 * match, and the Python parity test is what proves it was. A green TS suite after a regen
 * proves nothing on its own — run `pnpm harness:test` too.
 *
 * `_comment` is preserved verbatim: it is the accumulated reasoning for why each field is or is
 * not shared across the language boundary, and regenerating it away would delete the record.
 *
 *   npx tsx packages/workflow-contract/scripts/regen-node-registry-snapshot.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '../src/__tests__/fixtures/node-registry.snapshot.json');

// The registry is TypeScript, so this script is invoked through `tsx` (`npx tsx <this file>`),
// never bare `node` — `register('tsx/esm')` is refused on Node >= 20.6.
const { WORKFLOW_NODE_REGISTRY } = await import(path.join(here, '../src/node-registry.ts'));

const entries = Object.values(WORKFLOW_NODE_REGISTRY)
  .map((descriptor) => ({
    key: descriptor.key,
    implemented: descriptor.implemented,
    activityName: descriptor.activityName,
    critical: descriptor.critical,
    externalWrite: descriptor.externalWrite,
    defaultTimeoutSeconds: descriptor.defaultTimeoutSeconds,
    defaultMaxAttempts: descriptor.defaultMaxAttempts,
    entitlementKey: descriptor.entitlementKey,
    outputKeys: Object.fromEntries(descriptor.outputs.map((port) => [port.name, port.outputKey ?? null])),
    lane: descriptor.lane,
  }))
  // `localeCompare`, matching BOTH parity tests' own sort. Not `.sort()` — the two disagree on
  // where `agentic.*` falls relative to `agent.*`, and a fixture sorted the other way fails the
  // "sorted by key" assertion rather than the content one, which reads like an unrelated bug.
  .sort((a, b) => a.key.localeCompare(b.key));

const existing = JSON.parse(readFileSync(FIXTURE, 'utf8'));
writeFileSync(FIXTURE, `${JSON.stringify({ _comment: existing._comment, entries }, null, 2)}\n`);
console.log(`wrote ${entries.length} entries to ${path.relative(process.cwd(), FIXTURE)}`);
