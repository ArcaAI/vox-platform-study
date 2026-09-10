import { Global, Module } from '@nestjs/common';
import { CommonServiceModule, HarnessInternalServiceModule, IWorkflowRunCompletionPort, WorkflowRunServiceModule } from '@arcaai/applications';
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
 */
@Global()
@Module({
  imports: [CommonServiceModule, WorkflowRunServiceModule, HarnessInternalServiceModule],
  providers: [WorkflowRunCompletionService, { provide: IWorkflowRunCompletionPort, useExisting: WorkflowRunCompletionService }],
  exports: [WorkflowRunCompletionService, IWorkflowRunCompletionPort],
})
export class WorkflowRunCompletionModule {}
