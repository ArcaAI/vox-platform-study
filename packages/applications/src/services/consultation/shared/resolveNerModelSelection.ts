import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IActiveUserContext } from '../../../interfaces';
import { IAiTaskDefaultService } from '../../ai-task-default/IAiTaskDefaultService';

/** The AiTaskDefault key clinical NER routes through (SUPER_ADMIN-only, SYSTEM-row resolution only). */
export const NLP_NER_TASK_KEY = 'nlp.ner';

/**
 * Resolve the effective `nlp.ner` model for injection into a clinical
 * `/api/v1/classify/tokens` call — the SAME resolution `AiInferenceController`
 * (`apps/api/src/modules/ai-inference/ai-inference.controller.ts`) applies to
 * the Agent-Playground NER tab. Without this, a super admin re-pointing
 * `nlp.ner` only changes the playground; every clinical NER caller keeps
 * silently using the NLP service's env default. Shared by the two clinical
 * callers: `summary.service.ts` (synchronous extract-entities) and
 * `live-tool-registry.ts`'s `NlpExtractionTool` (the live plane's NER tool).
 *
 * FAIL-CLOSED, matching `AiInferenceController.resolveDefaultModelSelection`
 * and model SELECTION platform-wide: an unresolved key (service not wired, no
 * CLS scope, resolver error, no ENABLED model) throws
 * `ServiceUnavailableException` NAMING the key. This branch used to fail-OPEN
 * — return `{}` and let the NLP service apply its own env default — but that
 * fallback no longer exists: `POST /api/v1/classify/tokens` now REQUIRES
 * `model_name` and answers 503 without it
 * (`apps/nlp/src/nlp/api/v1/rest/classify.py`), and the env-owned model id was
 * removed. Fail-open therefore produced the SAME failure one hop later,
 * attributed to the NLP service instead of to the unresolved key.
 *
 * SYSTEM-PIN — `nlp.*` is SUPER_ADMIN_ONLY (system-row-only resolution;
 * `isSuperAdminOnlyTaskKey('nlp.ner')` in `ai-task-default/constants.ts`), but
 * the three callers run in worker/event/in-request contexts whose ambient CLS
 * tenant is the CALLING tenant — or, in a service-token/event context, no
 * tenant at all. Reading a SYSTEM-only key must not depend on what that
 * ambient tenant happens to be. Pin the read to a NESTED CLS scope with
 * `tenantId=SYSTEM_TENANT_ID` for the duration of this call only — mirrors
 * `EffectiveConfigController`'s out-of-band CLS re-establishment (F-026). The
 * caller's own CLS scope (real tenant, real user) is restored the moment this
 * resolver returns: nestjs-cls's default `ifNested: 'inherit'` starts the
 * nested store from a COPY of the currently active one, so overwriting
 * `tenantId` inside the copy never touches the outer store the caller resumes
 * with, and Node's `AsyncLocalStorage` restores the outer store automatically
 * once the nested `run()` callback settles. An ABSENT `cls` is therefore a
 * refusal like any other: without a scope to pin, the SYSTEM read cannot be
 * established at all, and reading under the ambient tenant would be the very
 * cross-tenant leak the pin exists to prevent.
 *
 * @throws ServiceUnavailableException when `nlp.ner` cannot be resolved to an
 * ENABLED model.
 */
export async function resolveNerModelInjection(
  aiTaskDefaultService: IAiTaskDefaultService | undefined,
  cls: ClsService<IActiveUserContext> | undefined,
  logger: Logger,
): Promise<{ model_name: string }> {
  if (!aiTaskDefaultService) {
    throw new ServiceUnavailableException(`SYSTEM AiTaskDefault for '${NLP_NER_TASK_KEY}' is unavailable (AiTaskDefaultService not wired).`);
  }
  if (!cls) {
    throw new ServiceUnavailableException(
      `SYSTEM AiTaskDefault for '${NLP_NER_TASK_KEY}' is unavailable (no CLS scope to pin the SYSTEM-only read to).`,
    );
  }
  try {
    const effective = await cls.run(async () => {
      cls.set('tenantId', SYSTEM_TENANT_ID);
      return aiTaskDefaultService.getEffective(NLP_NER_TASK_KEY, SYSTEM_TENANT_ID);
    });
    const sourceUri = effective.model?.sourceUri;
    if (!sourceUri) {
      throw new ServiceUnavailableException(`SYSTEM AiTaskDefault for '${NLP_NER_TASK_KEY}' is missing or has no ENABLED model. Run db:seed.`);
    }
    return { model_name: sourceUri };
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    logger.warn({
      message: `AiTaskDefault '${NLP_NER_TASK_KEY}' resolution failed (fail-closed)`,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceUnavailableException(`SYSTEM AiTaskDefault for '${NLP_NER_TASK_KEY}' could not be resolved.`);
  }
}
