/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Append-only, hash-chained WORM audit record (TASK-330 Phase 0).
 *
 * Immutable by design: the backing table has NO `_version` / `_metadata` /
 * `updatedAt` / `resourceStatus` columns and the migration REVOKEs UPDATE/DELETE
 * from the application role. The inherited base audit fields are stripped in
 * `HarnessAuditEventEntityMapper.toPersistence` so they are never written.
 */
export interface IHarnessAuditEventEntity extends IBaseTenantEntity {
  consultationId: string;
  contextItemVersionId?: string | null;
  action: Enums.HarnessAuditAction;
  modelName: string;
  modelVersion: string;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  sensorScores: JsonValue;
  citations: JsonValue;
  // TASK-369 Phase 3D (ENCRYPT-BEFORE-HASH) — Vault-Transit (hope-phi) ciphertext
  // of sensorScores/citations + shared key version. Set ONLY on encrypted (new)
  // rows; the plaintext JSONB columns then hold a non-PHI redaction sentinel and
  // the row `hash` is computed over THESE bytes. Null on legacy/plaintext rows.
  encryptedSensorScores?: Buffer | null;
  encryptedCitations?: Buffer | null;
  keyVersion?: number | null;
  gateDecision?: string | null;
  clinicianId?: string | null;
  attestationHash?: string | null;
  prevHash: string;
  hash: string;
}

export class HarnessAuditEventEntity extends BaseTenantEntity {
  private _consultationId: IHarnessAuditEventEntity['consultationId'];
  private _contextItemVersionId?: IHarnessAuditEventEntity['contextItemVersionId'];
  private _action: IHarnessAuditEventEntity['action'];
  private _modelName: IHarnessAuditEventEntity['modelName'];
  private _modelVersion: IHarnessAuditEventEntity['modelVersion'];
  private _promptTemplateId?: IHarnessAuditEventEntity['promptTemplateId'];
  private _promptVersion?: IHarnessAuditEventEntity['promptVersion'];
  private _sensorScores: IHarnessAuditEventEntity['sensorScores'];
  private _citations: IHarnessAuditEventEntity['citations'];
  private _encryptedSensorScores?: IHarnessAuditEventEntity['encryptedSensorScores'];
  private _encryptedCitations?: IHarnessAuditEventEntity['encryptedCitations'];
  private _keyVersion?: IHarnessAuditEventEntity['keyVersion'];
  private _gateDecision?: IHarnessAuditEventEntity['gateDecision'];
  private _clinicianId?: IHarnessAuditEventEntity['clinicianId'];
  private _attestationHash?: IHarnessAuditEventEntity['attestationHash'];
  private _prevHash: IHarnessAuditEventEntity['prevHash'];
  private _hash: IHarnessAuditEventEntity['hash'];

  constructor(init: IHarnessAuditEventEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._contextItemVersionId = init.contextItemVersionId;
    this._action = init.action;
    this._modelName = init.modelName;
    this._modelVersion = init.modelVersion;
    this._promptTemplateId = init.promptTemplateId;
    this._promptVersion = init.promptVersion;
    this._sensorScores = init.sensorScores;
    this._citations = init.citations;
    this._encryptedSensorScores = init.encryptedSensorScores;
    this._encryptedCitations = init.encryptedCitations;
    this._keyVersion = init.keyVersion;
    this._gateDecision = init.gateDecision;
    this._clinicianId = init.clinicianId;
    this._attestationHash = init.attestationHash;
    this._prevHash = init.prevHash;
    this._hash = init.hash;
  }

  // Read-only accessors — the record is immutable once created (WORM). No
  // setters are exposed: an "update" to an audit event is a new appended row.

  get consultationId(): IHarnessAuditEventEntity['consultationId'] {
    return this._consultationId;
  }

  get contextItemVersionId(): IHarnessAuditEventEntity['contextItemVersionId'] {
    return this._contextItemVersionId;
  }

  get action(): IHarnessAuditEventEntity['action'] {
    return this._action;
  }

  get modelName(): IHarnessAuditEventEntity['modelName'] {
    return this._modelName;
  }

  get modelVersion(): IHarnessAuditEventEntity['modelVersion'] {
    return this._modelVersion;
  }

  get promptTemplateId(): IHarnessAuditEventEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  get promptVersion(): IHarnessAuditEventEntity['promptVersion'] {
    return this._promptVersion;
  }

  // TASK-369 Phase 3D — `sensorScores`/`citations` can carry clinical evidence.
  // @Secret() marks them for audit-log redaction (defense-in-depth). On encrypted
  // rows these hold a non-PHI redaction sentinel; the real payload lives in the
  // `encrypted*` columns (use the repository decrypt helper to read it back).
  @Secret()
  get sensorScores(): IHarnessAuditEventEntity['sensorScores'] {
    return this._sensorScores;
  }

  @Secret()
  get citations(): IHarnessAuditEventEntity['citations'] {
    return this._citations;
  }

  // TASK-369 Phase 3D — Vault-Transit ciphertext (read-only; WORM). @Secret()
  // keeps ciphertext + keyVersion off audit-log surfaces.
  @Secret()
  get encryptedSensorScores(): IHarnessAuditEventEntity['encryptedSensorScores'] {
    return this._encryptedSensorScores;
  }

  @Secret()
  get encryptedCitations(): IHarnessAuditEventEntity['encryptedCitations'] {
    return this._encryptedCitations;
  }

  get keyVersion(): IHarnessAuditEventEntity['keyVersion'] {
    return this._keyVersion;
  }

  get gateDecision(): IHarnessAuditEventEntity['gateDecision'] {
    return this._gateDecision;
  }

  get clinicianId(): IHarnessAuditEventEntity['clinicianId'] {
    return this._clinicianId;
  }

  get attestationHash(): IHarnessAuditEventEntity['attestationHash'] {
    return this._attestationHash;
  }

  get prevHash(): IHarnessAuditEventEntity['prevHash'] {
    return this._prevHash;
  }

  get hash(): IHarnessAuditEventEntity['hash'] {
    return this._hash;
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('HarnessAuditEvent consultationId is required.');
    }
    if (this._action === undefined || this._action === null) {
      throw new BusinessException('HarnessAuditEvent action is required.');
    }
    if (!Object.values(Enums.HarnessAuditAction).includes(this._action)) {
      throw new BusinessException(`HarnessAuditEvent action is invalid: ${String(this._action)}.`);
    }
    if (!this._modelName || this._modelName.trim().length === 0) {
      throw new BusinessException('HarnessAuditEvent modelName is required.');
    }
    if (!this._modelVersion || this._modelVersion.trim().length === 0) {
      throw new BusinessException('HarnessAuditEvent modelVersion is required.');
    }
    if (this._sensorScores === undefined || this._sensorScores === null) {
      throw new BusinessException('HarnessAuditEvent sensorScores is required.');
    }
    if (this._citations === undefined || this._citations === null) {
      throw new BusinessException('HarnessAuditEvent citations is required.');
    }
    if (!this._prevHash) {
      throw new BusinessException('HarnessAuditEvent prevHash is required.');
    }
    if (!this._hash) {
      throw new BusinessException('HarnessAuditEvent hash is required.');
    }
  }
}
