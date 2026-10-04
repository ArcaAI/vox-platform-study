/**
 * The Test tab's Flow overlay (TASK-1036 §10.2): per-step run state for the composer canvas,
 * which links have carried data, and each step's run warnings.
 *
 * LINKS. `@arcaai/ui`'s `WorkflowEdge` strokes with `var(--workflow-canvas-edge)` and exposes no
 * per-edge state, so a lit link is re-coloured by overriding that token on React Flow's own edge
 * group (`.react-flow__edge[data-id]`), scoped to this canvas. The active link's dash animation
 * lives inside `@media (prefers-reduced-motion: no-preference)`, so it never runs for a viewer who
 * asked for less motion. A first-class `WorkflowCanvasEdge.runState` in `packages/ui` would
 * replace this sheet (reported to the orchestrator; `packages/ui` is outside this lane).
 */
import type { WorkflowCanvasRunState } from '@arcaai/ui/components/workflow-canvas';
import type { NodeView, RunView } from '@/shared/sandbox/api/run-fold';
import type { WorkflowFinding } from '../../../api/types';

export type EdgeRunState = 'done' | 'active';

const CANVAS_STATE: Record<NodeView['status'], WorkflowCanvasRunState> = {
  waiting: 'pending',
  running: 'running',
  completed: 'ok',
  degraded: 'ok',
  failed: 'failed',
  skipped: 'skipped',
};

const DONE: ReadonlySet<NodeView['status']> = new Set(['completed', 'degraded', 'skipped']);

/** Per-node canvas run state. Empty before a run: the canvas then shows no run chips at all. */
export function flowRunStates(nodes: ReadonlyArray<{ id: string }>, view: RunView): Map<string, { state: WorkflowCanvasRunState; durationMs?: number }> {
  const states = new Map<string, { state: WorkflowCanvasRunState; durationMs?: number }>();
  if (view.status === 'IDLE') return states;
  for (const node of nodes) {
    const run = view.nodes[node.id];
    if (!run) {
      states.set(node.id, { state: 'pending' });
      continue;
    }
    states.set(node.id, { state: CANVAS_STATE[run.status], ...(run.durationMs !== undefined && run.status !== 'running' ? { durationMs: run.durationMs } : {}) });
  }
  return states;
}

/** A link is `done` once its source finished, `active` while its target is the step running on that data. */
export function edgeRunStates(edges: ReadonlyArray<{ id: string; source: string; target: string }>, view: RunView): Map<string, EdgeRunState> {
  const states = new Map<string, EdgeRunState>();
  for (const edge of edges) {
    const source = view.nodes[edge.source];
    if (!source || !DONE.has(source.status)) continue;
    states.set(edge.id, view.nodes[edge.target]?.status === 'running' ? 'active' : 'done');
  }
  return states;
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

/**
 * The scoped sheet that lights the links (and pulses the running step's chip). Tokens only — never
 * a raw colour; every animation sits behind `prefers-reduced-motion: no-preference`.
 */
export function edgeStyleSheet(scopeId: string, states: ReadonlyMap<string, EdgeRunState>, options: { pulseRunning?: boolean } = {}): string {
  const scope = `[data-test-flow="${cssString(scopeId)}"]`;
  const lit: string[] = [];
  const moving: string[] = [];
  for (const [edgeId, state] of states) {
    const selector = `${scope} .react-flow__edge[data-id="${cssString(edgeId)}"]`;
    lit.push(`${selector}{--workflow-canvas-edge:var(${state === 'active' ? '--primary' : '--success'});}`);
    if (state === 'active') moving.push(`${selector} .react-flow__edge-path{stroke-dasharray:6 5;animation:test-flow-dash 0.8s linear infinite;}`);
  }
  if (moving.length > 0) moving.push('@keyframes test-flow-dash{to{stroke-dashoffset:-22;}}');
  if (options.pulseRunning) moving.push(`${scope} [data-run-state="running"]{animation:test-flow-pulse 1s ease-in-out infinite;}@keyframes test-flow-pulse{50%{opacity:0.45;}}`);
  const motion = moving.length > 0 ? `@media (prefers-reduced-motion: no-preference){${moving.join('')}}` : '';
  return `${lit.join('')}${motion}`;
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
