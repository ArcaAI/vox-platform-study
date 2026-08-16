/**
 * Cross-language parity guard (TASK-734 Task 3): `WORKFLOW_NODE_REGISTRY` (this package) and
 * `NODE_REGISTRY` (`apps/harness/src/harness/temporal/interpreter/registry.py`) must agree on
 * every key, or a definition that validates in the gateway fails admission in the interpreter
 * (see `node-registry.ts`'s module docstring). Neither runtime can import the other's module,
 * so both sides assert against the SAME committed fixture instead of against each other —
 * `test_node_registry_parity.py` is the Python half of this guard.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json',
);

interface FixtureEntry {
  key: string;
  implemented: boolean;
  activityName: string;
  critical: boolean;
  externalWrite: boolean;
  defaultTimeoutSeconds: number;
  defaultMaxAttempts: number;
  entitlementKey: string | null;
}

function loadFixtureEntries(): FixtureEntry[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { entries: FixtureEntry[] };
  return raw.entries;
}

/** Projects this package's registry onto exactly the fields the fixture carries — mirrors what
 *  the Python test does to `NODE_REGISTRY` on its side. */
function projectRegistry(): FixtureEntry[] {
  return Object.values(WORKFLOW_NODE_REGISTRY)
    .map((descriptor) => ({
      key: descriptor.key,
      implemented: descriptor.implemented,
      activityName: descriptor.activityName,
      critical: descriptor.critical,
      externalWrite: descriptor.externalWrite,
      defaultTimeoutSeconds: descriptor.defaultTimeoutSeconds,
      defaultMaxAttempts: descriptor.defaultMaxAttempts,
      entitlementKey: descriptor.entitlementKey,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('WORKFLOW_NODE_REGISTRY <-> registry.py parity fixture', () => {
  it('matches the committed cross-language fixture exactly', () => {
    expect(projectRegistry()).toEqual(loadFixtureEntries());
  });

  it('the fixture is sorted by key (so a diff never looks like an unrelated reorder)', () => {
    const entries = loadFixtureEntries();
    const sorted = entries.slice().sort((a, b) => a.key.localeCompare(b.key));
    expect(entries).toEqual(sorted);
  });

  it('carries exactly the seed keys — noop and passthrough, no more, no less', () => {
    expect(Object.keys(WORKFLOW_NODE_REGISTRY).sort()).toEqual(['noop', 'passthrough']);
  });
});
