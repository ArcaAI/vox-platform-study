/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ENCRYPTED_PAYLOAD_SENTINEL } from '../../../common/field-encryption';
import { PipelinePolicyChangeEntity, IPipelinePolicyChangeEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreatePipelinePolicyChangeProps extends BaseEntityFactoryCreateProps {
  tenantId: IPipelinePolicyChangeEntity['tenantId'];
  Tenant?: IPipelinePolicyChangeEntity['Tenant'];

  scope: IPipelinePolicyChangeEntity['scope'];
  scopeId?: IPipelinePolicyChangeEntity['scopeId'];
  changedBy?: IPipelinePolicyChangeEntity['changedBy'];
  policyVersion?: IPipelinePolicyChangeEntity['policyVersion'];
  /** Null when this change CREATED the policy row. */
  beforeJson?: IPipelinePolicyChangeEntity['beforeJson'];
  afterJson: IPipelinePolicyChangeEntity['afterJson'];
  reason?: IPipelinePolicyChangeEntity['reason'];
  // When supplied (by the service, after Vault-Transit
  // encryption), the plaintext beforeJson/afterJson are replaced with a redaction
  // sentinel before persistence (per field). Omitted ⇒ legacy plaintext row.
  encryptedBeforeJson?: IPipelinePolicyChangeEntity['encryptedBeforeJson'];
  encryptedAfterJson?: IPipelinePolicyChangeEntity['encryptedAfterJson'];
  keyVersion?: IPipelinePolicyChangeEntity['keyVersion'];

  createdAt?: IPipelinePolicyChangeEntity['createdAt'];
  createdBy?: IPipelinePolicyChangeEntity['createdBy'];
}

/** @deprecated TASK-861 — removed in R4 with `PipelinePolicy` (WORM log stays read-only until the drop). */
export class PipelinePolicyChangeFactory {
  /**
   * Build an append-only policy-change record (before/after snapshot of a
   * single edit). Immutable once persisted (WORM); the service writes one of
   * these for every policy create/update call.
   */
  static CreatePipelinePolicyChange(props: CreatePipelinePolicyChangeProps): PipelinePolicyChangeEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    const encryptedBeforeJson = props.encryptedBeforeJson ?? null;
    const encryptedAfterJson = props.encryptedAfterJson ?? null;

    // For an encrypted field, persist a non-PHI redaction sentinel in the
    // plaintext JSONB (immutable WORM column) — the ciphertext is the source of
    // truth. A null beforeJson has no ciphertext, so it stays null.
    const persistedBeforeJson = encryptedBeforeJson ? { ...ENCRYPTED_PAYLOAD_SENTINEL } : (props.beforeJson ?? null);
    const persistedAfterJson = encryptedAfterJson ? { ...ENCRYPTED_PAYLOAD_SENTINEL } : props.afterJson;

    return new PipelinePolicyChangeEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      scope: props.scope,
      scopeId: props.scopeId ?? null,
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
