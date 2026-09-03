/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

/**
 * Platform-issued machine identity for administration.
 *
 * HAND-AUTHORED — `gen:entity` reconciles and coverage-checks committed
 * entities; it never creates one (`03-domain-layer.md` §Generated Code
 * Discipline). Follows the `AiProviderConnection*` exemplar.
 *
 * This is the THIRD credential class. It shares no mechanism with tenant API
 * keys (`ApiKey`) or the shared peer-service token, because the
 * owner ruling forbids mixing the `/admin/*` and `/internal/*` planes. The
 * structural consequence enforced here is the SCOPE NAMESPACE: every scope must
 * start with `svc:`. The `admin:*` vocabulary belongs to tenant API keys; a
 * service account carrying it would put both classes in one scope space and
 * make the separation a convention rather than an invariant.
 *
 * NO SECRET MATERIAL lives on this entity. `credentialsRef` /
 * `previousCredentialsRef` are VAULT PATHS (`09-infrastructure-devops.md`
 * Tiers: "never put a credential in a DB column in plaintext"),
 * and `secretVerifier` / `previousSecretVerifier` are peppered one-way HMACs —
 * the same verifier shape `ApiKey.keyHash` uses. Business rules that need the
 * tenant→SYSTEM cascade or the issuance privilege gate live in
 * `ServiceAccountService`, not here.
 */
export const SVC_SCOPE_PREFIX = 'svc:';

/**
 * Reserved SYSTEM tenant — the CONFIG TIER that owns platform-wide rows. A
 * service account on this tenant is a PLATFORM account; anything else is
 * tenant-bound. `50000000-…` ("Global") is deliberately NOT special here: it is
 * a customer tenant like any other (`00-project-context.md` §"The two reserved
 * tenants are NOT two config tiers").
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface IServiceAccountEntity extends IBaseTenantEntity {
  clientId: string;
  displayName: string;
  description?: string | null;
  scopes: string[];
  allowedTenantIds?: string[] | null;
  allowedIps?: string[] | null;
  superAdmin: boolean;
  tokenTtlSeconds: number;
  lastUsedAt?: Date | null;
  credentialsRef: string;
  secretVerifier: string;
  previousCredentialsRef?: string | null;
  previousSecretVerifier?: string | null;
  previousCredentialExpiresAt?: Date | null;
  rotatedAt?: Date | null;
}

export class ServiceAccountEntity extends BaseTenantEntity {
  private _clientId: IServiceAccountEntity['clientId'];
  private _displayName: IServiceAccountEntity['displayName'];
  private _description?: IServiceAccountEntity['description'];
  private _scopes: IServiceAccountEntity['scopes'];
  private _allowedTenantIds?: IServiceAccountEntity['allowedTenantIds'];
  private _allowedIps?: IServiceAccountEntity['allowedIps'];
  private _superAdmin: IServiceAccountEntity['superAdmin'];
  private _tokenTtlSeconds: IServiceAccountEntity['tokenTtlSeconds'];
  private _lastUsedAt?: IServiceAccountEntity['lastUsedAt'];
  private _credentialsRef: IServiceAccountEntity['credentialsRef'];
  private _secretVerifier: IServiceAccountEntity['secretVerifier'];
  private _previousCredentialsRef?: IServiceAccountEntity['previousCredentialsRef'];
  private _previousSecretVerifier?: IServiceAccountEntity['previousSecretVerifier'];
  private _previousCredentialExpiresAt?: IServiceAccountEntity['previousCredentialExpiresAt'];
  private _rotatedAt?: IServiceAccountEntity['rotatedAt'];

  constructor(init: IServiceAccountEntity) {
    super(init);
    this._clientId = init.clientId;
    this._displayName = init.displayName;
    this._description = init.description;
    this._scopes = init.scopes;
    this._allowedTenantIds = init.allowedTenantIds;
    this._allowedIps = init.allowedIps;
    this._superAdmin = init.superAdmin;
    this._tokenTtlSeconds = init.tokenTtlSeconds;
    this._lastUsedAt = init.lastUsedAt;
    this._credentialsRef = init.credentialsRef;
    this._secretVerifier = init.secretVerifier;
    this._previousCredentialsRef = init.previousCredentialsRef;
    this._previousSecretVerifier = init.previousSecretVerifier;
    this._previousCredentialExpiresAt = init.previousCredentialExpiresAt;
    this._rotatedAt = init.rotatedAt;
  }

  get clientId(): IServiceAccountEntity['clientId'] {
    return this._clientId;
  }

  set clientId(value: IServiceAccountEntity['clientId']) {
    this.setProperty('clientId', value);
  }

  get displayName(): IServiceAccountEntity['displayName'] {
    return this._displayName;
  }

  set displayName(value: IServiceAccountEntity['displayName']) {
    this.setProperty('displayName', value);
  }

  get description(): IServiceAccountEntity['description'] {
    return this._description;
  }

  set description(value: IServiceAccountEntity['description']) {
    this.setProperty('description', value);
  }

  get scopes(): IServiceAccountEntity['scopes'] {
    return this._scopes;
  }

  set scopes(value: IServiceAccountEntity['scopes']) {
    this.setProperty('scopes', value);
  }

  get allowedTenantIds(): IServiceAccountEntity['allowedTenantIds'] {
    return this._allowedTenantIds;
  }

  set allowedTenantIds(value: IServiceAccountEntity['allowedTenantIds']) {
    this.setProperty('allowedTenantIds', value);
  }

  get allowedIps(): IServiceAccountEntity['allowedIps'] {
    return this._allowedIps;
  }

  set allowedIps(value: IServiceAccountEntity['allowedIps']) {
    this.setProperty('allowedIps', value);
  }

  get superAdmin(): IServiceAccountEntity['superAdmin'] {
    return this._superAdmin;
  }

  set superAdmin(value: IServiceAccountEntity['superAdmin']) {
    this.setProperty('superAdmin', value);
  }

  get tokenTtlSeconds(): IServiceAccountEntity['tokenTtlSeconds'] {
    return this._tokenTtlSeconds;
  }

  set tokenTtlSeconds(value: IServiceAccountEntity['tokenTtlSeconds']) {
    this.setProperty('tokenTtlSeconds', value);
  }

  get lastUsedAt(): IServiceAccountEntity['lastUsedAt'] {
    return this._lastUsedAt;
  }

  set lastUsedAt(value: IServiceAccountEntity['lastUsedAt']) {
    this.setProperty('lastUsedAt', value);
  }

  get credentialsRef(): IServiceAccountEntity['credentialsRef'] {
    return this._credentialsRef;
  }

  set credentialsRef(value: IServiceAccountEntity['credentialsRef']) {
    this.setProperty('credentialsRef', value);
  }

  get secretVerifier(): IServiceAccountEntity['secretVerifier'] {
    return this._secretVerifier;
  }

  set secretVerifier(value: IServiceAccountEntity['secretVerifier']) {
    this.setProperty('secretVerifier', value);
  }

  get previousCredentialsRef(): IServiceAccountEntity['previousCredentialsRef'] {
    return this._previousCredentialsRef;
  }

  set previousCredentialsRef(value: IServiceAccountEntity['previousCredentialsRef']) {
    this.setProperty('previousCredentialsRef', value);
  }

  get previousSecretVerifier(): IServiceAccountEntity['previousSecretVerifier'] {
    return this._previousSecretVerifier;
  }

  set previousSecretVerifier(value: IServiceAccountEntity['previousSecretVerifier']) {
    this.setProperty('previousSecretVerifier', value);
  }

  get previousCredentialExpiresAt(): IServiceAccountEntity['previousCredentialExpiresAt'] {
    return this._previousCredentialExpiresAt;
  }

  set previousCredentialExpiresAt(value: IServiceAccountEntity['previousCredentialExpiresAt']) {
    this.setProperty('previousCredentialExpiresAt', value);
  }

  get rotatedAt(): IServiceAccountEntity['rotatedAt'] {
    return this._rotatedAt;
  }

  set rotatedAt(value: IServiceAccountEntity['rotatedAt']) {
    this.setProperty('rotatedAt', value);
  }

  /** True for a PLATFORM account (SYSTEM tenant); false for a tenant-bound one. */
  get isPlatformAccount(): boolean {
    return this.tenantId === SYSTEM_TENANT_ID;
  }

  /** True while a rotation overlap window is still open at `now`. */
  isRotationOverlapActive(now: Date = new Date()): boolean {
    return !!this._previousSecretVerifier && !!this._previousCredentialExpiresAt && this._previousCredentialExpiresAt.getTime() > now.getTime();
  }

  public override validate(): void {
    super.validate();

    if (!this._clientId || this._clientId.trim().length === 0) {
      throw new BusinessException('ServiceAccount clientId is required');
    }
    if (!this._displayName || this._displayName.trim().length === 0) {
      throw new BusinessException('ServiceAccount displayName is required');
    }
    // A Vault PATH, never a secret VALUE — the row must always be able to say
    // WHERE the credential lives, or rotation and provisioning have no target.
    if (!this._credentialsRef || this._credentialsRef.trim().length === 0) {
      throw new BusinessException('ServiceAccount credentialsRef (Vault path) is required');
    }
    if (!this._secretVerifier || this._secretVerifier.trim().length === 0) {
      throw new BusinessException('ServiceAccount secretVerifier is required');
    }

    // A credential that can do nothing is a configuration error, not a valid
    // row: it would authenticate successfully and then be refused everywhere,
    // which reads as a platform bug rather than a mis-issued account.
    if (!Array.isArray(this._scopes) || this._scopes.length === 0) {
      throw new BusinessException('ServiceAccount must carry at least one svc:* scope');
    }
    const foreign = this._scopes.filter((scope) => typeof scope !== 'string' || !scope.startsWith(SVC_SCOPE_PREFIX));
    if (foreign.length > 0) {
      throw new BusinessException(
        `ServiceAccount scopes must all live in the '${SVC_SCOPE_PREFIX}' namespace; got: ${foreign.join(', ')}. ` +
          `The admin:* vocabulary belongs to tenant API keys and may never be carried by a service account.`,
      );
    }

    // `allowedTenantIds` is the PLATFORM-account working-tenant allow-list. On a
    // tenant-bound account it would be meaningless at best and a cross-tenant
    // widening at worst, so it is a structural error rather than ignored input.
    if (this._allowedTenantIds && this._allowedTenantIds.length > 0 && !this.isPlatformAccount) {
      throw new BusinessException('allowedTenantIds is a platform-account (SYSTEM tenant) concept; a tenant-bound service account may not carry one');
    }

    // Two-slot rotation: a previous credential without an expiry is an
    // UNBOUNDED second credential — precisely the thing rotation exists to
    // avoid.
    if ((this._previousSecretVerifier || this._previousCredentialsRef) && !this._previousCredentialExpiresAt) {
      throw new BusinessException(
        'A previous service-account credential must carry previousCredentialExpiresAt (a rotation overlap is always bounded)',
      );
    }

    if (!Number.isInteger(this._tokenTtlSeconds) || this._tokenTtlSeconds <= 0) {
      throw new BusinessException('ServiceAccount tokenTtlSeconds must be a positive integer');
    }
  }
}
