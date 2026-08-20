-- TASK-766 OD-1 (owner decision, 2026-08-20): tenant admins must be able to
-- manage their own tenant's custom RBAC roles. `Role` was a GLOBAL table
-- (no tenantId), so CASL conditions (shadow-mode only) could not stop a
-- tenant admin from touching another tenant's roles or the platform's
-- built-in SYSTEM roles. This migration makes `Role` genuinely tenant-scoped
-- so it is protected automatically by the tenant-scope Prisma extension.
--
-- Backfill: every Role row seeded to date is a platform/built-in role
-- (TENANT_ADMIN, DOCTOR, NURSE, SERVICE_ACCOUNT, SUPER_ADMIN,
-- DEPARTMENT_HEAD, SENIOR_NURSE — see seed/03-role.ts) — no tenant has ever
-- been able to create a custom role, so every existing row is unambiguously
-- a SYSTEM-tenant row.

-- AlterTable: add nullable first so existing rows survive, backfill, THEN
-- enforce NOT NULL (no default — bootstrap-floor-only defaults are banned
-- per 00-project-context.md; every writer must supply tenantId explicitly).
ALTER TABLE "core"."Role" ADD COLUMN "tenantId" TEXT;

UPDATE "core"."Role" SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;

ALTER TABLE "core"."Role" ALTER COLUMN "tenantId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "core"."Role"("tenantId");
