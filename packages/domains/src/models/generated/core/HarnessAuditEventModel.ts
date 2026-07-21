/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for the append-only WORM audit table.
 *
 * Although it extends `BaseTenantDataModel`, the backing table has NO
 * `_version` / `_metadata` / `updatedAt` / `createdBy` / `updatedBy` columns —
 * those inherited fields are stripped in `HarnessAuditEventEntityMapper`
 * before any write. Only `createdAt` (DB default) is retained from the base.
 */
export class HarnessAuditEvent extends BaseTenantDataModel {
  public consultationId: string;
  public contextItemVersionId: string | null;
  public action: Enums.HarnessAuditAction;
  public modelName: string;
  public modelVersion: string;
  public promptTemplateId: string | null;
  public promptVersion: string | null;
  public sensorScores: JsonValue;
  public citations: JsonValue;
  // Vault-Transit ciphertext of sensorScores/citations plus
  // the shared key version. ENCRYPT-BEFORE-HASH: when set, `hash` is derived over
  // these bytes (the plaintext JSONB columns hold a redaction sentinel).
  public encryptedSensorScores: Uint8Array | null;
  public encryptedCitations: Uint8Array | null;
  public keyVersion: number | null;
  public gateDecision: string | null;
  public clinicianId: string | null;
  public attestationHash: string | null;
  public prevHash: string;
  public hash: string;

  constructor(data: HarnessAuditEvent & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.contextItemVersionId = data.contextItemVersionId;
    this.action = data.action;
    this.modelName = data.modelName;
    this.modelVersion = data.modelVersion;
    this.promptTemplateId = data.promptTemplateId;
    this.promptVersion = data.promptVersion;
    this.sensorScores = data.sensorScores;
    this.citations = data.citations;
    this.encryptedSensorScores = data.encryptedSensorScores;
    this.encryptedCitations = data.encryptedCitations;
    this.keyVersion = data.keyVersion;
    this.gateDecision = data.gateDecision;
    this.clinicianId = data.clinicianId;
    this.attestationHash = data.attestationHash;
    this.prevHash = data.prevHash;
    this.hash = data.hash;
  }
}
