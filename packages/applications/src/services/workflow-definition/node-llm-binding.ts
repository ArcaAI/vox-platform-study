import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';

/**
 * DD-10 — a node's LLM BINDING: which model THIS node generates with.
 *
 * The successor to `AiTaskDefault` for the one thing a task key cannot express. Today a
 * generation node says `taskKey: 'text.finalize'` and the runtime resolves the tenant's ONE
 * `AiTaskDefault` row for that key — so a tenant running both an `agent.summarization` and an
 * `agent.discharge_summary` node has them pinned to the same model with no way to differ.
 *
 * | Field | Meaning |
 * |---|---|
 * | `llmBinding.modelSlug` | the `AiModel.slug` this node generates with, resolved `[tenant, SYSTEM]` |
 *
 * ## A REFERENCE, never a literal
 *
 * The slug is exactly the kind of value an `AiTaskDefault` row's `modelSlug` is, and it resolves
 * through the same lookup (`IAiTaskDefaultService.resolveModelBySlug`). What finally reaches
 * `apps/text` — the provider and the provider-native model id — is DERIVED from the `AiModel`
 * row, so a graph can never name an engine or a model id directly
 * (`00-project-context.md` §Configuration Principles rule 1), and funding stays derived from
 * whose `AiProviderConnection` row supplies the CREDENTIAL rather than being stamped here.
 *
 * ## Absent is a statement, and a different one from unresolvable
 *
 * No binding means "this node has no opinion" — the tenant's `taskKey` default applies, exactly
 * as it always has. A binding whose slug does not resolve FAILS CLOSED at
 * `HarnessPolicyService.resolveBoundNodeSelection`, because falling back there would keep an
 * explicitly-bound node generating on a different model with nothing saying so.
 */

/** Node config key carrying the binding. */
export const LLM_BINDING_KEY = 'llmBinding';
/** The one field inside it. */
export const MODEL_SLUG_KEY = 'modelSlug';

export interface NodeLlmBindingRef {
  nodeId: string;
  nodeType: string;
  modelSlug: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `{ modelSlug }` a node's config declares, or `null` when it declares none.
 *
 * Takes a raw config object rather than a node so the REALTIME executor — which hands its
 * handlers `config` and never the node — and the graph-level collector below can share one
 * reader. A malformed binding (`llmBinding` present but not an object, or `modelSlug` blank)
 * reads as ABSENT rather than as an error: the authoring schema is the place a bad shape is
 * refused, and a runtime that threw here would fail a consultation over a field the validator
 * already had its chance at.
 */
export function readLlmBindingFromConfig(config: unknown): { modelSlug: string } | null {
  if (!isPlainObject(config)) return null;
  const binding = config[LLM_BINDING_KEY];
  if (!isPlainObject(binding)) return null;
  const slug = binding[MODEL_SLUG_KEY];
  return typeof slug === 'string' && slug.length > 0 ? { modelSlug: slug } : null;
}

/** {@link readLlmBindingFromConfig} for a graph node. */
export function readLlmBinding(node: WorkflowGraphNode): NodeLlmBindingRef | null {
  const binding = readLlmBindingFromConfig(node.config);
  return binding ? { nodeId: node.id, nodeType: node.type, modelSlug: binding.modelSlug } : null;
}

/**
 * Every LLM binding in a graph, in authored node order.
 *
 * Keyed off the PRESENCE of the binding rather than off a list of node TYPES, for the reason
 * `collectPromptBindings` gives: a type allow-list silently misses the next generation node
 * someone adds to the registry, and missing one here means missing it in every surface that
 * reports what a graph is bound to.
 */
export function collectLlmBindings(graph: WorkflowGraph | null | undefined): NodeLlmBindingRef[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.map(readLlmBinding).filter((binding): binding is NodeLlmBindingRef => binding !== null);
}
