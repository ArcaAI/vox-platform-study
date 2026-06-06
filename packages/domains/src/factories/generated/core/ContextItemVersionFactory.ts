/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ContextItemVersionEntity, IContextItemVersionEntity, ContextItemEntity } from '../../../entities';
import { JsonValue } from '../../../interfaces';

export interface CreateContextItemVersionProps extends BaseEntityFactoryCreateProps {
  contextItemId: IContextItemVersionEntity['contextItemId'];
  versionNumber: IContextItemVersionEntity['versionNumber'];
  content?: IContextItemVersionEntity['content'];
  contentDiff?: IContextItemVersionEntity['contentDiff'];
  changeReason?: IContextItemVersionEntity['changeReason'];
  changeSummary?: IContextItemVersionEntity['changeSummary'];
  changedBy?: IContextItemVersionEntity['changedBy'];
  changeSource?: IContextItemVersionEntity['changeSource'];
  fieldChanges?: IContextItemVersionEntity['fieldChanges'];
  // TASK-330 Phase 1 — clinician attestation fields
  attestedAt?: IContextItemVersionEntity['attestedAt'];
  attestedBy?: IContextItemVersionEntity['attestedBy'];
  attestationHash?: IContextItemVersionEntity['attestationHash'];
  modelName?: IContextItemVersionEntity['modelName'];
  modelVersion?: IContextItemVersionEntity['modelVersion'];
  sensorScores?: IContextItemVersionEntity['sensorScores'];
  tenantId: IContextItemVersionEntity['tenantId'];

  createdAt?: IContextItemVersionEntity['createdAt'];
}

export interface CreateSignedNoteVersionProps extends BaseEntityFactoryCreateProps {
  contextItemId: IContextItemVersionEntity['contextItemId'];
  versionNumber: IContextItemVersionEntity['versionNumber'];
  tenantId: IContextItemVersionEntity['tenantId'];
  attestedBy: NonNullable<IContextItemVersionEntity['attestedBy']>;
  attestationHash: NonNullable<IContextItemVersionEntity['attestationHash']>;
  content?: IContextItemVersionEntity['content'];
  attestedAt?: IContextItemVersionEntity['attestedAt'];
  modelName?: IContextItemVersionEntity['modelName'];
  modelVersion?: IContextItemVersionEntity['modelVersion'];
  sensorScores?: IContextItemVersionEntity['sensorScores'];
  changeReason?: IContextItemVersionEntity['changeReason'];
  changeSummary?: IContextItemVersionEntity['changeSummary'];
}

export class ContextItemVersionFactory {
  /**
   * Create a version record
   */
  static CreateVersion(props: CreateContextItemVersionProps): ContextItemVersionEntity {
    const id = generateId();
    const now = new Date();

    return new ContextItemVersionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.changedBy ?? null,
      updatedBy: null,

      contextItemId: props.contextItemId,
      versionNumber: props.versionNumber,
      content: props.content ?? null,
      contentDiff: props.contentDiff ?? null,
      changeReason: props.changeReason ?? null,
      changeSummary: props.changeSummary ?? null,
      changedBy: props.changedBy ?? null,
      changeSource: props.changeSource ?? 'manual',
      fieldChanges: props.fieldChanges ?? null,
      attestedAt: props.attestedAt ?? null,
      attestedBy: props.attestedBy ?? null,
      attestationHash: props.attestationHash ?? null,
      modelName: props.modelName ?? null,
      modelVersion: props.modelVersion ?? null,
      sensorScores: props.sensorScores ?? null,
      tenantId: props.tenantId,
    });
  }

  /**
   * TASK-330 Phase 1 — create an attested SIGNED_NOTE version (confirm-before-commit
   * gate). Keeps `changeReason='approved'` for back-compat with the existing
   * approval idempotency check and stamps the attestation provenance fields.
   */
  static CreateSignedNoteVersion(props: CreateSignedNoteVersionProps): ContextItemVersionEntity {
    return this.CreateVersion({
      contextItemId: props.contextItemId,
      versionNumber: props.versionNumber,
      tenantId: props.tenantId,
      content: props.content,
      changeReason: props.changeReason ?? 'approved',
      changeSummary: props.changeSummary ?? 'Clinician attested signed note',
      changedBy: props.attestedBy,
      changeSource: 'attestation',
      attestedAt: props.attestedAt ?? new Date(),
      attestedBy: props.attestedBy,
      attestationHash: props.attestationHash,
      modelName: props.modelName,
      modelVersion: props.modelVersion,
      sensorScores: props.sensorScores,
    });
  }

  /**
   * Create a version record from an existing ContextItem (content-at-version semantics).
   * The version captures the item's content AS IT IS at the given version number.
   */
  static CreateFromContextItem(
    contextItem: ContextItemEntity,
    versionNumber: number,
    changeReason: string,
    changedBy: string,
    changeSource: string = 'manual',
    changeSummary?: string,
    contentDiff?: string,
    fieldChanges?: JsonValue,
  ): ContextItemVersionEntity {
    return this.CreateVersion({
      contextItemId: contextItem.id,
      versionNumber,
      content: contextItem.content,
      contentDiff,
      changeReason,
      changeSummary,
      changedBy,
      changeSource,
      fieldChanges,
      tenantId: contextItem.tenantId,
    });
  }

  /**
   * Create initial version (version 1) from a newly created ContextItem
   */
  static CreateInitialVersion(contextItem: ContextItemEntity, createdBy: string): ContextItemVersionEntity {
    return this.CreateFromContextItem(contextItem, 1, 'initial_creation', createdBy, 'system', 'Initial version');
  }

  /**
   * Create a user edit version
   */
  static CreateUserEditVersion(
    contextItem: ContextItemEntity,
    versionNumber: number,
    changedBy: string,
    changeSummary: string,
    contentDiff?: string,
    fieldChanges?: JsonValue,
  ): ContextItemVersionEntity {
    return this.CreateFromContextItem(contextItem, versionNumber, 'user_edit', changedBy, 'manual', changeSummary, contentDiff, fieldChanges);
  }

  /**
   * Create an AI regeneration version
   */
  static CreateAiRegenerationVersion(
    contextItem: ContextItemEntity,
    versionNumber: number,
    aiModelId: string,
    changeSummary?: string,
    contentDiff?: string,
  ): ContextItemVersionEntity {
    return this.CreateFromContextItem(
      contextItem,
      versionNumber,
      'ai_regeneration',
      'system',
      `ai_model_${aiModelId}`,
      changeSummary ?? 'AI regenerated content',
      contentDiff,
    );
  }
}
