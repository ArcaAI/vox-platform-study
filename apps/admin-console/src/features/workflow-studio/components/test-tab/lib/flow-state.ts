/**
 * The Test tab's Flow overlay (TASK-1036 §10.2): per-step run state for the composer canvas, which
 * links have carried data, and each step's run warnings. The canvas draws all of it (`@arcaai/ui`
 * `WorkflowCanvas`: node run chip + pulse, per-link `runState`), so this module only decides WHAT
 * each step and link is.
 */
import type { WorkflowCanvasEdgeRunState, WorkflowCanvasRunState } from '@arcaai/ui/components/workflow-canvas';
import type { NodeView, RunView } from '@/shared/sandbox/api/run-fold';
import type { WorkflowFinding } from '../../../api/types';
import { edgeRunStatesFrom, type RunOverlayEntry, type StepPhase } from '../../canvas/run-overlay';

export type EdgeRunState = Exclude<WorkflowCanvasEdgeRunState, 'idle'>;

const CANVAS_STATE: Record<NodeView['status'], WorkflowCanvasRunState> = {
  waiting: 'pending',
  running: 'running',
  completed: 'ok',
  degraded: 'ok',
  failed: 'failed',
  skipped: 'skipped',
};

const DONE: ReadonlySet<NodeView['status']> = new Set(['completed', 'degraded', 'skipped']);

function phaseOf(view: RunView, nodeId: string): StepPhase {
  const status = view.nodes[nodeId]?.status;
  return status === 'running' ? 'running' : status && DONE.has(status) ? 'done' : 'idle';
}

/** Per-node canvas run state. Empty before a run: the canvas then shows no run chips at all. */
export function flowRunStates(nodes: ReadonlyArray<{ id: string }>, view: RunView): Map<string, RunOverlayEntry> {
  const states = new Map<string, RunOverlayEntry>();
  if (view.status === 'IDLE') return states;
  for (const node of nodes) {
    const run = view.nodes[node.id];
    if (!run) {
      states.set(node.id, { state: 'pending' });
      continue;
    }
    const warnings = nodeWarningCount(run);
    states.set(node.id, {
      state: CANVAS_STATE[run.status],
      ...(run.durationMs !== undefined && run.status !== 'running' ? { durationMs: run.durationMs } : {}),
      ...(warnings > 0 ? { warnings } : {}),
    });
  }
  return states;
}

/** A link is `done` once its source finished, `active` while its target is the step running on that data. */
export function edgeRunStates(edges: ReadonlyArray<{ id: string; source: string; target: string }>, view: RunView): Map<string, EdgeRunState> {
  return edgeRunStatesFrom(edges, (nodeId) => phaseOf(view, nodeId));
}

/** How many things in this step's run deserve a look (never double-counting the producer's own count). */
export function nodeWarningCount(node: NodeView): number {
  const derived =
    node.bindingWarnings.length + node.guardrails.filter((check) => check.action !== 'ALLOW').length + node.outputChecks.filter((check) => !check.valid).length;
  return Math.max(node.warnings, derived);
}

/** Run warnings as canvas findings, so a step shows its warning count on the Flow. */
export function runWarningFindings(view: RunView): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  for (const nodeId of view.nodeOrder) {
    const node = view.nodes[nodeId]!;
    const total = nodeWarningCount(node);
    if (total === 0) continue;
    const first = node.bindingWarnings[0];
    findings.push({
      ruleId: 'test-run-warning',
      ruleClass: 'invariant',
      severity: 'WARNING',
      nodeId,
      message: `This run: ${total} warning${total === 1 ? '' : 's'}${first ? ` — ${first.input}: ${first.message}` : '.'}`,
    });
  }
  return findings;
}
