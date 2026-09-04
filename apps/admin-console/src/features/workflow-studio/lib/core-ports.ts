/**
 * Per-INSTANCE ports for the Studio (TASK-864 B1) — the client mirror of
 * `@arcaai/workflow-contract`'s `branchHandlesOf` / `effectivePorts` (`core-contract.ts`). Same
 * posture as `port-compatibility.ts`: mirrored rather than imported (the console never bundles
 * the contract at runtime) and pinned to the canonical functions by
 * `__tests__/core-ports.test.ts`, which imports them through the devDependency.
 *
 * Three cases, exactly as the contract:
 *  - `core.action` wears its DELEGATE's port table (the descriptor named by `config.actionKey`).
 *  - the two routers (`core.classify`, `core.condition`) add one `control` output per declared
 *    class / branch key, after the static table; `core.humanReview`'s three are already static.
 *  - everything else is the descriptor's static table.
 */
import type { WorkflowNodeDescriptor, WorkflowNodePort } from '../api/types';

export interface EffectivePorts {
  inputs: readonly WorkflowNodePort[];
  outputs: readonly WorkflowNodePort[];
}

function keysOf(config: Readonly<Record<string, unknown>> | undefined, field: string): string[] {
  const items = config?.[field];
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (item !== null && typeof item === 'object' && !Array.isArray(item) ? (item as { key?: unknown }).key : undefined))
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
}

/** The branch handles an instance fans out to — mirror of the contract's `branchHandlesOf`. */
export function branchHandlesOf(nodeType: string, config: Readonly<Record<string, unknown>> | undefined): string[] {
  switch (nodeType) {
    case 'core.classify':
      return [...keysOf(config, 'classes'), 'otherwise'];
    case 'core.condition':
      return [...keysOf(config, 'branches'), 'else'];
    case 'core.humanReview':
      return ['approved', 'rejected', 'timedOut'];
    default:
      return [];
  }
}

/** The action a `core.action` instance delegates to, or `undefined` when unset/unknown. */
export function actionKeyOf(config: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const key = config?.actionKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * The ports an instance actually offers, or `undefined` when the node type is unknown to the
 * registry (the caller's "no port named …" refusal then applies unchanged).
 */
export function effectiveNodePorts(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  nodeType: string,
  config: Readonly<Record<string, unknown>> | undefined,
): EffectivePorts | undefined {
  const descriptor = descriptorByType.get(nodeType);
  if (!descriptor) return undefined;
  if (nodeType === 'core.action') {
    const key = actionKeyOf(config);
    const delegate = key ? descriptorByType.get(key) : undefined;
    if (delegate) return { inputs: delegate.inputs, outputs: delegate.outputs };
  }
  const dynamic = branchHandlesOf(nodeType, config).filter((handle) => !descriptor.outputs.some((port) => port.name === handle));
  if (dynamic.length === 0) return { inputs: descriptor.inputs, outputs: descriptor.outputs };
  return {
    inputs: descriptor.inputs,
    outputs: [...descriptor.outputs, ...dynamic.map((name) => ({ name, primitive: 'control' as const, required: false, multiple: true }))],
  };
}
