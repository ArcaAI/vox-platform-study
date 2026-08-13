-- Tenant-Scoped External Identity Provider (OIDC v1)
-- Additive only: two new enums + three new tenant-scoped tables under the
-- `core` schema. No data is touched. `IdpProtocol` ships both OIDC and SAML
-- values now (protocol-neutral data model, D1) — v1 service-layer validation
-- accepts OIDC only; SAML lands on this same schema via.

-- CreateEnum
CREATE TYPE "core"."IdpProtocol" AS ENUM ('OIDC', 'SAML');

-- CreateEnum
CREATE TYPE "core"."IdpStatus" AS ENUM ('DRAFT', 'ENABLED', 'DISABLED');

-- CreateTable
CREATE TABLE "core"."TenantIdentityProvider" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "protocol" "core"."IdpProtocol" NOT NULL,
    "displayName" TEXT NOT NULL,
    "providerStatus" "core"."IdpStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "encryptedSecretRef" TEXT,
    "directoryCredentialsRef" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantIdentityProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."FederatedIdentity" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "FederatedIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantIdentityProviderDomain" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "TenantIdentityProviderDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantIdentityProvider_tenantId_idx" ON "core"."TenantIdentityProvider"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantIdentityProvider_tenant_protocol_displayName_unique" ON "core"."TenantIdentityProvider"("tenantId", "protocol", "displayName");

-- CreateIndex
CREATE INDEX "FederatedIdentity_userId_idx" ON "core"."FederatedIdentity"("userId");

-- CreateIndex
CREATE INDEX "FederatedIdentity_tenantId_idx" ON "core"."FederatedIdentity"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedIdentity_providerId_subject_unique" ON "core"."FederatedIdentity"("providerId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "TenantIdentityProviderDomain_domain_unique" ON "core"."TenantIdentityProviderDomain"("domain");

-- CreateIndex
CREATE INDEX "TenantIdentityProviderDomain_providerId_idx" ON "core"."TenantIdentityProviderDomain"("providerId");

-- AddForeignKey
ALTER TABLE "core"."FederatedIdentity" ADD CONSTRAINT "FederatedIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "core"."TenantIdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."TenantIdentityProviderDomain" ADD CONSTRAINT "TenantIdentityProviderDomain_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "core"."TenantIdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
