-- Eval-gated promotion: golden-set department scoping + eval-run
-- provenance/trigger attribution. All statements are additive + idempotent
-- (dev/test Postgres is db-push-managed; applied via psql, never a reset).

-- GoldenSet: optional department scoping (OD-5). NULL => tenant-wide.
ALTER TABLE "core"."GoldenSet" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;

CREATE INDEX IF NOT EXISTS "GoldenSet_tenant_department_idx"
  ON "core"."GoldenSet" ("tenantId", "departmentId");

-- EvalRun: pin-addressable prompt version number + trigger attribution.
ALTER TABLE "core"."EvalRun" ADD COLUMN IF NOT EXISTS "promptVersionNumber" INTEGER;
ALTER TABLE "core"."EvalRun" ADD COLUMN IF NOT EXISTS "triggerType" TEXT;
