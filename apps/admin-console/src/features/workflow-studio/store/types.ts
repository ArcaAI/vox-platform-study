/**
 * The graph-editing store's own node/edge model. Deliberately the SAME
 * shape `@arcaai/ui`'s `WorkflowCanvasNode`/`WorkflowCanvasEdge` expect (minus the
 * validation-report-derived `problem`, which is computed by a selector, never stored) — the
 * canvas renders straight off this store, so there is exactly one node/edge model to keep in
 * sync, not two.
 */

export interface GraphStoreNode {
  id: string;
  /** Registry node `type`. */
  type: string;
  /** Client-authored canvas layout — mirrors the server `WorkflowGraphNode.position` field
   *  (see `lib/graph-serialization.ts`); always present in the store even for a node whose
   *  graph document carried no position (defaults to the origin on hydrate). For a node with a
   *  `parentId` this is RELATIVE to that group's origin (React Flow's own convention). */
  position: { x: number; y: number };
  /** Open set of registry-declared classes (e.g. `['mandatory']`). A node is mandatory iff
   *  `'mandatory'` is a member — see `contracts/registry.contract.md`. */
  safetyClasses: readonly string[];
  config: Record<string, unknown>;
  /** TASK-864: the enclosing `core.loop` (a group on the canvas); `position` is then relative to it. */
  parentId?: string;
}

export interface GraphStoreEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/**
 * TASK-893 §3.1 — the explicit Save/Discard state machine that replaces `AutosaveState`.
 *
 * `clean` = matches the last saved graph · `dirty` = unsaved edits the user can Save or Discard ·
 * `saving` = a PATCH is in flight · `saved` = the last explicit save succeeded · `conflict` = a
 * 412 on `If-Match` (the `OccConflictAlert` path; resolved only by an explicit user action) ·
 * `error` = any other failed save.
 *
 * There is no `idle`: a freshly hydrated graph is `clean`, which says the same thing truthfully.
 */
export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

export interface ConnectRequest {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/** Result of an action a caller must be able to refuse gracefully (never a thrown exception —
 *  the canvas and the toolbar render the reason inline, e.g. "cannot delete a mandatory node"). */
export type ActionResult = { ok: true } | { ok: false; reason: string };
