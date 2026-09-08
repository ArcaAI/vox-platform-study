/**
 * TASK-932 D-9 — the implementation of {@link ILivePreSummaryRunner}, over `SummaryService`.
 *
 * It lives HERE, beside the pipeline it delegates to, rather than in `live-documentation/`: the
 * port is declared by the consumer and implemented by the owner, which is the same direction
 * `ILiveAgentResolver` / `live-agent-resolution.service.ts` already run in. That is also what
 * keeps the module graph acyclic — `LiveDocumentationServiceModule` imports this one, and nothing
 * under `SummaryServiceModule` imports the live documentation module.
 *
 * ## Why the CLS is re-established rather than inherited
 *
 * `SummaryService.generatePreSummary` reads its tenant and its user from CLS
 * (`BaseService.tenantId` / `requestUserId`), and this call is made from
 * `LiveDocumentationService.start()`, which is FIRE-AND-FORGET: the recording controller's
 * request may well have returned before the warm start finishes. An `AsyncLocalStorage` store
 * does survive into a promise created inside the request, so the inherited context would usually
 * be right — "usually" is not a tenancy guarantee, and tenant attribution is a security boundary
 * (`base.service.ts`: "`tenantId` is ALWAYS sourced from the CLS"). So the tenant and user are
 * passed EXPLICITLY and re-established here, the same `cls.run()` + `cls.set()` shape
 * `HarnessInternalService` and the four queue processors use for exactly this reason.
 *
 * The values are not caller input: they come off the `LiveSession`, which took them from the
 * authenticated recording-start request.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { IActiveUserContext } from '../../../interfaces';
import type { ILivePreSummaryRunner, LivePreSummaryInput, LivePreSummaryResult } from '../live-documentation/live-pre-summary.port';
import { SummaryService } from './summary.service';

/**
 * The PHI-safe reason for a failure, derived from the error's SHAPE rather than its message.
 *
 * A message can carry clinical text and this value is published on the clinician's live feed, so
 * only a short reason code ever leaves this function. `no_case_notes` is separated out because it
 * is the ordinary case, not a fault: a first-ever visit has no prior record to summarise, and the
 * console renders that differently from "the model timed out".
 */
function degradeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/no case notes/i.test(message)) return 'no_case_notes';
  if (error instanceof Error && error.name) return error.name;
  return 'pre_summary_failed';
}

@Injectable()
export class LivePreSummaryAdapter implements ILivePreSummaryRunner {
  private readonly logger = new Logger(LivePreSummaryAdapter.name);

  constructor(
    private readonly summaryService: SummaryService,
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
  ) {}

  async run(input: LivePreSummaryInput): Promise<LivePreSummaryResult> {
    try {
      const generate = async (): Promise<LivePreSummaryResult> => {
        // `caseNoteIds` deliberately absent: the warm start summarises the WHOLE prior record the
        // consultation carries, which is what `findCaseNotes` returns. `dnaStyleId` deliberately
        // absent too — DNA is a FINALIZE-time concern (TASK-891 F-1 / TASK-932 D-10); a
        // background summary of someone else's notes is not the clinician's own writing.
        const response = await this.summaryService.generatePreSummary(input.consultationId, {});
        const content = typeof response?.content === 'string' ? response.content : '';
        return content.trim().length > 0 ? { status: 'ready', content } : { status: 'degraded', reason: 'empty_pre_summary' };
      };

      if (!this.cls) return await generate();

      return await this.cls.run(async () => {
        this.cls!.set('tenantId', input.tenantId);
        if (input.userId) this.cls!.set('user', { id: input.userId } as never);
        return generate();
      });
    } catch (error) {
      const reason = degradeReason(error);
      this.logger.warn({
        message: 'Warm-start pre-summary degraded',
        consultationId: input.consultationId,
        tenantId: input.tenantId,
        agentSlug: input.agentSlug,
        reason,
      });
      return { status: 'degraded', reason };
    }
  }
}
