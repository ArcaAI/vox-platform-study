import type { WorkflowCanvasNodeProblem } from '@arcaai/ui/components/workflow-canvas';
import type { RunNodeRollup, TrajectoryStepStatus, WorkflowNodeEventPayload } from '../api/types';

/**
 * Maps a run-time status onto the canvas's EXISTING error/warning "problem" border
 * mechanism (`workflow-node.tsx`'s `SEVERITY_BORDER`) — reused, not forked. That
 * mechanism ships only `ERROR`/`WARNING` severities (it was built for validation
 * findings), so there is no colored border for a successful node without a
 * `packages/ui` change; an OK/STARTED/SKIPPED node keeps the canvas's neutral
 * border and relies on `NodeRunBadge`'s colored, icon+text status pill instead
 * (rule 11 §7: never color alone — 's note on this tradeoff).
 */
export function problemForStatus(status: TrajectoryStepStatus, errorCode: string | null, reason?: string): WorkflowCanvasNodeProblem | undefined {
  const upper = status.toUpperCase();
  if (upper === 'ERROR') {
    return { severity: 'ERROR', messages: [reason || (errorCode ? `Error: ${errorCode}` : 'This node failed.')] };
  }
  if (upper === 'TIMEOUT') {
    return { severity: 'WARNING', messages: [reason || 'This node timed out.'] };
  }
  return undefined;
}

export function problemForRollup(rollup: Pick<RunNodeRollup, 'status' | 'errorCode'>): WorkflowCanvasNodeProblem | undefined {
  return problemForStatus(rollup.status, rollup.errorCode);
}

/** Same mapping for a LIVE control-event payload (exact `nodeId`, no rollup yet). */
export function problemForLiveNode(payload: Pick<WorkflowNodeEventPayload, 'status' | 'reason'>): WorkflowCanvasNodeProblem | undefined {
  if (!payload.status) return undefined;
  return problemForStatus(payload.status, null, payload.reason);
}
