/**
 * The interpreter's `workflow.run.completed` status vocabulary → the run read model's.
 *
 * Moved here from `apps/api/src/modules/workflows/workflow-run-completion.service.ts` (TASK-864
 * introduced it there first) so that BOTH surfaces that read an interpreter status — the
 * background completion watcher's `recordTerminal` and `WorkflowExposureService.getRunStatus`'s
 * live read — fold through the exact same function. Applications must never import `apps/api`,
 * so the fold lives here and the api service imports it.
 */
export function terminalStatusOf(status: unknown): 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT' | null {
  switch (status) {
    case 'SUCCEEDED':
    case 'DEGRADED':
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    default:
      return null;
  }
}
