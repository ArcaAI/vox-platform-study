import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiDeploymentKind, AiModelAvailability, AiTaskKind, ModelTaskType, ResourceStatusType } from '@arcaai/domains';
import type { ProviderClass, ProviderGroup } from '../../ai-provider-connection/constants';

export type { ProviderClass, ProviderGroup } from '../../ai-provider-connection/constants';

/**
 * How ready a model is to serve RIGHT NOW, as last OBSERVED by the platform
 * (TASK-890 §3.12). It is a snapshot, never a live probe: a tenant reading the
 * catalogue must never cause a vendor call or an engine round trip.
 *
 *   `ready`              serving now (engine up + model resident, or weights staged + service healthy, or a probed credential)
 *   `loadable`           the engine has it listed but not resident — the first call pays the load
 *   `engine_down`        the serving engine did not answer the last probe
 *   `weights_missing`    the engine/bucket does not have the weights the row names
 *   `credential_missing` a cloud row whose resolved connection carries no key
 *   `unknown`            never observed (cold snapshot, or the readiness service is not wired)
 */
export const MODEL_READINESS_VALUES = ['ready', 'loadable', 'engine_down', 'weights_missing', 'credential_missing', 'unknown'] as const;
export type ModelReadiness = (typeof MODEL_READINESS_VALUES)[number];

/**
 * One picker GROUP entry: a tenant's own BYO connection, or the single
 * "Hope provider" that stands for everything the platform serves (OD-A, OD-L).
 */
export class CatalogueProviderResponse {
  @ApiProperty({ description: '`byo:<service>:<provider>` for a tenant connection, or the literal `hope` (exactly one entry).' })
  id: string;

  @ApiProperty({ description: 'Which half of the picker this entry belongs to.', enum: ['byo', 'hope'] })
  group: ProviderGroup;

  @ApiProperty({ description: 'Display name.' })
  name: string;

  @ApiProperty({
    description: 'How the entry is served. NULL for the `hope` group, whose MODELS carry their own class.',
    nullable: true,
    enum: ['cloud-byo', 'cloud-platform', 'engine-served', 'platform-self-host'],
  })
  providerClass: ProviderClass | null;

  @ApiProperty({ description: 'The tenant `AiProviderConnection` behind a BYO entry; NULL for `hope`.', nullable: true })
  connectionId: string | null;

  @ApiProperty({ description: 'Whether ANY model under this entry can serve the caller today.' })
  usable: boolean;

  @ApiProperty({ description: 'Why not, when `usable` is false. A stable machine token, not prose.', nullable: true })
  reason: string | null;

  @ApiProperty({ description: 'Models listed under this entry after every filter.' })
  modelCount: number;
}

/** One picker MODEL entry. Deliberately narrower than `ModelResponse` — see the mapper. */
export class CatalogueModelResponse {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ enum: ModelTaskType }) taskType: ModelTaskType;
  @ApiProperty({ description: 'The Hugging Face `pipeline_tag` derived from `taskType`.' }) pipelineTag: string;
  @ApiProperty({ description: 'The `CatalogueProviderResponse.id` this model sits under.' }) providerId: string;
  @ApiProperty({ description: 'The engine / vendor id — what routing and the usage ledger are keyed on.', nullable: true })
  provider: string | null;
  @ApiProperty({ enum: ['cloud-byo', 'cloud-platform', 'engine-served', 'platform-self-host'] }) providerClass: ProviderClass;
  @ApiProperty({ enum: AiDeploymentKind }) deploymentKind: AiDeploymentKind;
  @ApiProperty({ description: 'MEASURED presence of the weights (inventory job).', enum: AiModelAvailability }) availability: AiModelAvailability;
  @ApiProperty({ description: 'Last OBSERVED serving readiness.', enum: MODEL_READINESS_VALUES }) readiness: ModelReadiness;
  @ApiProperty({ description: 'When that observation was taken ("at that point of time").', nullable: true }) readinessCheckedAt: Date | null;
  @ApiProperty({ description: 'Non-secret detail behind the readiness verdict.', nullable: true }) readinessDetail: string | null;
  @ApiProperty({ description: 'What the model accepts, for the authoring form.', type: Object })
  capabilities: { supportedGenerationParams?: string[]; supportsSsml?: boolean };
  @ApiProperty({ description: 'Tasks this row is the platform default for.', enum: AiTaskKind, isArray: true }) isPlatformDefaultFor: AiTaskKind[];
  @ApiProperty({ enum: ResourceStatusType }) resourceStatus: ResourceStatusType;
  @ApiProperty({ description: 'Whether an agent bound to this model could publish and run today.' }) usable: boolean;
  @ApiProperty({ description: 'Why not, when `usable` is false.', nullable: true }) unusableReason: string | null;
}

/** The whole picker payload: the groups, then every model, each naming its group. */
export class ModelCatalogueResponse {
  @ApiProperty({ type: [CatalogueProviderResponse], description: 'BYO entries first, then the single Hope entry (picker order).' })
  providers: CatalogueProviderResponse[];

  @ApiProperty({ type: [CatalogueModelResponse] })
  models: CatalogueModelResponse[];

  @ApiPropertyOptional({
    description:
      'SUPER ADMIN ONLY — catalogue rows naming no provider this platform can serve. Hidden from tenants entirely; surfaced to the ' +
      'person who can fix them so an unassigned row is visible rather than silently absent.',
  })
  unassignedProviderCount?: number;
}

/** What `getCatalogue` narrows on. Every field is optional; absent = no filter. */
export interface ModelCatalogueFilter {
  taskType?: ModelTaskType;
  providerGroup?: ProviderGroup;
  usableOnly?: boolean;
}
