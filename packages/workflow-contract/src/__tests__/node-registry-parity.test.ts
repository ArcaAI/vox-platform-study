/**
 * Cross-language parity guard: `WORKFLOW_NODE_REGISTRY` (this package) and
 * `NODE_REGISTRY` (`apps/harness/src/harness/temporal/interpreter/registry.py`) must agree on
 * every key, or a definition that validates in the gateway fails admission in the interpreter
 * (see `node-registry.ts`'s module docstring). Neither runtime can import the other's module,
 * so both sides assert against the SAME committed fixture instead of against each other —
 * `test_node_registry_parity.py` is the Python half of this guard.
 *
 * TASK-893 Phase 4 CLOSED the one deliberate asymmetry this guard used to carry. A fixture entry
 * with `implemented: false` used to exist on THIS side only — `registry.py` cannot hold a spec
 * without a registered activity callable, so the eight retired `stt.*` keys were kept here for
 * the deprecation window and asserted absent there. That window is over: the deprecated
 * vocabulary is deleted, every remaining key is implemented, and the two registries are now a
 * plain one-to-one mapping over the eleven `core.*` types.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/node-registry.snapshot.json');

interface FixtureEntry {
  key: string;
  implemented: boolean;
  activityName: string;
  critical: boolean;
  externalWrite: boolean;
  defaultTimeoutSeconds: number;
  defaultMaxAttempts: number;
  entitlementKey: string | null;
  /** the FIRST port field that is SHARED, not TS-only. See the projection below. */
  outputKeys: Record<string, string | null>;
  /**
* lane A item 7 — the SECOND shared field: it decides which runtime executes a node,
   *  and the durable interpreter has to read it in order to skip a `realtime` one. 
 */
  lane: 'realtime' | 'durable';
}

function loadFixtureEntries(): FixtureEntry[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { entries: FixtureEntry[] };
  return raw.entries;
}

/**
 * Projects this package's registry onto exactly the fields the fixture carries — mirrors what
 * the Python test does to `NODE_REGISTRY` on its side.
 *
 * ## `outputKeys` — deliberately reopened the parity surface for ONE field
 *
 * Task 10 closed the port contract as TS-only, and the fixture's own `_comment` still says
 * `classes`/`paletteKey` are excluded for that reason. `outputKey` is the exception, and it has
 * to be: it is the ONLY thing that tells `_resolve_bound_inputs` which key of a producing
 * activity's output a socket named `out` actually carries. Leaving it TS-only would put the
 * mapping in a second table, in the other language, free to drift — which is the failure mode
 * this whole fixture exists to prevent.
 *
 * The map is over EVERY output port, not just the data ones: a `null` says "this is a control
 * port, ordering only, it carries no payload", which is what lets the interpreter tell a
 * legitimate ordering edge apart from an edge naming a port that does not exist (the latter
 * raises).
 */
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
      outputKeys: Object.fromEntries(descriptor.outputs.map((port) => [port.name, port.outputKey ?? null])),
      lane: descriptor.lane,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('WORKFLOW_NODE_REGISTRY <-> registry.py parity fixture', () => {
  it('matches the committed cross-language fixture exactly', () => {
    expect(projectRegistry()).toEqual(loadFixtureEntries());
  });

  it('has no `implemented: false` entry left — the TS/Python asymmetry is closed (TASK-893)', () => {
    expect(loadFixtureEntries().filter((entry) => !entry.implemented)).toEqual([]);
    expect(Object.values(WORKFLOW_NODE_REGISTRY).filter((descriptor) => !descriptor.implemented)).toEqual([]);
  });

  it('the fixture is sorted by key (so a diff never looks like an unrelated reorder)', () => {
    const entries = loadFixtureEntries();
    const sorted = entries.slice().sort((a, b) => a.key.localeCompare(b.key));
    expect(entries).toEqual(sorted);
  });

  it('carries exactly the eleven `core.*` keys, no more, no less', () => {
    expect(Object.keys(WORKFLOW_NODE_REGISTRY).sort()).toEqual([
      // TASK-864 introduced this vocabulary alongside the legacy palettes; TASK-893 Phase 4
      // deleted everything else, so it is now the whole node registry. The seventeen ACTIONS
      // behind `core.action` are NOT node types — they live in `ACTION_CATALOGUE` and have their
      // own parity fixture (`action-catalogue.snapshot.json`).
      'core.action',
      'core.agent',
      'core.classify',
      'core.condition',
      'core.data',
      'core.humanReview',
      'core.loop',
      'core.note',
      'core.output',
      'core.trigger',
      'core.variable',
    ]);
  });
});
