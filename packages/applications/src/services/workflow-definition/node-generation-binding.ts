import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';

/**
 * TASK-847 finding F-32 — the pairing a hyper-parameter capability check needs from a graph:
 * the `generation` block a node TUNES, and the `providerConfigRef` that decides whether those
 * knobs reach anything.
 *
 * The two are useless apart. `generation` without a provider reference is a set of values with
 * nothing to check them against; a provider reference without `generation` is a node that tuned
 * nothing and has no question to answer. So a binding exists only when BOTH are present, which
 * is also what keeps the resolver from doing a database read per node for no reason.
 *
 * Keyed off the PRESENCE of the two config keys rather than a node-TYPE allow-list, for the
 * reason `collectPromptBindings` and `collectLlmBindings` both give: an allow-list silently
 * misses the next generation node someone adds to the registry, and missing one here means
 * publishing a graph the gate was supposed to refuse. Today only `agentic.agent` carries both
 * keys (`node-config-schemas.ts` — `agentic.tts` has `providerConfigRef` but no `generation`),
 * and that is a fact about the registry now, not a rule this file relies on.
 */

/** Node config key carrying the generation hyper-parameters. */
export const GENERATION_KEY = 'generation';
/** Node config key carrying the provider-configuration reference. */
export const PROVIDER_CONFIG_REF_KEY = 'providerConfigRef';

export interface NodeGenerationBindingRef {
  nodeId: string;
  nodeType: string;
  /** The tuned parameters, exactly as authored. Passed to the contract check unmodified. */
  generation: Record<string, unknown>;
  /** Which configuration serves this node. Exactly one field is meaningful. */
  providerConfigRef: { routingPolicyId?: string | null; taskKey?: string | null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The `{ generation, providerConfigRef }` a node declares, or `null` when it declares neither or
 * only one.
 *
 * A malformed shape reads as ABSENT rather than as an error, matching `readLlmBindingFromConfig`:
 * the authoring schema is where a bad shape is refused, and throwing here would fail a publish
 * over a field `compile()` and `agenticNodeConfigProblems` already had their chance at — with a
 * message about capabilities that named the wrong problem.
 */
export function readGenerationBinding(node: WorkflowGraphNode): NodeGenerationBindingRef | null {
  const config = node.config;
  if (!isPlainObject(config)) return null;

  const generation = config[GENERATION_KEY];
  const ref = config[PROVIDER_CONFIG_REF_KEY];
  if (!isPlainObject(generation) || !isPlainObject(ref)) return null;

  // An empty `generation: {}` tunes nothing, so there is nothing to verify. The contract check
  // agrees (it returns no problems for an empty set); skipping here just avoids the lookup.
  const tuned = Object.keys(generation).filter((key) => generation[key] !== undefined);
  if (tuned.length === 0) return null;

  return {
    nodeId: node.id,
    nodeType: node.type,
    generation,
    providerConfigRef: { routingPolicyId: readStringField(ref, 'routingPolicyId'), taskKey: readStringField(ref, 'taskKey') },
  };
}

/** Every generation binding in a graph, in authored node order. */
export function collectGenerationBindings(graph: WorkflowGraph | null | undefined): NodeGenerationBindingRef[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.map(readGenerationBinding).filter((binding): binding is NodeGenerationBindingRef => binding !== null);
}
