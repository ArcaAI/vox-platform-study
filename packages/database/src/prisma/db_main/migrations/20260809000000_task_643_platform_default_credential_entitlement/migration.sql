-- The platform-default-credential entitlement grant.
--
-- Two additive boolean columns. They decide whether a tenant's provider-
-- credential cascade may reach the SYSTEM (platform-funded) tier — i.e. whether
-- the platform spends its own money serving a tenant that brought no key.
--
-- STATEMENT 1 — PlanEntitlement (the platform reference matrix, one row per
-- TenantPlan). NOT NULL DEFAULT false: a plan either grants or it does not,
-- there is no "inherit" above it. `false` is the fail-CLOSED backfill, and it
-- is also the value every plan is seeded with (OD-7 — no tier carries the
-- grant; it is sold per tenant). Note the seed's plan upsert is create-only
-- (`update: {}`), so an ALREADY-DEPLOYED row does NOT pick the value up from a
-- re-seed — it takes this DEFAULT instead. Both routes land on `false`, but for
-- two different reasons, and only this one applies to existing environments.
--
-- STATEMENT 2 — TenantEntitlement (the per-tenant override, every column
-- nullable = "inherit"). NULLABLE ON PURPOSE and with NO default: the column is
-- tri-state — NULL inherits the plan, `true` grants, `false` is an explicit
-- deny that survives a later plan-level flip. A NOT NULL DEFAULT here would
-- collapse "inherit" into "deny" and silently pin every existing override row.
--
-- Additive and non-destructive: no data is read, moved or dropped, and every
-- existing row resolves exactly as it did before (ungranted). Roll forward only.

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "featurePlatformDefaultCredential" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "featurePlatformDefaultCredential" BOOLEAN;
