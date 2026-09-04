/**
 * TASK-864 B1 — `lib/core-ports.ts` is a MIRROR of the contract's per-instance port resolution.
 * Drift guard: the canonical `branchHandlesOf` / `effectivePorts` / registry come in through the
 * `@arcaai/workflow-contract` devDependency (see `port-compatibility.test.ts` for the posture).
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY, branchHandlesOf as canonicalBranchHandlesOf, effectivePorts as canonicalEffectivePorts } from '@arcaai/workflow-contract';
import { branchHandlesOf, effectiveNodePorts } from '../core-ports';
import type { WorkflowNodeDescriptor } from '../../api/types';

const descriptorByType = new Map<string, WorkflowNodeDescriptor>(
  Object.values(WORKFLOW_NODE_REGISTRY).map((d) => [
    d.key,
    {
      type: d.key,
      implemented: d.implemented,
      activityName: d.activityName,
      classes: [...d.classes],
      paletteKey: d.paletteKey,
      critical: d.critical,
      externalWrite: d.externalWrite,
      defaultTimeoutSeconds: d.defaultTimeoutSeconds,
      defaultMaxAttempts: d.defaultMaxAttempts,
      entitlementKey: d.entitlementKey,
      configSchema: (d.configSchema as Record<string, unknown> | undefined) ?? null,
      inputs: d.inputs.map((p) => ({ name: p.name, primitive: p.primitive as never, required: p.required, multiple: p.multiple })),
      outputs: d.outputs.map((p) => ({ name: p.name, primitive: p.primitive as never, required: p.required, multiple: p.multiple })),
      deprecated: d.deprecated,
      replacedBy: d.replacedBy ?? null,
    },
  ]),
);

const CASES: Array<[string, Record<string, unknown> | undefined]> = [
  ['core.condition', { branches: [{ key: 'urgent', when: 'trigger.priority > 3' }, { key: 'routine', when: 'true' }] }],
  ['core.condition', undefined],
  ['core.classify', { modelSlug: 'gliguard', classes: [{ key: 'safe' }, { key: 'unsafe' }] }],
  ['core.humanReview', {}],
  ['core.action', { actionKey: 'consultation.phiHop' }],
  ['core.action', {}],
  ['core.agent', {}],
  ['core.loop', {}],
  ['agent.grammar', {}],
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
