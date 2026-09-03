/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IAuditLogEntity extends IBaseTenantEntity {
  responsibleUserId?: string | null;
  /**
   * the MACHINE half of the actor pair. Mutually exclusive with
   * `responsibleUserId`: a service-account action leaves the user column NULL
   * rather than borrowing the identity of whichever human issued the
   * credential, which would be wrong in a way a reviewer cannot detect.
 */
  responsibleServiceAccountId?: string | null;
  responsibleIp?: string | null;
  resourceType: Enums.ResourceType;
  resourceId?: string | null;
  resourceDatabase?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  action: Enums.AuditAction;
  eventType?: string | null;
  success?: boolean | null;
  data: JsonValue;
  previousData: JsonValue;
  metadata?: JsonValue | null;
  // Envelope-encryption columns. `encryptedData` /
  // `encryptedPreviousData` are the AES-256-GCM ciphertext (under a cached DEK);
  // `dekWrapped` is the Vault-Transit-wrapped DEK (vault:vN:...) and
  // `dekKeyVersion` the Transit key version that wrapped it. All nullable (NULL
  // on legacy/plaintext rows; plaintext is retained for the dual-read soak).
  encryptedData?: Buffer | null;
  encryptedPreviousData?: Buffer | null;
  dekWrapped?: string | null;
  dekKeyVersion?: number | null;
}

export class AuditLogEntity extends BaseTenantEntity {
  private _responsibleUserId?: IAuditLogEntity['responsibleUserId'];
  private _responsibleServiceAccountId?: IAuditLogEntity['responsibleServiceAccountId'];
  private _responsibleIp?: IAuditLogEntity['responsibleIp'];
  private _resourceType: IAuditLogEntity['resourceType'];
  private _resourceId?: IAuditLogEntity['resourceId'];
  private _resourceDatabase?: IAuditLogEntity['resourceDatabase'];
  private _correlationId?: IAuditLogEntity['correlationId'];
  private _causationId?: IAuditLogEntity['causationId'];
  private _action: IAuditLogEntity['action'];
  private _eventType?: IAuditLogEntity['eventType'];
  private _success?: IAuditLogEntity['success'];
  private _data: IAuditLogEntity['data'];
  private _previousData: IAuditLogEntity['previousData'];
  private _metadata?: IAuditLogEntity['metadata'];
  private _encryptedData?: IAuditLogEntity['encryptedData'];
  private _encryptedPreviousData?: IAuditLogEntity['encryptedPreviousData'];
  private _dekWrapped?: IAuditLogEntity['dekWrapped'];
  private _dekKeyVersion?: IAuditLogEntity['dekKeyVersion'];

  constructor(init: IAuditLogEntity) {
    super(init);
    this._responsibleUserId = init.responsibleUserId;
    this._responsibleServiceAccountId = init.responsibleServiceAccountId;
    this._responsibleIp = init.responsibleIp;
    this._resourceType = init.resourceType;
    this._resourceId = init.resourceId;
    this._resourceDatabase = init.resourceDatabase;
    this._correlationId = init.correlationId;
    this._causationId = init.causationId;
    this._action = init.action;
    this._eventType = init.eventType;
    this._success = init.success;
    this._data = init.data;
    this._previousData = init.previousData;
    this._metadata = init.metadata;
    this._encryptedData = init.encryptedData;
    this._encryptedPreviousData = init.encryptedPreviousData;
    this._dekWrapped = init.dekWrapped;
    this._dekKeyVersion = init.dekKeyVersion;
  }

  get responsibleUserId(): IAuditLogEntity['responsibleUserId'] {
    return this._responsibleUserId;
  }

  set responsibleUserId(value: IAuditLogEntity['responsibleUserId']) {
    this.setProperty('responsibleUserId', value);
  }

  get responsibleServiceAccountId(): IAuditLogEntity['responsibleServiceAccountId'] {
    return this._responsibleServiceAccountId;
  }

  set responsibleServiceAccountId(value: IAuditLogEntity['responsibleServiceAccountId']) {
    this.setProperty('responsibleServiceAccountId', value);
  }

  get responsibleIp(): IAuditLogEntity['responsibleIp'] {
    return this._responsibleIp;
  }

  set responsibleIp(value: IAuditLogEntity['responsibleIp']) {
    this.setProperty('responsibleIp', value);
  }

  get resourceType(): IAuditLogEntity['resourceType'] {
    return this._resourceType;
  }

  set resourceType(value: IAuditLogEntity['resourceType']) {
    this.setProperty('resourceType', value);
  }

  get resourceId(): IAuditLogEntity['resourceId'] {
    return this._resourceId;
  }

  set resourceId(value: IAuditLogEntity['resourceId']) {
    this.setProperty('resourceId', value);
  }

  get resourceDatabase(): IAuditLogEntity['resourceDatabase'] {
    return this._resourceDatabase;
  }

  set resourceDatabase(value: IAuditLogEntity['resourceDatabase']) {
    this.setProperty('resourceDatabase', value);
  }

  get correlationId(): IAuditLogEntity['correlationId'] {
    return this._correlationId;
  }

  set correlationId(value: IAuditLogEntity['correlationId']) {
    this.setProperty('correlationId', value);
  }

  get causationId(): IAuditLogEntity['causationId'] {
    return this._causationId;
  }

  set causationId(value: IAuditLogEntity['causationId']) {
    this.setProperty('causationId', value);
  }

  get action(): IAuditLogEntity['action'] {
    return this._action;
  }

  set action(value: IAuditLogEntity['action']) {
    this.setProperty('action', value);
  }

  get eventType(): IAuditLogEntity['eventType'] {
    return this._eventType;
  }

  set eventType(value: IAuditLogEntity['eventType']) {
    this.setProperty('eventType', value);
  }

  get success(): IAuditLogEntity['success'] {
    return this._success;
  }

  set success(value: IAuditLogEntity['success']) {
    this.setProperty('success', value);
  }

  // `data`/`previousData` can carry PHI. @Secret() marks them
  // for audit-log redaction (defense-in-depth). Plaintext is retained for the
  // dual-read soak; the encrypted ciphertext lives in `encrypted*` columns.
  @Secret()
  get data(): IAuditLogEntity['data'] {
    return this._data;
  }

  set data(value: IAuditLogEntity['data']) {
    this.setProperty('data', value);
  }

  @Secret()
  get previousData(): IAuditLogEntity['previousData'] {
    return this._previousData;
  }

  set previousData(value: IAuditLogEntity['previousData']) {
    this.setProperty('previousData', value);
  }

  get metadata(): IAuditLogEntity['metadata'] {
    return this._metadata;
  }

  set metadata(value: IAuditLogEntity['metadata']) {
    this.setProperty('metadata', value);
  }

  // Envelope-encryption ciphertext + wrapped-DEK metadata.
  // @Secret() keeps the ciphertext off any audit-log surface. Set by the
  // applications-layer AuditLog encryption helper before persistence.
  @Secret()
  get encryptedData(): IAuditLogEntity['encryptedData'] {
    return this._encryptedData;
  }

  set encryptedData(value: IAuditLogEntity['encryptedData']) {
    this.setProperty('encryptedData', value);
  }

  @Secret()
  get encryptedPreviousData(): IAuditLogEntity['encryptedPreviousData'] {
    return this._encryptedPreviousData;
  }

  set encryptedPreviousData(value: IAuditLogEntity['encryptedPreviousData']) {
    this.setProperty('encryptedPreviousData', value);
  }

  get dekWrapped(): IAuditLogEntity['dekWrapped'] {
    return this._dekWrapped;
  }

  set dekWrapped(value: IAuditLogEntity['dekWrapped']) {
    this.setProperty('dekWrapped', value);
  }

  get dekKeyVersion(): IAuditLogEntity['dekKeyVersion'] {
    return this._dekKeyVersion;
  }

  set dekKeyVersion(value: IAuditLogEntity['dekKeyVersion']) {
    this.setProperty('dekKeyVersion', value);
  }

  public override validate(): void {
    super.validate();
    if (this._action === undefined || this._action === null) {
      throw new BusinessException('AuditLog action is required.');
    }
    if (!Object.values(Enums.AuditAction).includes(this._action)) {
      throw new BusinessException(`AuditLog action is invalid: ${String(this._action)}.`);
    }
    if (this._resourceType === undefined || this._resourceType === null) {
      throw new BusinessException('AuditLog resourceType is required.');
    }
    if (!Object.values(Enums.ResourceType).includes(this._resourceType)) {
      throw new BusinessException(`AuditLog resourceType is invalid: ${String(this._resourceType)}.`);
    }
    // an audited action has exactly ONE actor: a human
    // (`responsibleUserId`) or a machine (`responsibleServiceAccountId`).
    // A row naming both is unattributable — a reader cannot tell which one
    // actually performed the action.
    const hasHumanActor = this._responsibleUserId !== undefined && this._responsibleUserId !== null && this._responsibleUserId.trim().length > 0;
    const hasMachineActor =
      this._responsibleServiceAccountId !== undefined &&
      this._responsibleServiceAccountId !== null &&
      this._responsibleServiceAccountId.trim().length > 0;
    if (hasHumanActor && hasMachineActor) {
      throw new BusinessException('AuditLog must name exactly one actor — responsibleUserId and responsibleServiceAccountId are mutually exclusive.');
    }
    if (this._responsibleUserId !== undefined && this._responsibleUserId !== null && this._responsibleUserId.trim().length === 0) {
      throw new BusinessException('AuditLog responsibleUserId must not be blank when provided.');
    }
    if (this._responsibleIp && this._responsibleIp.length > 45) {
      throw new BusinessException('AuditLog responsibleIp must not exceed 45 characters.');
    }
    if (this._resourceId !== undefined && this._resourceId !== null && this._resourceId.trim().length === 0) {
      throw new BusinessException('AuditLog resourceId must not be blank when provided.');
    }
    if (this._eventType && this._eventType.length > 100) {
      throw new BusinessException('AuditLog eventType must not exceed 100 characters.');
    }
    // Note: data, previousData, metadata are Json columns. Per the audit contract,
    // Conservative Defaults, JSON shapes are track-only — no structural
    // validation at the domain layer.
  }
}
