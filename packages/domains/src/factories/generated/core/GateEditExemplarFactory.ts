import { BaseEntityFactoryCreateProps } from '../../../common';
import { GateEditExemplarEntity, IGateEditExemplarEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateGateEditExemplarProps extends BaseEntityFactoryCreateProps {
  tenantId: IGateEditExemplarEntity['tenantId'];
  consultationId: IGateEditExemplarEntity['consultationId'];
  gateDecision: IGateEditExemplarEntity['gateDecision'];
  qualitySignal: IGateEditExemplarEntity['qualitySignal'];
  departmentId?: IGateEditExemplarEntity['departmentId'];
  visitType?: IGateEditExemplarEntity['visitType'];
  editDistance?: IGateEditExemplarEntity['editDistance'];
  editDistanceRatio?: IGateEditExemplarEntity['editDistanceRatio'];
  timeToSignSeconds?: IGateEditExemplarEntity['timeToSignSeconds'];
  redactedBefore?: IGateEditExemplarEntity['redactedBefore'];
  redactedAfter?: IGateEditExemplarEntity['redactedAfter'];
  contextItemId?: IGateEditExemplarEntity['contextItemId'];
  modelName?: IGateEditExemplarEntity['modelName'];
  promptTemplateId?: IGateEditExemplarEntity['promptTemplateId'];
  /**
   * Curation verdict. Callers never pass it — a freshly mined exemplar is a
   * PENDING proposal by construction; the prop exists only so a fixture or a
   * re-hydration path can build an already-curated row.
   */
  curationStatus?: IGateEditExemplarEntity['curationStatus'];
  createdAt?: IGateEditExemplarEntity['createdAt'];
  updatedAt?: IGateEditExemplarEntity['updatedAt'];
  createdBy?: IGateEditExemplarEntity['createdBy'];
  updatedBy?: IGateEditExemplarEntity['updatedBy'];
}

export class GateEditExemplarFactory {
  public static CreateGateEditExemplar(props: CreateGateEditExemplarProps): GateEditExemplarEntity {
    const id = generateId();
    const now = new Date();

    return new GateEditExemplarEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      departmentId: props.departmentId ?? null,
      visitType: props.visitType ?? null,
      gateDecision: props.gateDecision,
      qualitySignal: props.qualitySignal,
      editDistance: props.editDistance ?? null,
      editDistanceRatio: props.editDistanceRatio ?? null,
      timeToSignSeconds: props.timeToSignSeconds ?? null,
      redactedBefore: props.redactedBefore ?? null,
      redactedAfter: props.redactedAfter ?? null,
      contextItemId: props.contextItemId ?? null,
      modelName: props.modelName ?? null,
      promptTemplateId: props.promptTemplateId ?? null,
      // Omitted ⇒ the entity constructor defaults to PENDING.
      curationStatus: props.curationStatus,
    });
  }
}
