/**
 * The run overlay on the composer canvas (TASK-1036 F2): which step is waiting / running / done,
 * and which links carried data. One rule for both the Test tab's live Flow and the Composer's view
 * of the latest run, so a link can never read "done" in one place and "idle" in the other.
 */
import type { WorkflowCanvasEdgeRunState, WorkflowCanvasRunState } from '@arcaai/ui/components/workflow-canvas';
import type { NodeLastRunData } from '../inspector/last-run-tab';

export interface RunOverlayEntry {
  state?: WorkflowCanvasRunState;
  durationMs?: number;
  warnings?: number;
}

/** A step's phase for link purposes: finished (done / degraded / skipped), running, or neither. */
export type StepPhase = 'done' | 'running' | 'idle';

/** A link is `done` once its source finished, `active` while its target is the step running on that data. */
export function edgeRunStatesFrom(
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  phaseOf: (nodeId: string) => StepPhase,
): Map<string, Exclude<WorkflowCanvasEdgeRunState, 'idle'>> {
  const states = new Map<string, Exclude<WorkflowCanvasEdgeRunState, 'idle'>>();
  for (const edge of edges) {
    if (phaseOf(edge.source) !== 'done') continue;
    states.set(edge.id, phaseOf(edge.target) === 'running' ? 'active' : 'done');
  }
  return states;
}

const LAST_RUN_STATE: Record<string, WorkflowCanvasRunState> = {
  WAITING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'ok',
  DEGRADED: 'ok',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};
const LAST_RUN_DONE: ReadonlySet<string> = new Set(['SUCCEEDED', 'DEGRADED', 'SKIPPED']);

/** The Composer's overlay from the latest Test run's per-step feed (`useNodeLastRuns`). */
export function runOverlayFromLastRuns(
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  lastRuns: Readonly<Record<string, NodeLastRunData>>,
): { runStates: Map<string, RunOverlayEntry>; edgeRunStates: Map<string, Exclude<WorkflowCanvasEdgeRunState, 'idle'>> } {
  const runStates = new Map<string, RunOverlayEntry>();
  for (const [nodeId, run] of Object.entries(lastRuns)) {
    const state = LAST_RUN_STATE[run.status];
    if (!state) continue;
    runStates.set(nodeId, { state, ...(run.durationMs !== null && run.status !== 'RUNNING' ? { durationMs: run.durationMs } : {}) });
  }
  const phaseOf = (nodeId: string): StepPhase => {
    const status = lastRuns[nodeId]?.status;
    return status === 'RUNNING' ? 'running' : status && LAST_RUN_DONE.has(status) ? 'done' : 'idle';
  };
  return { runStates, edgeRunStates: edgeRunStatesFrom(edges, phaseOf) };
}
