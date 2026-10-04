import { Global, Module } from '@nestjs/common';
import {
  CommonServiceModule,
  HarnessGatewayServiceModule,
  HarnessInternalServiceModule,
  IWorkflowRunCompletionPort,
  TenantSettingsService,
  WorkflowRunServiceModule,
} from '@arcaai/applications';
import { RunEventStreamHub } from './run-event-stream-hub';
import { WorkflowRunCompletionService } from './workflow-run-completion.service';

/**
 * `WorkflowRunCompletionModule` — TASK-946 D3.
 *
 * The watcher used to live in `WorkflowsModule` alongside the exposure-plane controllers, which
 * was fine while its only caller WAS that controller. It is not fine now: the second caller is
 * `ConsultationWorkflowDispatchService`, a provider in `@arcaai/applications` — a package that
 * must never import `apps/api`. So the watcher moves into its own module, binds itself to the
 * applications-side `IWorkflowRunCompletionPort` token, and that module is `@Global()` so any
 * provider anywhere in the graph can resolve the port with no import edge back into the gateway.
 *
 * `@Global()` is the narrow choice here, not the broad one: it exports exactly the watcher and
 * its port, rather than globalising `WorkflowsModule` (whose exports also include the streaming
 * service and whose controllers are mounted routes).
 *
 * `HarnessInternalServiceModule` supplies the consultation lifecycle's writer for OD-4
 * (`failGovernedRun`). It is `@Optional()` in the service, so a context without it degrades to
 * recording the run's terminal status only.
 *
 * TASK-1038 — this module also owns the process-wide `RunEventStreamHub` (R-1: ONE multiplexed
 * reader for every run stream) and exports it, so the SSE service (`WorkflowsModule`) and the
 * WebSocket gateway (`StreamingModule`) share the very instance the watcher reads through — one
 * blocking connection per process, not one per consumer. `HarnessGatewayServiceModule` supplies
 * the watcher's idle re-check (R-2); `TenantSettingsService` the delivery-plane knobs.
 */
@Global()
@Module({
  imports: [CommonServiceModule, WorkflowRunServiceModule, HarnessInternalServiceModule, HarnessGatewayServiceModule],
  providers: [
    TenantSettingsService,
    RunEventStreamHub,
    WorkflowRunCompletionService,
    { provide: IWorkflowRunCompletionPort, useExisting: WorkflowRunCompletionService },
  ],
  exports: [WorkflowRunCompletionService, IWorkflowRunCompletionPort, RunEventStreamHub],
})
export class WorkflowRunCompletionModule {}
