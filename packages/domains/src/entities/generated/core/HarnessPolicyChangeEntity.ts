/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Append-only WORM record of a single harness-policy edit.
 *
 * Immutable by design: the backing table has NO `_version` / `_metadata` /
 * `updatedAt` / `resourceStatus` columns and the migration REVOKEs UPDATE/DELETE
 * from the application role. The inherited base audit fields are stripped in
 * `HarnessPolicyChangeEntityMapper.toPersistence` so they are never written.
 * `beforeJson` is null when the change CREATED the policy row.
 */
export interface IHarnessPolicyChangeEntity extends IBaseTenantEntity {
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

export class HarnessPolicyChangeEntity extends BaseTenantEntity {
  private _changedBy?: IHarnessPolicyChangeEntity['changedBy'];
  private _policyVersion?: IHarnessPolicyChangeEntity['policyVersion'];
  private _beforeJson?: IHarnessPolicyChangeEntity['beforeJson'];
  private _afterJson: IHarnessPolicyChangeEntity['afterJson'];
  private _reason?: IHarnessPolicyChangeEntity['reason'];
  private _encryptedBeforeJson?: IHarnessPolicyChangeEntity['encryptedBeforeJson'];
  private _encryptedAfterJson?: IHarnessPolicyChangeEntity['encryptedAfterJson'];
  private _keyVersion?: IHarnessPolicyChangeEntity['keyVersion'];

  constructor(init: IHarnessPolicyChangeEntity) {
    super(init);
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

  get changedBy(): IHarnessPolicyChangeEntity['changedBy'] {
    return this._changedBy;
  }

  get policyVersion(): IHarnessPolicyChangeEntity['policyVersion'] {
    return this._policyVersion;
  }

  // @Secret() marks the before/after policy snapshots for
  // audit-log redaction. On encrypted rows these hold a redaction sentinel; the
  // real value lives in the encrypted* columns (use the repo decrypt helper).
  @Secret()
  get beforeJson(): IHarnessPolicyChangeEntity['beforeJson'] {
    return this._beforeJson;
  }

  @Secret()
  get afterJson(): IHarnessPolicyChangeEntity['afterJson'] {
    return this._afterJson;
  }

  get reason(): IHarnessPolicyChangeEntity['reason'] {
    return this._reason;
  }

  // Vault-Transit ciphertext (read-only; WORM).
  @Secret()
  get encryptedBeforeJson(): IHarnessPolicyChangeEntity['encryptedBeforeJson'] {
    return this._encryptedBeforeJson;
  }

  @Secret()
  get encryptedAfterJson(): IHarnessPolicyChangeEntity['encryptedAfterJson'] {
    return this._encryptedAfterJson;
  }

  get keyVersion(): IHarnessPolicyChangeEntity['keyVersion'] {
    return this._keyVersion;
  }

  public override validate(): void {
    super.validate();
    if (this._afterJson === undefined || this._afterJson === null) {
      throw new BusinessException('HarnessPolicyChange afterJson is required.');
    }
  }
}
