/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ENCRYPTED_PAYLOAD_SENTINEL } from '../../../common/field-encryption';
import { HarnessPolicyChangeEntity, IHarnessPolicyChangeEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateHarnessPolicyChangeProps extends BaseEntityFactoryCreateProps {
  tenantId: IHarnessPolicyChangeEntity['tenantId'];
  Tenant?: IHarnessPolicyChangeEntity['Tenant'];

  changedBy?: IHarnessPolicyChangeEntity['changedBy'];
  policyVersion?: IHarnessPolicyChangeEntity['policyVersion'];
  /** Null when this change CREATED the policy row. */
  beforeJson?: IHarnessPolicyChangeEntity['beforeJson'];
  afterJson: IHarnessPolicyChangeEntity['afterJson'];
  reason?: IHarnessPolicyChangeEntity['reason'];
  // When supplied (by the service, after Vault-Transit
  // encryption), the plaintext beforeJson/afterJson are replaced with a redaction
  // sentinel before persistence (per field). Omitted ⇒ legacy plaintext row.
  encryptedBeforeJson?: IHarnessPolicyChangeEntity['encryptedBeforeJson'];
  encryptedAfterJson?: IHarnessPolicyChangeEntity['encryptedAfterJson'];
  keyVersion?: IHarnessPolicyChangeEntity['keyVersion'];

  createdAt?: IHarnessPolicyChangeEntity['createdAt'];
  createdBy?: IHarnessPolicyChangeEntity['createdBy'];
}

export class HarnessPolicyChangeFactory {
  /**
   * Build an append-only policy-change record (before/after snapshot of a
   * single edit). Immutable once persisted (WORM); the service writes one of
   * these for every `updatePolicy` / `updateGlobalDefault` call.
   */
  static CreateHarnessPolicyChange(props: CreateHarnessPolicyChangeProps): HarnessPolicyChangeEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    const encryptedBeforeJson = props.encryptedBeforeJson ?? null;
    const encryptedAfterJson = props.encryptedAfterJson ?? null;

    // For an encrypted field, persist a non-PHI redaction sentinel in the
    // plaintext JSONB (immutable WORM column) — the ciphertext is the source of
    // truth. A null beforeJson has no ciphertext, so it stays null.
    const persistedBeforeJson = encryptedBeforeJson ? { ...ENCRYPTED_PAYLOAD_SENTINEL } : (props.beforeJson ?? null);
    const persistedAfterJson = encryptedAfterJson ? { ...ENCRYPTED_PAYLOAD_SENTINEL } : props.afterJson;

    return new HarnessPolicyChangeEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      changedBy: props.changedBy ?? null,
      policyVersion: props.policyVersion ?? null,
      beforeJson: persistedBeforeJson,
      afterJson: persistedAfterJson,
      reason: props.reason ?? null,
      encryptedBeforeJson,
      encryptedAfterJson,
      keyVersion: props.keyVersion ?? null,

      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
