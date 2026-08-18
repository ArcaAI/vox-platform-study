/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ServiceAccountEntity, IServiceAccountEntity } from '../../../entities';
import { generateId } from '../../../utils';

/**
 * HAND-AUTHORED (`gen:factory` reconciles barrels and checks schema coverage;
 * it never creates a factory — `03-domain-layer.md` §Generated Code
 * Discipline). Follows the `AiProviderConnectionFactory` exemplar.
 */
export interface CreateServiceAccountProps extends BaseEntityFactoryCreateProps {
  tenantId: IServiceAccountEntity['tenantId'];
  clientId: IServiceAccountEntity['clientId'];
  displayName: IServiceAccountEntity['displayName'];
  description?: IServiceAccountEntity['description'];
  scopes: IServiceAccountEntity['scopes'];
  allowedTenantIds?: IServiceAccountEntity['allowedTenantIds'];
  allowedIps?: IServiceAccountEntity['allowedIps'];
  superAdmin?: IServiceAccountEntity['superAdmin'];
  tokenTtlSeconds?: IServiceAccountEntity['tokenTtlSeconds'];
  credentialsRef: IServiceAccountEntity['credentialsRef'];
  secretVerifier: IServiceAccountEntity['secretVerifier'];
  previousCredentialsRef?: IServiceAccountEntity['previousCredentialsRef'];
  previousSecretVerifier?: IServiceAccountEntity['previousSecretVerifier'];
  previousCredentialExpiresAt?: IServiceAccountEntity['previousCredentialExpiresAt'];
  rotatedAt?: IServiceAccountEntity['rotatedAt'];

  createdAt?: IServiceAccountEntity['createdAt'];
  updatedAt?: IServiceAccountEntity['updatedAt'];
  createdBy?: IServiceAccountEntity['createdBy'];
  updatedBy?: IServiceAccountEntity['updatedBy'];
}

/** Platform default token TTL — short-lived by design. Mirrors the Prisma default. */
export const DEFAULT_SERVICE_ACCOUNT_TOKEN_TTL_SECONDS = 900;

export class ServiceAccountFactory {
  static CreateServiceAccount(props: CreateServiceAccountProps): ServiceAccountEntity {
    const id = generateId();
    const now = new Date();

    return new ServiceAccountEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      clientId: props.clientId,
      displayName: props.displayName,
      description: props.description ?? null,
      scopes: props.scopes,
      allowedTenantIds: props.allowedTenantIds ?? null,
      allowedIps: props.allowedIps ?? null,
      // Fail-safe default: a machine principal is NEVER elevated by omission.
      // §2.7 of the ticket: a principal that populates `roles` carelessly
      // silently becomes a super admin, so elevation is always an explicit,
      // persisted decision.
      superAdmin: props.superAdmin ?? false,
      tokenTtlSeconds: props.tokenTtlSeconds ?? DEFAULT_SERVICE_ACCOUNT_TOKEN_TTL_SECONDS,
      lastUsedAt: null,
      credentialsRef: props.credentialsRef,
      secretVerifier: props.secretVerifier,
      previousCredentialsRef: props.previousCredentialsRef ?? null,
      previousSecretVerifier: props.previousSecretVerifier ?? null,
      previousCredentialExpiresAt: props.previousCredentialExpiresAt ?? null,
      rotatedAt: props.rotatedAt ?? null,
    });
  }
}
