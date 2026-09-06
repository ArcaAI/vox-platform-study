/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiModelEntity, IAiModelEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateAiModelProps extends BaseEntityFactoryCreateProps {
  name: IAiModelEntity['name'];
  slug: IAiModelEntity['slug'];
  description?: IAiModelEntity['description'];
  category: IAiModelEntity['category'];
  taskType: IAiModelEntity['taskType'];
  modelType: IAiModelEntity['modelType'];
  source: IAiModelEntity['source'];
  sourceUri: IAiModelEntity['sourceUri'];
  sourceRevision?: IAiModelEntity['sourceRevision'];
  format: IAiModelEntity['format'];
  // TASK-860 registry identity — the three required facets + card metadata.
  libraryName: IAiModelEntity['libraryName'];
  servedBy: IAiModelEntity['servedBy'];
  deploymentKind: IAiModelEntity['deploymentKind'];
  wireModelId?: IAiModelEntity['wireModelId'];
  /** BYO provenance — set ONLY by the connection's model declaration, never by an admin edit. */
  sourceConnectionId?: IAiModelEntity['sourceConnectionId'];
  license?: IAiModelEntity['license'];
  gated?: IAiModelEntity['gated'];
  baseModel?: IAiModelEntity['baseModel'];
  languages?: IAiModelEntity['languages'];
  hfRevision?: IAiModelEntity['hfRevision'];
  bucketPrefix?: IAiModelEntity['bucketPrefix'];
  primaryObject?: IAiModelEntity['primaryObject'];
  isPlatformDefaultFor?: IAiModelEntity['isPlatformDefaultFor'];
  // Canonical runtime provider + architecture family.
  provider?: IAiModelEntity['provider'];
  architecture?: IAiModelEntity['architecture'];
  metaData?: IAiModelEntity['metaData'];
  memorySizeMb?: IAiModelEntity['memorySizeMb'];
  computeType?: IAiModelEntity['computeType'];
  tenantId: IAiModelEntity['tenantId'];
  tags?: IAiModelEntity['tags'];

  createdAt?: IAiModelEntity['createdAt'];
  updatedAt?: IAiModelEntity['updatedAt'];
  createdBy?: IAiModelEntity['createdBy'];
  updatedBy?: IAiModelEntity['updatedBy'];
}

export class AiModelFactory {
  /**
   * Create a new AI model
   */
  static CreateAiModel(props: CreateAiModelProps): AiModelEntity {
    const id = generateId();
    const now = new Date();

    return new AiModelEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      slug: props.slug,
      description: props.description ?? null,
      category: props.category,
      taskType: props.taskType,
      modelType: props.modelType,
      source: props.source,
      sourceUri: props.sourceUri,
      sourceRevision: props.sourceRevision ?? null,
      format: props.format,
      provider: props.provider ?? null,
      architecture: props.architecture ?? null,
      metaData: props.metaData ?? undefined,
      libraryName: props.libraryName,
      servedBy: props.servedBy,
      deploymentKind: props.deploymentKind,
      wireModelId: props.wireModelId ?? null,
      sourceConnectionId: props.sourceConnectionId ?? null,
      license: props.license ?? null,
      gated: props.gated ?? false,
      baseModel: props.baseModel ?? null,
      languages: props.languages ?? [],
      hfRevision: props.hfRevision ?? null,
      bucketPrefix: props.bucketPrefix ?? null,
      primaryObject: props.primaryObject ?? null,
      manifestDigest: null,
      // A cloud row has nothing to inventory; everything else starts UNKNOWN
      // until the inventory job measures it.
      availability:
        props.deploymentKind === Enums.AiDeploymentKind.CLOUD ? Enums.AiModelAvailability.NOT_APPLICABLE : Enums.AiModelAvailability.UNKNOWN,
      availabilityCheckedAt: null,
      availabilityDetail: null,
      isPlatformDefaultFor: props.isPlatformDefaultFor ?? [],
      memorySizeMb: props.memorySizeMb ?? null,
      computeType: props.computeType ?? null,
      checksum: null,
      tenantId: props.tenantId,
      tags: props.tags ?? [],
    });
  }

  /**
   * Create an ASR model (convenience method)
   */
  static CreateAsrModel(props: Omit<CreateAiModelProps, 'category' | 'taskType'>): AiModelEntity {
    return this.CreateAiModel({
      ...props,
      category: Enums.ModelCategory.AUDIO,
      taskType: Enums.ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    });
  }

  /**
   * Create a VAD model (convenience method)
   */
  static CreateVadModel(props: Omit<CreateAiModelProps, 'category' | 'taskType'>): AiModelEntity {
    return this.CreateAiModel({
      ...props,
      category: Enums.ModelCategory.AUDIO,
      taskType: Enums.ModelTaskType.VOICE_ACTIVITY_DETECTION,
    });
  }

  /**
   * Generate a URL-friendly slug from a name
   */
  static GenerateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
