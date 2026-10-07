/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GuardrailNoticeEntity, IGuardrailNoticeEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateGuardrailNoticeProps extends BaseEntityFactoryCreateProps {
  tenantId: IGuardrailNoticeEntity['tenantId'];
  consultationId?: IGuardrailNoticeEntity['consultationId'];
  runId?: IGuardrailNoticeEntity['runId'];
  nodeId?: IGuardrailNoticeEntity['nodeId'];
  type: IGuardrailNoticeEntity['type'];
  direction: IGuardrailNoticeEntity['direction'];
  action: IGuardrailNoticeEntity['action'];
  checks: IGuardrailNoticeEntity['checks'];
  itemIds?: IGuardrailNoticeEntity['itemIds'];
  messageKey: IGuardrailNoticeEntity['messageKey'];
  severity: IGuardrailNoticeEntity['severity'];
  requiresAcknowledgement?: IGuardrailNoticeEntity['requiresAcknowledgement'];
  resumable?: IGuardrailNoticeEntity['resumable'];
  policyVersion: IGuardrailNoticeEntity['policyVersion'];
  dedupeKey: IGuardrailNoticeEntity['dedupeKey'];
  metaData?: IGuardrailNoticeEntity['metaData'];
  createdAt?: IGuardrailNoticeEntity['createdAt'];
  createdBy?: IGuardrailNoticeEntity['createdBy'];
}

export class GuardrailNoticeFactory {
  /**
   * Create a new OPEN notice with a fresh UUIDv7 noticeId. Persist with
   * `GuardrailNoticeRepository.upsertByDedupeKey`, which keeps the existing
   * row when the same `dedupeKey` was already raised.
   */
  static CreateGuardrailNotice(props: CreateGuardrailNoticeProps): GuardrailNoticeEntity {
    const now = new Date();

    return new GuardrailNoticeEntity({
      id: generateId(),
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      consultationId: props.consultationId ?? null,
      runId: props.runId ?? null,
      nodeId: props.nodeId ?? null,
      type: props.type,
      direction: props.direction,
      action: props.action,
      checks: props.checks,
      itemIds: props.itemIds ?? [],
      messageKey: props.messageKey,
      severity: props.severity,
      requiresAcknowledgement: props.requiresAcknowledgement ?? false,
      resumable: props.resumable ?? false,
      policyVersion: props.policyVersion,
      dedupeKey: props.dedupeKey,
      status: Enums.GuardrailNoticeStatus.OPEN,
      acknowledgedBy: null,
      acknowledgedAt: null,
      acknowledgedVia: null,
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
    });
  }
}
