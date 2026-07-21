/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Append-only WORM record of a single realtime-pipeline-policy edit
 * Phase 5). Mirrors `HarnessPolicyChange`.
 *
 * Immutable by design: the backing table has NO `_version` / `_metadata` /
 * `updatedAt` / `resourceStatus` columns and the migration REVOKEs UPDATE/DELETE
 * from the application role. The inherited base audit fields are stripped in
 * `PipelinePolicyChangeEntityMapper.toPersistence` so they are never written.
 * `scope`/`scopeId` record which cascade tier was edited; `beforeJson` is null
 * when the change CREATED the policy row.
 */
export interface IPipelinePolicyChangeEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  changedBy?: string | null;
  policyVersion?: number | null;
  beforeJson?: JsonValue | null;
  afterJson: JsonValue;
  reason?: string | null;
  // Vault-Transit (hope-phi) ciphertext of beforeJson/
  // afterJson + shared key version. Set ONLY on encrypted (new) rows; the
  // plaintext JSONB columns then hold a non-PHI redaction sentinel. Null on
  // legacy/plaintext rows. WORM table — immutable once written.
  encryptedBeforeJson?: Buffer | null;
  encryptedAfterJson?: Buffer | null;
  keyVersion?: number | null;
}

export class PipelinePolicyChangeEntity extends BaseTenantEntity {
  private _scope: IPipelinePolicyChangeEntity['scope'];
  private _scopeId?: IPipelinePolicyChangeEntity['scopeId'];
  private _changedBy?: IPipelinePolicyChangeEntity['changedBy'];
  private _policyVersion?: IPipelinePolicyChangeEntity['policyVersion'];
  private _beforeJson?: IPipelinePolicyChangeEntity['beforeJson'];
  private _afterJson: IPipelinePolicyChangeEntity['afterJson'];
  private _reason?: IPipelinePolicyChangeEntity['reason'];
  private _encryptedBeforeJson?: IPipelinePolicyChangeEntity['encryptedBeforeJson'];
  private _encryptedAfterJson?: IPipelinePolicyChangeEntity['encryptedAfterJson'];
  private _keyVersion?: IPipelinePolicyChangeEntity['keyVersion'];

  constructor(init: IPipelinePolicyChangeEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._changedBy = init.changedBy;
    this._policyVersion = init.policyVersion;
    this._beforeJson = init.beforeJson;
    this._afterJson = init.afterJson;
    this._reason = init.reason;
    this._encryptedBeforeJson = init.encryptedBeforeJson;
    this._encryptedAfterJson = init.encryptedAfterJson;
    this._keyVersion = init.keyVersion;
  }

  // Read-only accessors — the record is immutable once created (WORM). No
  // setters are exposed: an "update" to a change record is a new appended row.

  get scope(): IPipelinePolicyChangeEntity['scope'] {
    return this._scope;
  }

  get scopeId(): IPipelinePolicyChangeEntity['scopeId'] {
    return this._scopeId;
  }

  get changedBy(): IPipelinePolicyChangeEntity['changedBy'] {
    return this._changedBy;
  }

  get policyVersion(): IPipelinePolicyChangeEntity['policyVersion'] {
    return this._policyVersion;
  }

  // @Secret() marks the before/after policy snapshots for
  // audit-log redaction. On encrypted rows these hold a redaction sentinel; the
  // real value lives in the encrypted* columns (use the repo decrypt helper).
  @Secret()
  get beforeJson(): IPipelinePolicyChangeEntity['beforeJson'] {
    return this._beforeJson;
  }

  @Secret()
  get afterJson(): IPipelinePolicyChangeEntity['afterJson'] {
    return this._afterJson;
  }

  get reason(): IPipelinePolicyChangeEntity['reason'] {
    return this._reason;
  }

  // Vault-Transit ciphertext (read-only; WORM).
  @Secret()
  get encryptedBeforeJson(): IPipelinePolicyChangeEntity['encryptedBeforeJson'] {
    return this._encryptedBeforeJson;
  }

  @Secret()
  get encryptedAfterJson(): IPipelinePolicyChangeEntity['encryptedAfterJson'] {
    return this._encryptedAfterJson;
  }

  get keyVersion(): IPipelinePolicyChangeEntity['keyVersion'] {
    return this._keyVersion;
  }

  public override validate(): void {
    super.validate();
    if (this._afterJson === undefined || this._afterJson === null) {
      throw new BusinessException('PipelinePolicyChange afterJson is required.');
    }
  }
}
