/**
 * The graph-editing store's own node/edge model (TASK-719 Task 11). Deliberately the SAME
 * shape `@arcaai/ui`'s `WorkflowCanvasNode`/`WorkflowCanvasEdge` expect (minus the
 * validation-report-derived `problem`, which is computed by a selector, never stored) — canvas
 * and list editor render off one store, so there is exactly one node/edge model to keep in
 * sync, not two.
 */

export interface GraphStoreNode {
  id: string;
  /** Registry node `type`. */
  type: string;
  /** Client-side canvas layout — NOT part of the server `WorkflowGraphNode` shape (see
   *  `lib/graph-serialization.ts`). */
  position: { x: number; y: number };
  /** Open set of registry-declared classes (e.g. `['mandatory']`). A node is mandatory iff
   *  `'mandatory'` is a member — see `contracts/registry.contract.md`. */
  safetyClasses: readonly string[];
  config: Record<string, unknown>;
}

export interface GraphStoreEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export type WorkflowStudioViewMode = 'canvas' | 'list';
export type AutosaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export interface ConnectRequest {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/** Result of an action a caller must be able to refuse gracefully (never a thrown exception —
 *  both editors render the reason inline, e.g. "cannot delete a mandatory node"). */
export type ActionResult = { ok: true } | { ok: false; reason: string };
