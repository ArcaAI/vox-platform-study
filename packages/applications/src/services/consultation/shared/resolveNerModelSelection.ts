import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IActiveUserContext } from '../../../interfaces';
import { IAiRoutingPolicyService } from '../../ai-routing-policy/IAiRoutingPolicyService';

/** The routing-policy task key clinical NER selects through (SUPER_ADMIN-only, SYSTEM-row resolution only). */
export const NLP_NER_TASK_KEY = 'nlp.ner';

/** The `_metadata` key the NER plane's configuration lives under. */
export const CLINICAL_TAXONOMY_METADATA_KEY = 'clinicalTaxonomy';

/** What the two clinical NER callers spread into the `/classify/tokens` body. */
export interface NerModelInjection {
  model_name: string;
  /** Present only when the selected row declares one — never an invented default. */
  clinical_taxonomy?: Record<string, unknown>;
}

/**
 * Pull `clinicalTaxonomy` off the registry row's `_metadata`, or `undefined`.
 *
 * Deliberately only a SHAPE check (a JSON object, not an array or a scalar):
 * validating the contents belongs to the executor that applies them, and a
 * gateway that silently dropped a section it did not recognise would make an
 * admin's stored value unreachable without saying so. A non-object is dropped
 * because it cannot be spread into a JSON body at all.
 */
function readClinicalTaxonomy(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const candidate = (metadata as Record<string, unknown>)[CLINICAL_TAXONOMY_METADATA_KEY];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  return candidate as Record<string, unknown>;
}

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
 * `isSuperAdminOnlyTaskKey('nlp.ner')` in `ai-routing-policy/constants.ts`, made
 * explicit here as `resolveDefault(…, { systemOnly: true })`), but
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
 * CLINICAL TAXONOMY — the same read also carries the NER
 * plane's configuration. `apps/nlp` used to hold an ontology vocabulary, vitals
 * plausibility bands, a ConText/NegEx trigger lexicon and its NER contract
 * (`TOKEN_CLASSIFIER_*` / `NLP_LINKER_*`) as Python literals and env fields;
 * rule 00 names a threshold, taxonomy or label set as neither. They now live on
 * `AiModel._metadata.clinicalTaxonomy` of the SELECTED row — beside
 * `labelTaxonomy`, which the guardrail plane already treats the same way — and
 * this resolver forwards the blob VERBATIM as `clinical_taxonomy`.
 *
 * Verbatim matters: normalising or merging here would make the effective
 * configuration a function of gateway code rather than of what the admin
 * stored, which is the "half-wired config that reads as done" this ticket
 * exists to remove. The executor validates the shape and declares its own fail
 * posture (`nlp/schemas/clinical_taxonomy.py`): an absent section DISABLES the
 * pass it governs, never substitutes a literal. So an unconfigured row omits the
 * field entirely — it never ships an invented default — while model SELECTION
 * stays fail-closed below.
 *
 * It rides on the SELECTION rather than on a settings-registry key because it
 * is a property OF THE CHECKPOINT (which labels it emits meaning "nothing", how
 * its subword pieces aggregate, which surface forms its NER produces); a knob
 * keyed by service name would drift from the model the moment an admin
 * re-points `nlp.ner`.
 *
 * @throws ServiceUnavailableException when `nlp.ner` cannot be resolved to an
 * ENABLED model.
 */
export async function resolveNerModelInjection(
  routingPolicies: IAiRoutingPolicyService | undefined,
  cls: ClsService<IActiveUserContext> | undefined,
  logger: Logger,
): Promise<NerModelInjection> {
  if (!routingPolicies) {
    throw new ServiceUnavailableException(`SYSTEM routing election for '${NLP_NER_TASK_KEY}' is unavailable (AiRoutingPolicyService not wired).`);
  }
  if (!cls) {
    throw new ServiceUnavailableException(
      `SYSTEM routing election for '${NLP_NER_TASK_KEY}' is unavailable (no CLS scope to pin the SYSTEM-only read to).`,
    );
  }
  try {
    const resolved = await cls.run(async () => {
      cls.set('tenantId', SYSTEM_TENANT_ID);
      return routingPolicies.resolveDefault(SYSTEM_TENANT_ID, NLP_NER_TASK_KEY, { systemOnly: true });
    });
    const sourceUri = resolved.model?.sourceUri;
    if (!sourceUri) {
      throw new ServiceUnavailableException(`SYSTEM routing election for '${NLP_NER_TASK_KEY}' is missing or names no ENABLED model. Run db:seed.`);
    }
    const clinicalTaxonomy = readClinicalTaxonomy(resolved.model?.metaData);
    return {
      model_name: sourceUri,
      ...(clinicalTaxonomy ? { clinical_taxonomy: clinicalTaxonomy } : {}),
    };
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    logger.warn({
      message: `Routing election '${NLP_NER_TASK_KEY}' resolution failed (fail-closed)`,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceUnavailableException(`SYSTEM routing election for '${NLP_NER_TASK_KEY}' could not be resolved.`);
  }
}
