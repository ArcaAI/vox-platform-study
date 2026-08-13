-- MCP external-tools registry (McpServer).
--
-- Purely ADDITIVE: one new table. McpServer is a STANDARD tenant-scoped config
-- model (tenantId + resourceStatus soft-delete + _version OCC + audit),
-- mirroring AiModel / AiTaskDefault. SYSTEM-tenant rows are the shared registry
-- every tenant's harness run reads to resolve a server; WRITES stay SYSTEM-only
-- (global-admin, service layer). `authRef` is a Vault PATH only — NEVER secret
-- material. The whole feature is default-OFF (HarnessPolicy.mcpToolsEnabled null
-- ⇒ off AND McpServer.enabled default false).
--
-- Additive + idempotent so it is safe to apply via `pnpm db:push` / psql on the
-- db-push-managed dev database (each CREATE is guarded).

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."McpServer" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseUrl" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'streamable-http',
    -- Vault PATH to the credential — NEVER secret bytes.
    "authRef" TEXT,
    "toolAllowlist" JSONB,
    -- Fail-safe default: unmarked servers are treated as external (cloud egress).
    "phiBoundary" TEXT NOT NULL DEFAULT 'external',
    -- Per-server runtime kill-switch — dormant until explicitly enabled.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one server row per (tenant, name); doubles as the tenant lookup.
CREATE UNIQUE INDEX IF NOT EXISTS "McpServer_tenant_name_unique" ON "core"."McpServer"("tenantId", "name");

-- AlterEnum — register McpServer as an auditable ResourceType (additive, idempotent).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'McpServer';
