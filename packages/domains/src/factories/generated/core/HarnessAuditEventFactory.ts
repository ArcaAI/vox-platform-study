/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GENESIS_PREV_HASH, computeHarnessAuditHash, generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ENCRYPTED_PAYLOAD_SENTINEL } from '../../../common/field-encryption';
import { HarnessAuditEventEntity, IHarnessAuditEventEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateHarnessAuditEventProps extends BaseEntityFactoryCreateProps {
  // Optional — see IHarnessAuditEventEntity.consultationId. Callers that
  // legitimately have none (CONSENT_GIVEN/CONSENT_WITHDRAWN) pass `null`
  // explicitly rather than omitting the field, so the choice is visible at
  // the call site.
  consultationId: IHarnessAuditEventEntity['consultationId'];
  contextItemVersionId?: IHarnessAuditEventEntity['contextItemVersionId'];
  action: IHarnessAuditEventEntity['action'];
  modelName: IHarnessAuditEventEntity['modelName'];
  modelVersion: IHarnessAuditEventEntity['modelVersion'];
  promptTemplateId?: IHarnessAuditEventEntity['promptTemplateId'];
  promptVersion?: IHarnessAuditEventEntity['promptVersion'];
  sensorScores: IHarnessAuditEventEntity['sensorScores'];
  citations: IHarnessAuditEventEntity['citations'];
  // When supplied (by the service, after Vault-Transit
  // encryption), the `hash` is derived over THIS ciphertext (encrypt-before-hash)
  // and the plaintext sensorScores/citations are replaced with a redaction
  // sentinel before persistence. Omitted ⇒ legacy plaintext row (hash over JSON).
  encryptedSensorScores?: IHarnessAuditEventEntity['encryptedSensorScores'];
  encryptedCitations?: IHarnessAuditEventEntity['encryptedCitations'];
  keyVersion?: IHarnessAuditEventEntity['keyVersion'];
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

    const encryptedSensorScores = props.encryptedSensorScores ?? null;
    const encryptedCitations = props.encryptedCitations ?? null;

    // ENCRYPT-BEFORE-HASH (Phase 3D): when a payload is encrypted, the hash is
    // derived over its CIPHERTEXT (per field, in computeHarnessAuditHash) so the
    // chain validates identically on the verifier; otherwise over the plaintext.
    const hash = computeHarnessAuditHash({
      tenantId: props.tenantId,
      consultationId: props.consultationId ?? null,
      contextItemVersionId: props.contextItemVersionId ?? null,
      action: props.action,
      modelName: props.modelName,
      modelVersion: props.modelVersion,
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersion: props.promptVersion ?? null,
      sensorScores: props.sensorScores ?? null,
      citations: props.citations ?? null,
      encryptedSensorScores,
      encryptedCitations,
      gateDecision: props.gateDecision ?? null,
      clinicianId: props.clinicianId ?? null,
      attestationHash: props.attestationHash ?? null,
      createdAt: now,
      prevHash,
    });

    // For an encrypted field, persist a non-PHI redaction sentinel in the
    // NOT-NULL plaintext JSONB (immutable WORM column) — the ciphertext is the
    // source of truth. Legacy/plaintext rows keep the real JSON.
    const persistedSensorScores = encryptedSensorScores ? { ...ENCRYPTED_PAYLOAD_SENTINEL } : props.sensorScores;
    const persistedCitations = encryptedCitations ? { ...ENCRYPTED_PAYLOAD_SENTINEL } : props.citations;

    return new HarnessAuditEventEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      consultationId: props.consultationId ?? null,
      contextItemVersionId: props.contextItemVersionId ?? null,
      action: props.action,
      modelName: props.modelName,
      modelVersion: props.modelVersion,
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersion: props.promptVersion ?? null,
      sensorScores: persistedSensorScores,
      citations: persistedCitations,
      encryptedSensorScores,
      encryptedCitations,
      keyVersion: props.keyVersion ?? null,
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
