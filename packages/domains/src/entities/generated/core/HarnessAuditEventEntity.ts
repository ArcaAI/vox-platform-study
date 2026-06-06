/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
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

  get sensorScores(): IHarnessAuditEventEntity['sensorScores'] {
    return this._sensorScores;
  }

  get citations(): IHarnessAuditEventEntity['citations'] {
    return this._citations;
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
