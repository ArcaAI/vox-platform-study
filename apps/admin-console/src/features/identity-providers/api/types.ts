/**
 * Wire types mirroring the tenant-idp-config DTOs in @arcaai/applications
 * (TenantIdpConfigResponse and friends — the console cannot import that
 * server package, so the shapes are declared here once, matching the gateway).
 */

import type { ResourceStatus } from '@/shared/api';

export type IdpProtocol = 'OIDC' | 'SAML';
export type IdpStatus = 'DRAFT' | 'ENABLED' | 'DISABLED';
export type DirectoryProviderKey = 'ms-graph' | 'google-directory';

export interface ClaimMappings {
    email?: string;
    username?: string;
    name?: string;
    groups?: string;
}

export interface OidcProviderConfig {
    issuer: string;
    clientId: string;
    scopes?: string[];
    claimMappings?: ClaimMappings;
    groupToRoleMap?: Record<string, string>;
    defaultRoleId: string;
    defaultDepartmentId: string;
    jitEnabled?: boolean;
    enforceSsoOnly?: boolean;
    directoryProvider?: DirectoryProviderKey;
}

/** GET /admin/tenant-idp-config rows (TenantIdpConfigResponse). Secrets are never included. */
export interface TenantIdpConfig {
    id: string;
    tenantId: string;
    protocol: IdpProtocol;
    displayName: string;
    providerStatus: IdpStatus;
    config: OidcProviderConfig;
    hasSecret: boolean;
    hasDirectoryCredentials: boolean;
    resourceStatus?: ResourceStatus;
    version: number;
    createdAt?: string;
    updatedAt?: string;
}

export interface CreateTenantIdpConfigRequest {
    protocol: 'OIDC';
    displayName: string;
    config: OidcProviderConfig;
    clientSecret: string;
}

export interface UpdateTenantIdpConfigRequest {
    displayName?: string;
    config?: OidcProviderConfig;
    /** Omit to keep the currently-sealed secret; provide to rotate it. */
    clientSecret?: string;
    expectedVersion: number;
}

export interface TestConnectionResult {
    ok: boolean;
    providerStatus: IdpStatus;
    error?: string;
}

export interface SyncDirectoryResult {
    jobId: string;
}

/** MS Graph app-only client-credentials bundle (the tenant's own Azure AD app registration). */
export interface MsGraphDirectoryCredentials {
    azureTenantId: string;
    clientId: string;
    clientSecret: string;
}

/** Google Workspace domain-wide-delegated service-account bundle. */
export interface GoogleDirectoryCredentials {
    serviceAccountEmail: string;
    privateKey: string;
    delegatedAdminEmail: string;
    customerId?: string;
}

export type DirectoryCredentials = MsGraphDirectoryCredentials | GoogleDirectoryCredentials;

/** Minimal projection for the default-department picker (GET admin/departments). */
export interface DepartmentOption {
    id: string;
    code?: string | null;
    name?: string | null;
}

/** Minimal projection for the default-role picker + group->role mapping editor (GET admin/rbac/roles). */
export interface RoleOption {
    id: string;
    name: string;
    externalName?: string | null;
}
