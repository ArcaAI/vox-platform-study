/**
 * TASK-946 D3 — the applications-side seam onto the gateway's run-completion watcher.
 *
 * The watcher itself (`WorkflowRunCompletionService`, `apps/api/src/modules/workflows/`) is an
 * api-layer concern: it holds a Redis connection and a blocking `XREAD` on the run's event
 * stream. `ConsultationWorkflowDispatchService` lives in this package, which must never import
 * `apps/api`, so the dispatcher names the CAPABILITY here and the gateway supplies the
 * implementation (`useExisting`) through a `@Global()` module.
 *
 * Why this exists at all: until now the watcher was attached ONLY by the workflows-plane
 * `POST /workflows/{slug}/runs` controller. A consultation-dispatched run therefore had no
 * consumer for its terminal `workflow.run.completed` event, so the `WorkflowRun` row stayed
 * `RUNNING` forever and the consultation stayed `DRAINING` until the 24h timeout sweep — the
 * measured 2026-09-10 failure (16 consultations, every one of them stuck).
 *
 * `@Optional()` at every injection site by design: a Nest context built without the gateway
 * module (unit fixtures, the applications package's own DI tests) degrades to the pre-existing
 * "reconciled by the next status read" behaviour rather than failing to construct.
 */
export const IWorkflowRunCompletionPort = Symbol('IWorkflowRunCompletionPort');

export interface IWorkflowRunCompletionPort {
  /**
   * Attach a background watcher for `runId`, so its terminal status reaches the read model
   * without a reader. Idempotent per run; NEVER throws; returns whether one is now attached
   * (`false` when the transport is unconfigured or the per-process watcher cap is reached —
   * both non-fatal, both reconciled by the next status read).
   */
  watch(tenantId: string, runId: string, consultationId?: string | null): boolean;
}
