/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantCheckpointEntity, ITenantCheckpointEntity } from '../../../entities';
import { TenantCheckpointKind, TenantCheckpointOrigin, TenantCheckpointStatus } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateTenantCheckpointProps extends BaseEntityFactoryCreateProps {
  label: ITenantCheckpointEntity['label'];
  kind?: ITenantCheckpointEntity['kind'];
  origin?: ITenantCheckpointEntity['origin'];
  status?: ITenantCheckpointEntity['status'];
  includesMedia?: ITenantCheckpointEntity['includesMedia'];
  passphraseProtected?: ITenantCheckpointEntity['passphraseProtected'];
  keyEnvelope?: ITenantCheckpointEntity['keyEnvelope'];
  objectKey?: ITenantCheckpointEntity['objectKey'];
  uploadId?: ITenantCheckpointEntity['uploadId'];
  sizeBytes?: ITenantCheckpointEntity['sizeBytes'];
  manifestDigest?: ITenantCheckpointEntity['manifestDigest'];
  manifestSummary?: ITenantCheckpointEntity['manifestSummary'];
  schemaFingerprint?: ITenantCheckpointEntity['schemaFingerprint'];
  sourceDeploymentId?: ITenantCheckpointEntity['sourceDeploymentId'];
  formatVersion?: ITenantCheckpointEntity['formatVersion'];
  progress?: ITenantCheckpointEntity['progress'];
  heartbeatAt?: ITenantCheckpointEntity['heartbeatAt'];
  cancelRequestedAt?: ITenantCheckpointEntity['cancelRequestedAt'];
  startedAt?: ITenantCheckpointEntity['startedAt'];
  finishedAt?: ITenantCheckpointEntity['finishedAt'];
  expiresAt?: ITenantCheckpointEntity['expiresAt'];
  failureReason?: ITenantCheckpointEntity['failureReason'];
  failureDetail?: ITenantCheckpointEntity['failureDetail'];

  createdAt?: ITenantCheckpointEntity['createdAt'];
  updatedAt?: ITenantCheckpointEntity['updatedAt'];
  createdBy?: ITenantCheckpointEntity['createdBy'];
  updatedBy?: ITenantCheckpointEntity['updatedBy'];
}

export class TenantCheckpointFactory {
  static CreateTenantCheckpoint(props: CreateTenantCheckpointProps): TenantCheckpointEntity {
    const id = generateId();
    const now = new Date();

    return new TenantCheckpointEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      label: props.label,
      kind: props.kind ?? TenantCheckpointKind.MANUAL,
      origin: props.origin ?? TenantCheckpointOrigin.CREATED,
      status: props.status ?? TenantCheckpointStatus.PENDING,
      includesMedia: props.includesMedia ?? true,
      passphraseProtected: props.passphraseProtected ?? false,
      keyEnvelope: props.keyEnvelope ?? null,
      objectKey: props.objectKey ?? null,
      uploadId: props.uploadId ?? null,
      sizeBytes: props.sizeBytes ?? null,
      manifestDigest: props.manifestDigest ?? null,
      manifestSummary: props.manifestSummary ?? null,
      schemaFingerprint: props.schemaFingerprint ?? null,
      sourceDeploymentId: props.sourceDeploymentId ?? null,
      formatVersion: props.formatVersion ?? 1,
      progress: props.progress ?? null,
      heartbeatAt: props.heartbeatAt ?? null,
      cancelRequestedAt: props.cancelRequestedAt ?? null,
      startedAt: props.startedAt ?? null,
      finishedAt: props.finishedAt ?? null,
      expiresAt: props.expiresAt ?? null,
      failureReason: props.failureReason ?? null,
      failureDetail: props.failureDetail ?? null,
    });
  }
}
