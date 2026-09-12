-- TASK-958 — multiple provider connections per tenant.
--
-- Prisma's generated draft emitted `ADD COLUMN "slug" TEXT NOT NULL` with NO
-- backfill, which cannot run on a non-empty table. The statement ORDER below is
-- therefore HAND-AUTHORED and load-bearing, and
-- `migration-sql.task-958.test.ts` pins it:
--
--   1. add the three columns, `slug` NULLABLE
--   2. backfill  slug = provider, defaultForProvider = provider
--   3. only then ALTER COLUMN "slug" SET NOT NULL
--   4. drop the old (tenantId, service, provider) unique
--   5. create the two new uniques
--   6. AiUsageEvent.connectionId + its index
--
-- Re-generating this migration from the schema would silently restore the
-- unbackfilled draft; edit it here instead.
--
-- The backfill is unconditional, tombstones included: the OLD unique covered
-- every row whatever its `resourceStatus`, so the pre-migration table holds at
-- most ONE row per (tenantId, service, provider) and
-- `defaultForProvider = provider` cannot collide on the new unique.

-- 1. AlterTable — `slug` lands NULLABLE so existing rows survive the statement.
ALTER TABLE "core"."AiProviderConnection" ADD COLUMN     "defaultForProvider" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "slug" TEXT;

-- 2. Backfill — every pre-TASK-958 row IS its provider's default connection and
-- keeps being addressed by the same string it is addressed by today, which is
-- what makes every existing route, BYO model slug and catalogue id unchanged.
UPDATE "core"."AiProviderConnection"
SET "slug" = "provider",
    "defaultForProvider" = "provider"
WHERE "slug" IS NULL;

-- 3. Now the column can carry the schema's NOT NULL.
ALTER TABLE "core"."AiProviderConnection" ALTER COLUMN "slug" SET NOT NULL;

-- 4. DropIndex — identity is no longer (tenant, service, provider).
DROP INDEX "core"."AiProviderConnection_tenantId_service_provider_key";

-- 5. CreateIndex — identity, and "at most one DEFAULT per provider" (NULLs are
-- distinct in Postgres, so every non-default sibling carries NULL and is free).
CREATE UNIQUE INDEX "AiProviderConnection_tenant_service_slug_key" ON "core"."AiProviderConnection"("tenantId", "service", "slug");

CREATE UNIQUE INDEX "AiProviderConnection_tenant_service_default_key" ON "core"."AiProviderConnection"("tenantId", "service", "defaultForProvider");

-- 6. AlterTable — ledger attribution (which of the tenant's keys was spent).
ALTER TABLE "core"."AiUsageEvent" ADD COLUMN     "connectionId" TEXT;

-- CreateIndex
CREATE INDEX "AiUsageEvent_connectionId_idx" ON "core"."AiUsageEvent"("connectionId");
