/**
 * TASK-890 black-box J4-F3 — how a node is NAMED in the console.
 *
 * Every Studio surface named a node by its type alone, so a graph with three `core.agent` nodes
 * showed three identical canvas headers, three identical list rows and three indistinguishable
 * "Connect to…" options; picking the right one was guesswork. One helper, used by all of them,
 * so the canvas, the list and the edge picker can never disagree about what a node is called.
 *
 * The name is the AUTHORED label when there is one (`config.label`, then `config.name` — the two
 * keys the core node schemas use for a human title), else the humanized type plus a short slice
 * of the node id. The id slice is not decoration: it is the only stable thing that distinguishes
 * two unlabelled siblings, and it is the same id the validation findings quote (`node "…"`).
 */
import { humanizeKey } from './schema-form';

/**
 * A short, stable tail of a node id — enough to tell siblings apart without printing a UUID.
 * `node_` is the store's own generator prefix and carries no information.
 */
export function shortNodeId(id: string): string {
  const bare = id.replace(/^node_/, '');
  return bare.length <= 8 ? bare : bare.slice(-6);
}

/** The one display name for a node, everywhere in the Studio. */
export function nodeDisplayName(node: { id: string; type: string; config?: Record<string, unknown> }): string {
  for (const key of ['label', 'name'] as const) {
    const authored = node.config?.[key];
    if (typeof authored === 'string' && authored.trim().length > 0) return authored.trim();
  }
  return `${humanizeKey(node.type)} · ${shortNodeId(node.id)}`;
}
