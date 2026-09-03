/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { ConsentGrantMethod, ConsentPurpose } from '../../../enums';

// HAND-AUTHORED — (consent-abac). `gen:entity` reconciles this file
// against the committed source of truth and checks schema coverage; it does
// NOT scaffold it (see .claude/rules/03-domain-layer.md §Generated Code
// Discipline). Follows AiProviderConnectionEntity verbatim.
//
// One row per (tenant, externalPatientId, purpose) — see consent.prisma and
// This entity
// carries only structural invariants; the ABAC evaluation itself
// (`assertConsent`/`checkConsent`) lives in
// packages/applications/src/services/consent/.
export interface IConsentGrantEntity extends IBaseTenantEntity {
  externalPatientId: string;
  purpose: ConsentPurpose;
  scope?: Record<string, unknown> | null;
  grantedAt: Date;
  grantedBy: string;
  grantMethod: ConsentGrantMethod;
  evidenceRef?: string | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  revokedBy?: string | null;
  revocationReason?: string | null;
}

export class ConsentGrantEntity extends BaseTenantEntity {
  private _externalPatientId: IConsentGrantEntity['externalPatientId'];
  private _purpose: IConsentGrantEntity['purpose'];
  private _scope?: IConsentGrantEntity['scope'];
  private _grantedAt: IConsentGrantEntity['grantedAt'];
  private _grantedBy: IConsentGrantEntity['grantedBy'];
  private _grantMethod: IConsentGrantEntity['grantMethod'];
  private _evidenceRef?: IConsentGrantEntity['evidenceRef'];
  private _expiresAt?: IConsentGrantEntity['expiresAt'];
  private _revokedAt?: IConsentGrantEntity['revokedAt'];
  private _revokedBy?: IConsentGrantEntity['revokedBy'];
  private _revocationReason?: IConsentGrantEntity['revocationReason'];

  constructor(init: IConsentGrantEntity) {
    super(init);
    this._externalPatientId = init.externalPatientId;
    this._purpose = init.purpose;
    this._scope = init.scope;
    this._grantedAt = init.grantedAt;
    this._grantedBy = init.grantedBy;
    this._grantMethod = init.grantMethod;
    this._evidenceRef = init.evidenceRef;
    this._expiresAt = init.expiresAt;
    this._revokedAt = init.revokedAt;
    this._revokedBy = init.revokedBy;
    this._revocationReason = init.revocationReason;
  }

  get externalPatientId(): IConsentGrantEntity['externalPatientId'] {
    return this._externalPatientId;
  }

  get purpose(): IConsentGrantEntity['purpose'] {
    return this._purpose;
  }

  get scope(): IConsentGrantEntity['scope'] {
    return this._scope;
  }

  get grantedAt(): IConsentGrantEntity['grantedAt'] {
    return this._grantedAt;
  }

  get grantedBy(): IConsentGrantEntity['grantedBy'] {
    return this._grantedBy;
  }

  get grantMethod(): IConsentGrantEntity['grantMethod'] {
    return this._grantMethod;
  }

  get evidenceRef(): IConsentGrantEntity['evidenceRef'] {
    return this._evidenceRef;
  }

  set evidenceRef(value: IConsentGrantEntity['evidenceRef']) {
    this.setProperty('evidenceRef', value);
  }

  get expiresAt(): IConsentGrantEntity['expiresAt'] {
    return this._expiresAt;
  }

  set expiresAt(value: IConsentGrantEntity['expiresAt']) {
    this.setProperty('expiresAt', value);
  }

  get revokedAt(): IConsentGrantEntity['revokedAt'] {
    return this._revokedAt;
  }

  get revokedBy(): IConsentGrantEntity['revokedBy'] {
    return this._revokedBy;
  }

  get revocationReason(): IConsentGrantEntity['revocationReason'] {
    return this._revocationReason;
  }

  /**
   * True when the grant is presently usable: not revoked, and either
   * unexpiring or not yet past `expiresAt`. Does NOT check purpose or scope —
   * callers compare `purpose` themselves (one row per purpose) and call
   * {@link coversScope} for scope.
   */
  isActive(now: Date = new Date()): boolean {
    if (this._revokedAt != null && this._revokedAt.getTime() <= now.getTime()) return false;
    if (this._expiresAt != null && this._expiresAt.getTime() <= now.getTime()) return false;
    return true;
  }

  /**
   * Revoke the grant. Change-tracked through `setProperty` — the caller
   * still owes a `repository.updateWithVersion` write. Idempotent: revoking
   * an already-revoked grant does not overwrite the original `revokedAt`.
   */
  revoke(revokedBy: string, reason?: string | null, now: Date = new Date()): void {
    if (this._revokedAt != null) return;
    this.setProperty('revokedAt', now);
    this.setProperty('revokedBy', revokedBy);
    if (reason !== undefined) this.setProperty('revocationReason', reason);
  }

  /**
   * Minimal structural containment check — see consent- for the
   * exact semantics this implements (and does not implement). Every key
   * present in `requested` must be present in this grant's `scope`; a
   * `dateRangeDays` key additionally requires the grant's value to be >= the
   * requested value (a wider window covers a narrower request). Any other
   * key compares by strict equality. A grant with no `scope` at all covers
   * only an empty (or absent) request.
 */
  coversScope(requested?: Record<string, unknown> | null): boolean {
    if (requested == null || Object.keys(requested).length === 0) return true;
    const granted = this._scope ?? {};
    for (const [key, requestedValue] of Object.entries(requested)) {
      const grantedValue = granted[key];
      if (key === 'dateRangeDays') {
        if (typeof grantedValue !== 'number' || typeof requestedValue !== 'number' || grantedValue < requestedValue) return false;
        continue;
      }
      if (grantedValue !== requestedValue) return false;
    }
    return true;
  }

  public override validate(): void {
    super.validate();
    if (!this._externalPatientId || this._externalPatientId.trim().length === 0) {
      throw new BusinessException('External patient id is required');
    }
    if (!this._purpose) {
      throw new BusinessException('Purpose is required');
    }
    if (!this._grantedBy || this._grantedBy.trim().length === 0) {
      throw new BusinessException('Granted-by user id is required');
    }
    if (!this._grantMethod) {
      throw new BusinessException('Grant method is required');
    }
    if (this._expiresAt != null && this._expiresAt.getTime() <= this._grantedAt.getTime()) {
      throw new BusinessException('Expiry must be after the grant date');
    }
  }
}
