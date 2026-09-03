-- (owner decision, 2026-08-20): make `Role` genuinely
-- tenant-scoped so a tenant admin can manage its OWN tenant's custom roles.
--
-- `Role` was a GLOBAL table. CASL `conditions` are shadow-mode, so the seeded
-- `rbac-tenant-manage` rule `{ isSystemRole: false }` constrained nothing at
-- request time: granting a tenant admin write access to its own custom roles
-- would also have let it edit or delete the SYSTEM roles every other tenant
-- depends on. With a real `tenantId` the boundary moves into the tenant-scope
-- Prisma extension (`packages/database/src/extensions/tenant-scope.ts`), where
-- it holds for every current and future call site instead of per handler.
--
-- Backfill target: the SYSTEM tenant. Every `Role` row that can exist today was
-- written by `seed/03-role.ts` (SUPER_ADMIN, TENANT_ADMIN, DOCTOR, NURSE,
-- SERVICE_ACCOUNT, DEPARTMENT_HEAD, SENIOR_NURSE) — no tenant has ever been
-- able to create one, because there was no route a tenant admin could reach.
-- So every existing row is unambiguously a platform/built-in role, and the
-- backfill is total rather than a heuristic. `Role` is also in
-- SYSTEM_SHARED_READ_MODELS, so these rows stay readable from every tenant
-- (reads widen to `tenantId IN [caller, SYSTEM]`); writes are NOT widened.

-- AlterTable. Added NULLABLE first so existing rows survive the DDL, then
-- backfilled, then constrained — a bare `ADD COLUMN ... NOT NULL` (what Prisma
-- generated) aborts on any non-empty table. No DEFAULT: per the standard field
-- template a default `tenantId` is banned, so every writer must supply it.
ALTER TABLE "core"."Role" ADD COLUMN "tenantId" TEXT;

UPDATE "core"."Role" SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;

ALTER TABLE "core"."Role" ALTER COLUMN "tenantId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "core"."Role"("tenantId");
