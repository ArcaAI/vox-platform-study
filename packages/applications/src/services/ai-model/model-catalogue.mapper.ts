import { AiModelEntity } from '@arcaai/domains';
import type { ProviderClass } from '../ai-provider-connection/constants';
import { MODEL_TASK_TYPE_TO_PIPELINE_TAG } from './constants';
import type { CatalogueModelResponse, ModelReadiness } from './dto/model-catalogue.response';

/** Everything the catalogue DECIDES about a row, as opposed to what the row itself carries. */
export interface CatalogueModelContext {
  providerId: string;
  providerClass: ProviderClass;
  readiness: ModelReadiness;
  readinessCheckedAt: Date | null;
  readinessDetail: string | null;
  usable: boolean;
  unusableReason: string | null;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * What an authoring form needs to know about a model, read the way the workflow
 * publish gate already reads it (`workflow-definition.service.ts:1807-1809`):
 * `_metadata.capabilities.<field>`, falling back to `_metadata.<field>` for the
 * rows seeded before the `capabilities` nesting.
 */
function capabilitiesOf(entity: AiModelEntity): CatalogueModelResponse['capabilities'] {
  const meta = asPlainObject(entity.metaData) ?? {};
  const caps = asPlainObject(meta.capabilities) ?? meta;
  const params = Array.isArray(caps.supportedGenerationParams) ? (caps.supportedGenerationParams as string[]) : undefined;
  const ssml = typeof caps.supportsSsml === 'boolean' ? caps.supportsSsml : undefined;
  return {
    ...(params ? { supportedGenerationParams: params } : {}),
    ...(ssml !== undefined ? { supportsSsml: ssml } : {}),
  };
}

/**
 * The TENANT projection of a catalogue row (TASK-890 §3.7).
 *
 * Built field by field ON PURPOSE. `ModelResponse` carries the platform's own
 * storage identity and operator trail — `bucketPrefix`, `primaryObject`,
 * `manifestDigest`, `checksum`, `sourceUri`, `wireModelId`, `createdBy`,
 * `updatedBy`, `tenantId` — none of which is a tenant's business and several of
 * which name where the weights live. A spread-then-delete would leak the next
 * field somebody adds; this cannot, and the key set is pinned by a unit test.
 */
export function toCatalogueModel(entity: AiModelEntity, context: CatalogueModelContext): CatalogueModelResponse {
  return {
    id: entity.id,
    slug: entity.slug,
    name: entity.name,
    description: entity.description ?? null,
    taskType: entity.taskType,
    pipelineTag: MODEL_TASK_TYPE_TO_PIPELINE_TAG[entity.taskType] ?? 'other',
    providerId: context.providerId,
    provider: entity.provider ?? null,
    providerClass: context.providerClass,
    deploymentKind: entity.deploymentKind,
    availability: entity.availability,
    readiness: context.readiness,
    readinessCheckedAt: context.readinessCheckedAt,
    readinessDetail: context.readinessDetail,
    capabilities: capabilitiesOf(entity),
    isPlatformDefaultFor: entity.isPlatformDefaultFor ?? [],
    resourceStatus: entity.resourceStatus,
    usable: context.usable,
    unusableReason: context.unusableReason,
  };
}
