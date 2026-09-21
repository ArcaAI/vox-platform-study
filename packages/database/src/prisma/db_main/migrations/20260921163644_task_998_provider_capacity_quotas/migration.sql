-- TASK-998 OD-4 — per-provider cloud-ASR capacity quotas.
--
-- Additive only: three columns, all of which a pre-existing row can carry
-- without any backfill. A NULL `sttProviderQuotas` means "no opinion at this
-- tier", which resolves to unlimited (no enforcement), and the new plan flag
-- defaults to `false`, which only bounds a WRITE that was not expressible
-- before this migration. No index, no destructive DDL.
--
-- The seed (`seed/15-entitlements.ts`) sets `featureProviderQuotaAllocation`
-- true on PRO/ENTERPRISE for a FRESH database; the plan-matrix upsert is
-- create-only, so an existing database keeps the `false` default until a
-- platform admin sets it through `PATCH /admin/entitlements/plans/:plan`.

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "sttProviderQuotas" JSONB,
ADD COLUMN     "featureProviderQuotaAllocation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "sttProviderQuotas" JSONB;
