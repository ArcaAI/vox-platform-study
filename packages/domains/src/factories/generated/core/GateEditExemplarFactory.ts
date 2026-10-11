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
  /** TASK-1062 D-3 — the structure-only skeleton of `redactedAfter`; the only text a prompt may read. */
  structureAfter?: IGateEditExemplarEntity['structureAfter'];
  contextItemId?: IGateEditExemplarEntity['contextItemId'];
  modelName?: IGateEditExemplarEntity['modelName'];
  promptTemplateId?: IGateEditExemplarEntity['promptTemplateId'];
  /**
   * Curation verdict. Callers never pass it — a freshly mined exemplar is a
   * PENDING proposal by construction; the prop exists only so a fixture or a
   * re-hydration path can build an already-curated row.
   */
  curationStatus?: IGateEditExemplarEntity['curationStatus'];
  /** GATE (default) for a gate-decision exemplar; FEEDBACK for one mined from clinician feedback. */
  source?: IGateEditExemplarEntity['source'];
  feedbackId?: IGateEditExemplarEntity['feedbackId'];
  reasonCodes?: IGateEditExemplarEntity['reasonCodes'];
  targetKind?: IGateEditExemplarEntity['targetKind'];
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
      structureAfter: props.structureAfter ?? null,
      contextItemId: props.contextItemId ?? null,
      modelName: props.modelName ?? null,
      promptTemplateId: props.promptTemplateId ?? null,
      // Omitted ⇒ the entity constructor defaults to PENDING.
      curationStatus: props.curationStatus,
      source: props.source ?? 'GATE',
      feedbackId: props.feedbackId ?? null,
      reasonCodes: props.reasonCodes ?? [],
      targetKind: props.targetKind ?? null,
    });
  }
}
