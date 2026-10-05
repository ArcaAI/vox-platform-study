/**
 * How a node is NAMED in the console — one helper, used by every Studio surface (the canvas card
 * and its accessible name, the Problems panel, the Test tab, edge labels, pins, the inspector, the
 * binding picker), so no two of them can disagree about what a step is called.
 *
 * TASK-890 J4-F3: a graph with three `core.agent` nodes showed three identical names, so a name
 * must tell siblings apart. TASK-1036 (owner, 2026-10-05): it must also be HUMAN. The old fallback
 * — the humanized type plus an id slice, "Core.trigger · n_trigger" — read as debug output. A name
 * is now, in order:
 *
 *  1. the AUTHORED label (`config.label`, then `config.name` — the two keys the core node schemas
 *     use for a human title);
 *  2. an agent step: the agent's display NAME from the catalogue the Studio already loads
 *     (`GET admin/agents`), else its slug in words ("realtime-transcription" → "Realtime
 *     transcription"), else "Agent" while none is chosen;
 *  3. an action step: the action's own catalogue label (`ACTION_CATALOGUE`), else "Action";
 *  4. any other step: a friendly per-type title (`NODE_TYPE_TITLES`). The node registry carries
 *     no human title of its own (its schema `title`s are technical), so the titles live here; a
 *     test pins one for every `CORE_NODE_TYPES` entry, so a new core type cannot reach a card raw.
 *
 * Two steps that would share a name are told apart with " 2", " 3" in CANVAS order — the order of
 * the graph's node list, which is the order steps were added, so moving a node never renumbers it.
 * The raw node id never appears in a name: it is the stored reference (bindings, edges, findings)
 * and is shown only as the inspector's muted, copyable ID detail.
 */
import { ACTION_CATALOGUE } from '@arcaai/workflow-contract';
import { humanizeKey } from './schema-form';

/** The friendly title of each core node type (registry key → words). */
export const NODE_TYPE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  'core.trigger': 'Start',
  'core.agent': 'Agent',
  'core.classify': 'Classify',
  'core.humanReview': 'Review',
  'core.variable': 'Set variables',
  'core.condition': 'Condition',
  'core.loop': 'Loop',
  'core.note': 'Note',
  'core.output': 'Output',
  'core.data': 'Map fields',
  'core.action': 'Action',
});

/** Sentence case: first letter up, the rest as written ("send Letter" → "Send letter"). */
function sentenceCase(words: string): string {
  const trimmed = words.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/** A node type in words: its title when it has one, else its last segment humanized (`vendor.sendLetter` → "Send letter"). */
export function nodeTypeTitle(type: string): string {
  const title = NODE_TYPE_TITLES[type];
  if (title) return title;
  const segment = type.slice(type.lastIndexOf('.') + 1);
  return sentenceCase(humanizeKey(segment)) || type;
}

/** A slug in words: `realtime-transcription` → "Realtime transcription". */
export function humanizeSlug(slug: string): string {
  return sentenceCase(slug.replace(/[-_.]+/g, ' '));
}

/** What the Studio knows beyond the graph that helps name a step: the agents' display names, by slug. */
export interface NodeNaming {
  agentNames?: Readonly<Record<string, string>>;
}

/** The naming context from the agent catalogue (`GET admin/agents`). */
export function agentNamesOf(agents: readonly { slug: string; name?: string | null }[] | undefined): NodeNaming {
  const agentNames: Record<string, string> = {};
  for (const agent of agents ?? []) {
    if (typeof agent.name === 'string' && agent.name.trim()) agentNames[agent.slug] = agent.name.trim();
  }
  return { agentNames };
}

interface NamedNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

/** The agent slug a `core.agent` step references (`config.agentRef.slug`). */
export function agentSlugOfNode(node: Pick<NamedNode, 'config'>): string | undefined {
  const ref = node.config?.agentRef;
  const slug = ref && typeof ref === 'object' && !Array.isArray(ref) ? (ref as Record<string, unknown>).slug : undefined;
  return typeof slug === 'string' && slug.trim() ? slug.trim() : undefined;
}

/** A step's name before it is told apart from its siblings — what an UNNAMED step of this kind is called. */
export function nodeBaseName(node: NamedNode, naming?: NodeNaming): string {
  for (const key of ['label', 'name'] as const) {
    const authored = node.config?.[key];
    if (typeof authored === 'string' && authored.trim().length > 0) return authored.trim();
  }
  return nodeKindName(node, naming);
}

/** What the step IS, ignoring any authored label: the agent's name, the action's label, or the type's title. */
export function nodeKindName(node: NamedNode, naming?: NodeNaming): string {
  if (node.type === 'core.agent') {
    const slug = agentSlugOfNode(node);
    if (slug) return naming?.agentNames?.[slug] ?? humanizeSlug(slug);
  }
  if (node.type === 'core.action') {
    const key = node.config?.actionKey;
    const label = typeof key === 'string' ? ACTION_CATALOGUE[key]?.label : undefined;
    if (label) return label;
  }
  return nodeTypeTitle(node.type);
}

/**
 * One display name per node, unique within the graph: a repeated name gets " 2", " 3" in canvas
 * (list) order, skipping any number another step already uses as its name. Keyed by node id, in
 * the graph's order.
 */
export function nodeDisplayNames(nodes: readonly NamedNode[], naming?: NodeNaming): Map<string, string> {
  const bases = nodes.map((node) => nodeBaseName(node, naming));
  const taken = new Set(bases);
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  nodes.forEach((node, index) => {
    const base = bases[index] as string;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count === 1) {
      names.set(node.id, base);
      return;
    }
    let n = count;
    while (taken.has(`${base} ${n}`)) n += 1;
    const name = `${base} ${n}`;
    taken.add(name);
    seen.set(base, n);
    names.set(node.id, name);
  });
  return names;
}

/**
 * The one display name for a node, everywhere in the Studio. Pass the graph (`nodes`) wherever it
 * is at hand so a duplicate is numbered the same way on every surface; without it the name is the
 * step's own (un-numbered) one.
 */
export function nodeDisplayName(node: NamedNode, nodes?: readonly NamedNode[], naming?: NodeNaming): string {
  if (nodes && nodes.some((candidate) => candidate.id === node.id)) return nodeDisplayNames(nodes, naming).get(node.id) as string;
  return nodeBaseName(node, naming);
}

/**
 * A short, stable tail of a node id — for the inspector's muted ID detail and diagnostics, never a
 * display name. `node_` is the store's own generator prefix and carries no information.
 */
export function shortNodeId(id: string): string {
  const bare = id.replace(/^node_/, '');
  // TASK-965 — an AUTHORED id (letters, underscores and dashes only, no digits: the seed's
  // `n_trigger` / `n_summary`) is shown whole; a GENERATED id (base-36 stamp, uuid) its stable tail.
  if (bare.length <= 8) return bare;
  if (bare.length <= 24 && !/\d/.test(bare)) return bare;
  return bare.slice(-6);
}
