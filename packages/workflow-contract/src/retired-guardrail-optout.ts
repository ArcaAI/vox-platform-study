/**
 * The RETIRED guardrail opt-out — accepted and stripped, never honoured.
 *
 * Platform guardrail now screens every LLM call, request and response, with no tenant, agent,
 * workflow or node switch (owner decision OD-1, 2026-10-02; it reverses the earlier per-scope
 * opt-out). The fields that carried the opt-out are gone from the vocabulary:
 *
 *   - `core.trigger` / `core.agent` node `config.guardrail` (`{ enabled }`), and
 *   - agent `parameters.guards.enabled`.
 *
 * Rows written before the retirement can still hold them. A stored value must neither turn
 * screening off nor make the row unreadable (`additionalProperties: false` would refuse it with a
 * 400 the tenant could not fix without first opening the row), so for ONE release every parser
 * strips the field on the way in. REMOVE these helpers in the release after the back-fill
 * (`packages/database/scripts/strip-retired-guardrail-optout.ts`) has run in every environment;
 * from then on a stray field is an ordinary schema error.
 *
 * Pure and dependency-free. Each helper returns its input UNCHANGED (same reference) when there is
 * nothing to strip, so a caller can compare by identity to learn whether a write is needed.
 */
import type { WorkflowGraph } from './graph-model';

/** The node-config key the retired opt-out lived under. */
const NODE_KEY = 'guardrail';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One node config without the retired `guardrail` key; the same object when it carries none. */
export function stripRetiredNodeGuardrailOptOut<T>(config: T): T {
  if (!isPlainObject(config) || !(NODE_KEY in config)) return config;
  const { [NODE_KEY]: _retired, ...rest } = config;
  return rest as T;
}

/** Every node of a graph stripped; `changed` says whether any node carried the retired key. */
export function stripRetiredGraphGuardrailOptOuts<G extends Pick<WorkflowGraph, 'nodes'>>(graph: G): { graph: G; changed: boolean } {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes)) return { graph, changed: false };
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (!isPlainObject(node)) return node;
    const config = stripRetiredNodeGuardrailOptOut(node.config);
    if (config === node.config) return node;
    changed = true;
    return { ...node, config };
  });
  return changed ? { graph: { ...graph, nodes }, changed } : { graph, changed };
}

/**
 * Agent `parameters` without the retired `guards.enabled`; a `guards` block emptied by the strip is
 * dropped. The same object when there is nothing to strip.
 */
export function stripRetiredAgentGuardrailOptOut<T>(parameters: T): T {
  if (!isPlainObject(parameters) || !isPlainObject(parameters.guards) || !('enabled' in parameters.guards)) return parameters;
  const { enabled: _retired, ...guards } = parameters.guards;
  const { guards: _old, ...rest } = parameters;
  return (Object.keys(guards).length > 0 ? { ...rest, guards } : rest) as T;
}
