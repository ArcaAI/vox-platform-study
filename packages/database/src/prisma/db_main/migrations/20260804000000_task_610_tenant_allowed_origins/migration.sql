-- Tenant Allowed Origins (CORS control plane)
-- Additive only: one new tenant-scoped table under the `core` schema plus one
-- new audit ResourceType enum member. No data is touched. TenantAllowedOrigin
-- holds one row per registered browser origin; `tenantId` is the OWNING
-- tenant (the reserved SYSTEM tenant owns platform-operated origins, valid
-- for every tenant at the application layer). Origin uniqueness is GLOBAL
-- (not per-tenant) — two tenants claiming the same origin would make the
-- runtime reverse index (Map<origin, ownerTenantId>) ambiguous.

-- CreateTable
CREATE TABLE "core"."TenantAllowedOrigin" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAllowedOrigin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Global uniqueness on `origin` — see the comment above and the model's own
-- comment in tenant-allowed-origin.prisma. NOT (tenantId, origin).
CREATE UNIQUE INDEX "TenantAllowedOrigin_origin_unique" ON "core"."TenantAllowedOrigin"("origin");

-- CreateIndex
CREATE INDEX "TenantAllowedOrigin_tenantId_idx" ON "core"."TenantAllowedOrigin"("tenantId");

-- AlterEnum — audit ResourceType for TenantAllowedOrigin mutations. Idempotent
-- (replay/shadow safe); not used within this migration, so PG12+ ADD
-- VALUE-in-transaction is fine.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantAllowedOrigin';
