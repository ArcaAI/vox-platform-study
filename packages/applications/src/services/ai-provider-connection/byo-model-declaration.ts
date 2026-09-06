import { BadRequestException } from '@nestjs/common';
import { AiDeploymentKind, AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType } from '@arcaai/domains';
import type { CreateAiModelProps } from '@arcaai/domains';
import { MODEL_TASK_TYPE_SERVICE, ProviderService } from './constants';

/**
 * TASK-890 §3.7a — the PURE half of "declare a BYO connection's models".
 *
 * A tenant that brings its own vendor account also brings the model ids that
 * account serves, and those ids have to become `AiModel` rows or nothing can
 * bind them (an agent stores `modelId`). This module decides WHAT such a row
 * looks like; `AiProviderConnectionService.declareModels` decides when to write
 * one. Nothing here does I/O, so the shape is testable without a database and
 * cannot drift between the write path and the projection.
 *
 * Two invariants worth stating, because both are load-bearing elsewhere:
 *
 *  1. **The slug is SERVER-generated and stable.** It is the tenant's routing
 *     key for that model forever (`resolveModelIdBySlugVisible`), so it is
 *     derived from facts the tenant already supplied — the connection's
 *     provider and the vendor wire id — never from a free-text field the
 *     tenant could change under a binding.
 *  2. **The row is CLOUD by construction.** A tenant plane owns no engine and
 *     stages no weights, so a tenant-owned `AiModel` row can only ever be its
 *     own vendor account (`providerClassOf` → `cloud-byo`). That is what lets
 *     the wire builder omit `deployment_name` for a candidate built from one:
 *     the ROW is the deployment.
 */

/**
 * The services a tenant may declare models under.
 *
 * Deliberately the three model-bearing INFERENCE capabilities, matching the
 * `servedBy` map below. `embeddings` / `rerank` / `vector` / `model-registry`
 * are excluded because no workload executes a per-tenant registry row for them
 * today — a declaration there would create a row nothing can route, which is
 * worse than a named refusal.
 */
export const BYO_DECLARABLE_SERVICES = ['llm', 'stt', 'tts'] as const;

export type ByoDeclarableService = (typeof BYO_DECLARABLE_SERVICES)[number];

export function isByoDeclarableService(service: ProviderService): service is ByoDeclarableService {
  return (BYO_DECLARABLE_SERVICES as readonly string[]).includes(service);
}

/**
 * The workload that EXECUTES a declared row (`AiModel.servedBy`). Cloud rows
 * are governed by the gateway and executed by the owning service, so they name
 * that service — the same rule the seeded cloud rows follow.
 */
const SERVED_BY: Record<ByoDeclarableService, string> = { llm: 'text', stt: 'stt', tts: 'tts' };

export function byoServedByFor(service: ByoDeclarableService): string {
  return SERVED_BY[service];
}

/**
 * `AiModel.libraryName` for a declared row: the vendor adapter that loads it,
 * from the frozen `AI_MODEL_LIBRARIES` vocabulary. Keyed by `(service,
 * provider)` because `provider` is capability-scoped — `azure` is Azure OpenAI
 * under `llm` and Azure Speech under `tts`.
 */
const LIBRARY: Record<string, string> = {
  'llm:azure': 'azure-openai',
  'llm:openai': 'openai',
  'llm:anthropic': 'anthropic',
  'llm:bedrock': 'bedrock',
  'llm:vertex': 'vertex',
  'stt:azure-speech': 'azure-speech',
  'stt:azure-foundry': 'azure-foundry',
  'stt:openai': 'openai',
  'stt:sarvam': 'sarvam',
  'tts:azure': 'azure-speech',
  'tts:sarvam': 'sarvam',
};

export function byoLibraryFor(service: ByoDeclarableService, provider: string): string | null {
  return LIBRARY[`${service}:${provider}`] ?? null;
}

/** `AiModel.category` for a declared row — audio for the speech planes, NLP for text. */
const CATEGORY: Record<ByoDeclarableService, ModelCategory> = {
  llm: ModelCategory.NLP,
  stt: ModelCategory.AUDIO,
  tts: ModelCategory.AUDIO,
};

/** Whether `taskType` is governed by `service`, read from the ONE task→service map. */
export function isTaskTypeOfService(service: ProviderService, taskType: ModelTaskType): boolean {
  return MODEL_TASK_TYPE_SERVICE[taskType] === service;
}

/** Every task type `service` governs, for the error message and the request DTO's docs. */
export function taskTypesOfService(service: ProviderService): ModelTaskType[] {
  return Object.values(ModelTaskType).filter((taskType) => MODEL_TASK_TYPE_SERVICE[taskType] === service);
}

/**
 * The sluggable form of a vendor wire id: lowercase, every run of
 * non-alphanumerics collapsed to one hyphen, no leading/trailing hyphen — the
 * `AiModel.slug` rule the entity validates.
 */
function slugifyWireModelId(wireModelId: string): string {
  return wireModelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `<provider>-<slugified wire id>`. Throws when the wire id carries nothing sluggable. */
export function byoModelSlug(provider: string, wireModelId: string): string {
  const tail = slugifyWireModelId(wireModelId);
  if (!tail) {
    throw new BadRequestException(`Model id '${wireModelId}' contains no letters or digits and cannot be named.`);
  }
  const head = slugifyWireModelId(provider);
  return head ? `${head}-${tail}` : tail;
}

/**
 * The escape hatch a slug-shadow refusal offers (P-29): the same name under a
 * `byo-` prefix, which no platform row uses.
 */
export function suggestedByoModelSlug(provider: string, wireModelId: string): string {
  return `byo-${byoModelSlug(provider, wireModelId)}`;
}

/** One entry of a declaration, already validated by the request DTO. */
export interface ByoModelDeclaration {
  wireModelId: string;
  name: string;
  taskType: ModelTaskType;
  capabilities?: { supportedGenerationParams?: string[]; supportsSsml?: boolean };
  /** Set only when the generated slug shadowed a platform row and the caller accepted the suggestion. */
  slug?: string;
}

/**
 * The `AiModel` row one declaration becomes.
 *
 * Every field that is NOT the tenant's fact is fixed here rather than accepted
 * from the request: a vendor model has no weights to stage
 * (`availability` follows `deploymentKind = CLOUD` in the factory), no bucket
 * identity, and no platform-default status. `sourceUri` carries the wire id
 * too — for a vendor model the LOCATOR and the routed id are the same string,
 * which keeps `findByProviderAndSourceUri` and the inventory honest.
 */
export function buildByoModelProps(input: {
  service: ByoDeclarableService;
  provider: string;
  tenantId: string;
  connectionId: string;
  slug: string;
  entry: ByoModelDeclaration;
  createdBy?: string;
}): CreateAiModelProps {
  const library = byoLibraryFor(input.service, input.provider);
  if (!library) {
    throw new BadRequestException(`Provider '${input.provider}' declares no serving library for the '${input.service}' capability.`);
  }
  return {
    tenantId: input.tenantId,
    name: input.entry.name,
    slug: input.slug,
    description: `Declared on this tenant's '${input.provider}' ${input.service} connection.`,
    category: CATEGORY[input.service],
    taskType: input.entry.taskType,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: input.entry.wireModelId,
    format: AiModelFormat.CLOUD_API,
    libraryName: library,
    servedBy: byoServedByFor(input.service),
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: input.entry.wireModelId,
    sourceConnectionId: input.connectionId,
    provider: input.provider,
    computeType: 'cloud',
    memorySizeMb: 0,
    languages: [],
    ...(input.entry.capabilities ? { metaData: { capabilities: input.entry.capabilities } } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  };
}
