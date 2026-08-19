/**
 * Atomic selectors over `GraphStore` (TASK-719 Task 11) — kept out of the components that use
 * them so canvas, list editor, palette rail and validation rail all read the same derivations.
 */
import type { WorkflowFinding } from '../api/types';
import type { GraphStore } from './create-graph-store';
import type { GraphStoreNode } from './types';

export const selectNodes = (state: GraphStore): GraphStoreNode[] => state.nodes;
export const selectEdges = (state: GraphStore) => state.edges;
export const selectSelectedNodeId = (state: GraphStore) => state.selectedNodeId;
export const selectViewMode = (state: GraphStore) => state.viewMode;
export const selectDirty = (state: GraphStore) => state.dirty;
export const selectAutosaveState = (state: GraphStore) => state.autosaveState;

export function selectSelectedNode(state: GraphStore): GraphStoreNode | null {
  return state.nodes.find((node) => node.id === state.selectedNodeId) ?? null;
}

export function selectIsMandatory(nodeId: string) {
  return (state: GraphStore): boolean => {
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    return node ? node.safetyClasses.includes('mandatory') : false;
  };
}

/** Groups a server `ValidationReport`'s findings by `nodeId` — `null` (graph-level) findings
 *  are kept under the `null` key so the validation rail (Task 14) can render a graph-level
 *  bucket distinct from per-node groups. */
export function findingsByNodeId(findings: readonly WorkflowFinding[]): Map<string | null, WorkflowFinding[]> {
  const map = new Map<string | null, WorkflowFinding[]>();
  for (const finding of findings) {
    const bucket = map.get(finding.nodeId) ?? [];
    bucket.push(finding);
    map.set(finding.nodeId, bucket);
  }
  return map;
}

/** Undo/redo availability — the toolbar buttons and the Ctrl/Cmd+Z shortcut both read these, so
 *  a disabled button and a no-op shortcut can never disagree. */
export const selectCanUndo = (state: GraphStore): boolean => state.undoStack.length > 0;
export const selectCanRedo = (state: GraphStore): boolean => state.redoStack.length > 0;
