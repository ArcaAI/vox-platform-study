/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GENESIS_PREV_HASH, computeHarnessAuditHash, generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { HarnessAuditEventEntity, IHarnessAuditEventEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateHarnessAuditEventProps extends BaseEntityFactoryCreateProps {
  consultationId: IHarnessAuditEventEntity['consultationId'];
  contextItemVersionId?: IHarnessAuditEventEntity['contextItemVersionId'];
  action: IHarnessAuditEventEntity['action'];
  modelName: IHarnessAuditEventEntity['modelName'];
  modelVersion: IHarnessAuditEventEntity['modelVersion'];
  promptTemplateId?: IHarnessAuditEventEntity['promptTemplateId'];
  promptVersion?: IHarnessAuditEventEntity['promptVersion'];
  sensorScores: IHarnessAuditEventEntity['sensorScores'];
  citations: IHarnessAuditEventEntity['citations'];
  gateDecision?: IHarnessAuditEventEntity['gateDecision'];
  clinicianId?: IHarnessAuditEventEntity['clinicianId'];
  attestationHash?: IHarnessAuditEventEntity['attestationHash'];
  /** Hash of the previous event in this tenant's chain. Defaults to genesis. */
  prevHash?: IHarnessAuditEventEntity['prevHash'];
  tenantId: IHarnessAuditEventEntity['tenantId'];
  Tenant?: IHarnessAuditEventEntity['Tenant'];

  createdAt?: IHarnessAuditEventEntity['createdAt'];
  createdBy?: IHarnessAuditEventEntity['createdBy'];
}

export class HarnessAuditEventFactory {
  /**
   * Build an append-only audit event with its tamper-evident `hash` computed
   * from the canonical fields + `createdAt` + `prevHash`. The caller (service)
   * supplies `prevHash` (the previous event's hash for this tenant, or genesis).
   */
  static CreateHarnessAuditEvent(props: CreateHarnessAuditEventProps): HarnessAuditEventEntity {
    const id = generateId();
    const now = props.createdAt || new Date();
    const prevHash = props.prevHash ?? GENESIS_PREV_HASH;

    const hash = computeHarnessAuditHash({
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      contextItemVersionId: props.contextItemVersionId ?? null,
      action: props.action,
      modelName: props.modelName,
      modelVersion: props.modelVersion,
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersion: props.promptVersion ?? null,
      sensorScores: props.sensorScores ?? null,
      citations: props.citations ?? null,
      gateDecision: props.gateDecision ?? null,
      clinicianId: props.clinicianId ?? null,
      attestationHash: props.attestationHash ?? null,
      createdAt: now,
      prevHash,
    });

    return new HarnessAuditEventEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      consultationId: props.consultationId,
      contextItemVersionId: props.contextItemVersionId ?? null,
      action: props.action,
      modelName: props.modelName,
      modelVersion: props.modelVersion,
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersion: props.promptVersion ?? null,
      sensorScores: props.sensorScores,
      citations: props.citations,
      gateDecision: props.gateDecision ?? null,
      clinicianId: props.clinicianId ?? null,
      attestationHash: props.attestationHash ?? null,
      prevHash,
      hash,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
