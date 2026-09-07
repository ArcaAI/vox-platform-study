/**
 * The REAL node registry, projected into the console's mirrored `WorkflowNodeDescriptor` shape.
 *
 * Not a `*.test.ts`, so vitest never collects it as a suite (the app's config includes
 * `src/**\/*.test.ts` only). It comes in through the `@arcaai/workflow-contract` devDependency —
 * the same deliberate, test-only posture `port-compatibility.test.ts` documents at length: the
 * console never bundles that package at runtime, but a mirror of a SAFETY predicate that nothing
 * pins is a mirror that drifts. Testing `canvas-handles` / `socket-resolution` against hand-written
 * descriptors would prove only that they agree with the fixture; against the real tables they
 * prove they agree with the contract.
 */
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import type { WorkflowNodeDescriptor } from '../../api/types';

export const REGISTRY: ReadonlyMap<string, WorkflowNodeDescriptor> = new Map<string, WorkflowNodeDescriptor>(
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

/** A graph endpoint for `resolvePrimarySockets` — a node type plus the config an instance carries. */
export function at(type: string, config: Record<string, unknown> = {}): { type: string; config: Record<string, unknown> } {
  return { type, config };
}
