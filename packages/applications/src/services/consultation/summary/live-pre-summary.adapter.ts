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
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { IActiveUserContext } from '../../../interfaces';
import { PRE_SUMMARY_DEGRADE_FALLBACK, degradeCode } from '../live-documentation/degrade-codes';
import type { ILivePreSummaryRunner, LivePreSummaryInput, LivePreSummaryResult } from '../live-documentation/live-pre-summary.port';
import {
  CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_DEFAULT,
  CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_KEY,
} from '../../settings-registry/descriptors/consultation-presummary.descriptors';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { SummaryService } from './summary.service';

/**
 * A registry-STORED numeric value, or `undefined` when the facade fell through to the code
 * default (so the caller's own default can win) or the stored value is unusable. Mirrors
 * `LiveDocumentationService`'s private `storedNumber` — same shape, same reason: a wrong-typed
 * stored value must never become `NaN` on the retry-count hot path.
 */
function storedNumber(result: { value: unknown; sourceScope: string }): number | undefined {
  if (result.sourceScope === 'code-default') return undefined;
  const parsed = Number(result.value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The PHI-safe reason for a failure, derived from the error's SHAPE rather than its message.
 *
 * A message can carry clinical text and this value is published on the clinician's live feed, so
 * only a short reason code ever leaves this function. `no_case_notes` is separated out because it
 * is the ordinary case, not a fault: a first-ever visit has no prior record to summarise, and the
 * console renders that differently from "the model timed out".
 *
 * TASK-946 D6(a) — it used to answer `error.name`, which put `AxiosError` on the clinician's feed:
 * a fact about the HTTP client, not about the consultation. The classification now lives in
 * {@link degradeCode}, shared with the flush, so the two surfaces cannot report the same failure
 * under two different names.
 */
function degradeReason(error: unknown): string {
  return degradeCode(error, PRE_SUMMARY_DEGRADE_FALLBACK);
}

@Injectable()
export class LivePreSummaryAdapter implements ILivePreSummaryRunner {
  private readonly logger = new Logger(LivePreSummaryAdapter.name);

  constructor(
    private readonly summaryService: SummaryService,
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
    // Optional for the same reason `LiveDocumentationService` treats it as such — a Nest context
    // without `EffectiveSettingsModule` wired still runs the warm start, on the code default.
    @Optional() private readonly effectiveSettings?: EffectiveSettingsService,
  ) {}

  async run(input: LivePreSummaryInput): Promise<LivePreSummaryResult> {
    const maxAttempts = 1 + (await this.resolveRetryAttempts(input.tenantId));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const generate = async (): Promise<LivePreSummaryResult> => {
          // `caseNoteIds` deliberately absent: the warm start summarises the WHOLE prior record
          // the consultation carries, which is what `findCaseNotes` returns. `dnaStyleId`
          // deliberately absent too — DNA is a FINALIZE-time concern (TASK-891 F-1 / TASK-932
          // D-10); a background summary of someone else's notes is not the clinician's own
          // writing.
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
        // TASK-982 §3.4.5 — ONE bounded retry loop, and only for the TRANSIENT class: a
        // `text_unavailable` failure (the TEXT service unreachable or 5xx) is exactly the kind a
        // second attempt might clear. Anything else — a schema/validation error, `no_case_notes`,
        // `context_overflow`, a timeout — is retried zero times: retrying a validation failure
        // wastes the budget on a call that will fail identically every time.
        if (reason === 'text_unavailable' && attempt < maxAttempts) {
          this.logger.warn({
            message: 'Warm-start pre-summary retrying after a transient failure',
            consultationId: input.consultationId,
            tenantId: input.tenantId,
            attempt,
            maxAttempts,
          });
          continue;
        }
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
    // Unreachable — the loop always returns from its try or its catch — but TypeScript cannot
    // see that a `for` loop with a `return` on every path always returns.
    return { status: 'degraded', reason: PRE_SUMMARY_DEGRADE_FALLBACK };
  }

  /**
   * STORED VALUE → descriptor code default (1) — the same precedence and the same
   * never-throws posture `LiveDocumentationService.resolveRealtimeBudgets` uses for its sibling
   * knobs: a settings-backend failure keeps the warm start at ONE retry rather than failing the
   * pre-summary the clinician is waiting for.
   */
  private async resolveRetryAttempts(tenantId: string): Promise<number> {
    if (!this.effectiveSettings) return CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_DEFAULT;
    try {
      const result = await this.effectiveSettings.resolveEffective(CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_KEY, { tenantId });
      return storedNumber(result) ?? CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_DEFAULT;
    } catch {
      return CONSULTATION_PRE_SUMMARY_RETRY_ATTEMPTS_DEFAULT;
    }
  }
}
