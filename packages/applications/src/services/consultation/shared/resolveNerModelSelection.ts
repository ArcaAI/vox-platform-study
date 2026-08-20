import { Logger } from '@nestjs/common';
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
 * silently using the NLP service's env default. Shared by the three clinical
 * callers: `ner.processor.ts` (durable BullMQ job), `summary.service.ts`
 * (synchronous extract-entities), `live-documentation.service.ts` (live plane).
 *
 * FAIL-OPEN — the deliberate OPPOSITE of the judge/TEXT routing lanes: a
 * resolver failure (service not wired, resolver error, no ENABLED model)
 * returns `{}` (no `model_name`) so the caller posts EXACTLY like it did
 * before this resolver existed — the NLP service falls back to its own env
 * default — rather than blocking clinical NER on a registry hiccup. A warning
 * is logged on every fallback path; this function never throws.
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
 * once the nested `run()` callback settles.
 */
export async function resolveNerModelInjection(
  aiTaskDefaultService: IAiTaskDefaultService | undefined,
  cls: ClsService<IActiveUserContext>,
  logger: Logger,
): Promise<{ model_name?: string }> {
  if (!aiTaskDefaultService) {
    return {};
  }
  try {
    const effective = await cls.run(async () => {
      cls.set('tenantId', SYSTEM_TENANT_ID);
      return aiTaskDefaultService.getEffective(NLP_NER_TASK_KEY, SYSTEM_TENANT_ID);
    });
    const sourceUri = effective.model?.sourceUri;
    if (!sourceUri) {
      logger.warn({
        message: `AiTaskDefault '${NLP_NER_TASK_KEY}' has no ENABLED model; posting to NLP without model_name (fail-open, NLP env default applies)`,
      });
      return {};
    }
    return { model_name: sourceUri };
  } catch (error) {
    logger.warn({
      message: `AiTaskDefault '${NLP_NER_TASK_KEY}' resolution failed; posting to NLP without model_name (fail-open, NLP env default applies)`,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
