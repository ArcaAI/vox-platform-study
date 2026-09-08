/**
 * TASK-864 B1 — `lib/core-ports.ts` is a MIRROR of the contract's per-instance port resolution.
 * Drift guard: the canonical `branchHandlesOf` / `effectivePorts` / registry come in through the
 * `@arcaai/workflow-contract` devDependency (see `port-compatibility.test.ts` for the posture).
 */
import { describe, expect, it } from 'vitest';
import { branchHandlesOf as canonicalBranchHandlesOf, effectivePorts as canonicalEffectivePorts } from '@arcaai/workflow-contract';
import { branchHandlesOf, effectiveNodePorts } from '../core-ports';
import { REGISTRY as descriptorByType } from './registry-fixture';

const CASES: Array<[string, Record<string, unknown> | undefined]> = [
  ['core.condition', { branches: [{ key: 'urgent', when: 'trigger.priority > 3' }, { key: 'routine', when: 'true' }] }],
  ['core.condition', undefined],
  ['core.classify', { modelSlug: 'gliguard', classes: [{ key: 'safe' }, { key: 'unsafe' }] }],
  ['core.humanReview', {}],
  ['core.action', { actionKey: 'consultation.phiHop' }],
  ['core.action', {}],
  ['core.agent', {}],
  ['core.loop', {}],
  // TASK-893 Phase 4: `agent.grammar` was a node type and is not one any more. The delegate case
  // above is what covers the resolution path it used to exercise; `session.timeout` adds the
  // ordering-only action, whose table has no data socket at all.
  ['core.action', { actionKey: 'session.timeout' }],
];

describe('core-ports mirror', () => {
  it.each(CASES)('%s: branch handles and effective ports match the contract', (type, config) => {
    expect(branchHandlesOf(type, config)).toEqual(canonicalBranchHandlesOf(type, config));
    const mine = effectiveNodePorts(descriptorByType, type, config)!;
    const canonical = canonicalEffectivePorts(type, config);
    expect(mine.inputs.map((p) => [p.name, p.primitive])).toEqual(canonical.inputs.map((p) => [p.name, p.primitive]));
    expect(mine.outputs.map((p) => [p.name, p.primitive])).toEqual(canonical.outputs.map((p) => [p.name, p.primitive]));
  });

  it('an unknown node type yields undefined', () => {
    expect(effectiveNodePorts(descriptorByType, 'does.not.exist', {})).toBeUndefined();
  });
});
