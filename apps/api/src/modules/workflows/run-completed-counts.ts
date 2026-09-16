/**
 * TASK-982 §3.4.5 — the `workflow.run.completed` settled-node counts, and the CONSUMER half of
 * the cross-language contract (`tests/contracts/workflow-run-completed.fixture.json`; the
 * producer half is `apps/harness/.../interpreter/activities.py::_envelope_for`).
 *
 * A leaf module deliberately: no NestJS decorators, no `ioredis`/`nestjs-cls`/`@arcaai/*` imports
 * — only plain functions and types, so the root-level contract test can import it directly
 * without dragging in `WorkflowRunCompletionService`'s whole dependency graph.
 */

/**
 * The four optional settled-node counts the interpreter's `workflow.run.completed` payload can
 * carry alongside `status`. All optional: an older interpreter build, or a payload that failed to
 * parse a field, reports nothing rather than a fabricated zero.
 */
export interface RunCompletedCounts {
  nodeCount?: number;
  failedNodeCount?: number;
  degradedNodeCount?: number;
  skippedNodeCount?: number;
}

function readCount(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Extract the four settled-node counts from a `workflow.run.completed` envelope's payload. */
export function runCompletedCountsFromPayload(payload: Record<string, unknown> | undefined): RunCompletedCounts {
  return {
    nodeCount: readCount(payload, 'nodeCount'),
    failedNodeCount: readCount(payload, 'failedNodeCount'),
    degradedNodeCount: readCount(payload, 'degradedNodeCount'),
    skippedNodeCount: readCount(payload, 'skippedNodeCount'),
  };
}
