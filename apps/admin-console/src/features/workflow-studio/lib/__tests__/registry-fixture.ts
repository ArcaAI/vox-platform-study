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
import { ACTION_CATALOGUE, ACTION_PORTS, ACTION_CONFIG_SCHEMAS, WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import type { WorkflowNodeDescriptor } from '../../api/types';

/**
 * TASK-893 Phase 4 — the map carries the ELEVEN node types AND the SEVENTEEN actions, keyed by
 * action key.
 *
 * `effectiveNodePorts` resolves a `core.action` instance by looking its `actionKey` up in THIS
 * map (`core-ports.ts`). Until Phase 4 every action was also a node type, so the lookup found it
 * for free; now it does not, and a map of node types alone would make every action instance fall
 * back to `core.action`'s generic SUPERSET — the canvas would draw six sockets where the action
 * has one, and `isValidConnection` would accept wires the delegate refuses.
 *
 * So the entries below are the wire contract `GET /admin/workflow-nodes` has to satisfy, asserted
 * here rather than assumed. See the lane report's cross-lane request against that endpoint.
 */
const ACTION_DESCRIPTORS = Object.values(ACTION_CATALOGUE).map((a) => ({
  key: a.key,
  implemented: true,
  activityName: a.activityName,
  classes: a.classes,
  paletteKey: 'core',
  critical: a.critical,
  externalWrite: a.externalWrite,
  defaultTimeoutSeconds: a.defaultTimeoutSeconds,
  defaultMaxAttempts: a.defaultMaxAttempts,
  entitlementKey: a.entitlementKey ?? null,
  configSchema: ACTION_CONFIG_SCHEMAS[a.key],
  inputs: ACTION_PORTS[a.key].inputs,
  outputs: ACTION_PORTS[a.key].outputs,
  deprecated: false,
  replacedBy: null,
}));

export const REGISTRY: ReadonlyMap<string, WorkflowNodeDescriptor> = new Map<string, WorkflowNodeDescriptor>(
  [...Object.values(WORKFLOW_NODE_REGISTRY), ...ACTION_DESCRIPTORS].map((d) => [
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
