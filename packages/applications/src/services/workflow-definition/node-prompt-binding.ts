import { canonicalJson } from '@arcaai/workflow-contract';
import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';
import { createHash } from 'node:crypto';

/**
 * DD-11 — a text-generation node's PROMPT BINDING, and the two update paths
 * that must not be confused with each other.
 *
 * A generation node MUST reference a prompt template. The binding is two
 * fields on the node's own config:
 *
 * | Field | Meaning |
 * |---|---|
 * | `promptTemplateId` | WHICH template this node uses |
 * | `promptVersionNumber` | WHICH IMMUTABLE VERSION of it — the node's own movable PIN |
 *
 * The pin is what makes a SHARED template safe. Without it, "which prompt did
 * this node use" resolves to "whatever the template says right now", so an
 * admin editing one template on the Prompt management screen silently changes
 * every workflow that references it — including published clinical ones, and
 * including ones whose owners have never seen the edit.
 *
 * With the pin, the two edit paths mean different things ON PURPOSE:
 *
 * | Path | Version | Pin |
 * |---|---|---|
 * | Edited **from within the node** | new version | **moves, atomically, in the same transaction** |
 * | Edited from the **Prompt management screen** | new version | **does not move — for ANY node** |
 *
 * The second path is not an oversight to be fixed later; it is the guarantee.
 * Each referencing node is re-pinned separately and deliberately, surfaced by
 * the "new version available" affordance that {@link collectPromptBindings}
 * feeds.
 */

/** Node config keys that carry the binding. */
export const PROMPT_TEMPLATE_ID_KEY = 'promptTemplateId';
export const PROMPT_VERSION_NUMBER_KEY = 'promptVersionNumber';

export interface NodePromptBinding {
  nodeId: string;
  nodeType: string;
  promptTemplateId: string;
  /** The node's pin. Null means "never pinned" — it follows the template's approved version. */
  pinnedVersionNumber: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * WHERE a node carries its binding — the node's own config, or one level down.
 *
 * TASK-893 moved it. `prompt.template_ref` is no longer a node type; it is an entry in
 * `ACTION_CATALOGUE`, so a `core` graph binds a template on a `core.action` whose delegate config
 * lives under `config.action`. `core.action`'s schema is `additionalProperties: false`, so the key
 * CANNOT be authored at the top level any more — and a collector that only looked there returned
 * nothing for every `core` graph: no `promptTemplateRefs` in the compiled artifact (so a published
 * clinical workflow re-prompts on the next template edit, the exact failure the pin exists to
 * prevent), no "new version available" affordance, and no node for `movePin` to find. Silently.
 *
 * Still keyed off the PRESENCE of the key rather than a node-type allow-list, for the reason
 * {@link collectPromptBindings} gives — the search is just two levels deep now. Top level wins
 * when both carry one, so a node type that goes back to declaring it directly needs no change.
 */
function bindingHolder(node: WorkflowGraphNode): Record<string, unknown> | null {
  const config = isPlainObject(node.config) ? node.config : {};
  if (typeof config[PROMPT_TEMPLATE_ID_KEY] === 'string') return config;
  const delegate = config.action;
  return isPlainObject(delegate) && typeof delegate[PROMPT_TEMPLATE_ID_KEY] === 'string' ? delegate : null;
}

function readBinding(node: WorkflowGraphNode): NodePromptBinding | null {
  const config = bindingHolder(node) ?? {};
  const templateId = config[PROMPT_TEMPLATE_ID_KEY];
  if (typeof templateId !== 'string' || templateId.length === 0) return null;

  const pinned = config[PROMPT_VERSION_NUMBER_KEY];
  return {
    nodeId: node.id,
    nodeType: node.type,
    promptTemplateId: templateId,
    pinnedVersionNumber: typeof pinned === 'number' && Number.isInteger(pinned) && pinned > 0 ? pinned : null,
  };
}

/**
 * Every prompt binding in a graph, in authored node order.
 *
 * Keyed off the presence of `promptTemplateId` rather than off a list of node
 * TYPES. A type allow-list would silently miss the next generation node someone
 * adds to the registry, and missing one here means missing it in the
 * "new version available" surface too — i.e. a node quietly left behind on an
 * old prompt with nothing telling anyone.
 */
export function collectPromptBindings(graph: WorkflowGraph | null | undefined): NodePromptBinding[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.map(readBinding).filter((binding): binding is NodePromptBinding => binding !== null);
}

/**
 * A copy of `graph` with ONE node's pin moved. Pure: the input is never
 * mutated, because the caller holds the persisted entity's graph and a
 * half-applied mutation on a failed transaction would leave the in-memory row
 * disagreeing with the database.
 *
 * Returns null when the node does not exist or carries no `promptTemplateId` —
 * the caller turns that into a 400 rather than silently writing a pin onto a
 * node that has nothing to pin.
 */
export function withMovedPin(graph: WorkflowGraph, nodeId: string, versionNumber: number): WorkflowGraph | null {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const target = nodes.find((node) => node.id === nodeId);
  if (!target || !readBinding(target)) return null;

  // The pin is written back WHERE the binding was read (see `bindingHolder`). Writing it at the
  // top level of a `core.action` would put a key its `additionalProperties: false` schema refuses,
  // so the next publish of a re-pinned node would fail validation.
  const repin = (node: WorkflowGraphNode): WorkflowGraphNode => {
    const config = isPlainObject(node.config) ? node.config : {};
    if (typeof config[PROMPT_TEMPLATE_ID_KEY] === 'string') {
      return { ...node, config: { ...config, [PROMPT_VERSION_NUMBER_KEY]: versionNumber } };
    }
    const delegate = isPlainObject(config.action) ? config.action : {};
    return { ...node, config: { ...config, action: { ...delegate, [PROMPT_VERSION_NUMBER_KEY]: versionNumber } } };
  };

  return { ...graph, nodes: nodes.map((node) => (node.id === nodeId ? repin(node) : node)) };
}

/**
 * sha256 over the canonical JSON of the two fields a `PromptVersion` row
 * actually snapshots — `content` and `variables`.
 *
 * This is what makes ADOPTING an unchanged prompt a pure pin move instead of an
 * authoring act. DD-11's PATH 2 deliberately leaves node pins where
 * they are when a template is edited out of band, so adoption is the COMMON
 * path — and before this guard every adoption minted a byte-identical version
 * row, filling the very version list an admin opens to understand what changed.
 *
 * `variables` is part of the digest because a variables-only change is a real
 * change: the mint path persists `dto.variables ?? template.variables` onto the
 * new row, so a checksum over `content` alone would swallow it.
 *
 * `canonicalJson` sorts object keys and PRESERVES array order, so re-serialised
 * variables ( `{b,a}` vs `{a,b}`) compare equal while a reordered list — which
 * is a real edit — does not. The same primitive drives `graphChecksum` here and
 * the context-schema republish guard, deliberately: two digest implementations
 * eventually disagree about whether anything changed.
 */
export function promptContentChecksum(content: string | null | undefined, variables: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ content: content ?? '', variables: variables ?? null }))
    .digest('hex');
}
