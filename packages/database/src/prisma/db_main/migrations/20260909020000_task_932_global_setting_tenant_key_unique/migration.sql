-- ============================================================================
-- (tenantId, key) uniqueness on GlobalSetting (TASK-932 wave 4, lane S1-1).
--
-- `GlobalSetting` has only ever enforced `(tenantId, name, key)` uniqueness
-- (`GlobalSetting_tenantId_name_key_key` -- the schema's `name:` argument on
-- that `@@unique` never reached Postgres; see 02-database-prisma.md's
-- `name:` vs `map:` trap). `name` is a human label, not identity, so two rows
-- could share the SAME (tenantId, key) as long as their `name` differed --
-- exactly what `rate-limit.enabled` did, and exactly what
-- `settings-registry-write.service.ts`'s `pickBackingRow` documents having to
-- defend against (a duplicate SYSTEM row broke `AppSettingsService`'s
-- boot-time cache build outright: "duplicate platform key(s) detected").
--
-- Verified on the dev DB (2026-09-09): 0 duplicate (tenantId, key) pairs
-- across the 16 seeded namespaces (registry, rate-limit, feature-flags,
-- platform, general, stt, stt.config, text, ux-constants, admin,
-- arcaai-admin, arcaai-sdk, dna-regeneration, entitlements, metering,
-- pipeline), so the dedupe below is a no-op HERE and load-bearing wherever a
-- database already carries a collision.
--
-- DEDUPE FIRST -- the index cannot be created while duplicates exist. For
-- every LIVE (tenantId, key) group with more than one row, soft-delete every
-- row except the one the write lane's own adoption policy
-- (`pickBackingRow`) would keep: the `registry`-namespace row if one exists
-- (the lane's own row, the one the tenant cache reads), else the OLDEST by
-- `createdAt` (the row the platform has been serving the longest, so keeping
-- it changes no effective value). `id` is a final, deterministic tiebreak for
-- rows created in the same instant -- `pickBackingRow` never needs it in
-- practice, but a single SQL statement must resolve ties somehow.
--
-- Non-destructive: this is an UPDATE (soft delete via resourceStatus), never
-- a DROP/DELETE/TRUNCATE. Soft-deleted losers stay recoverable.
-- ============================================================================
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId", "key"
      ORDER BY ("namespace" = 'registry') DESC, "createdAt" ASC, "id" ASC
    ) AS "rn"
  FROM "core"."GlobalSetting"
  WHERE "resourceStatus" != 'DELETED'
)
UPDATE "core"."GlobalSetting" gs
SET "resourceStatus" = 'DELETED',
    "resourceStatusUpdatedAt" = CURRENT_TIMESTAMP,
    "resourceStatusUpdatedBy" = '60000000-0000-0000-0000-000000000000',
    "_version" = gs."_version" + 1
FROM ranked
WHERE gs."id" = ranked."id"
  AND ranked."rn" > 1;

-- CreateIndex
CREATE UNIQUE INDEX "GlobalSetting_tenantId_key_unique" ON "core"."GlobalSetting"("tenantId", "key");
