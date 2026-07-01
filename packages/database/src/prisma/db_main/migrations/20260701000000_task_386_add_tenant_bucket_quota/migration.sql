-- TASK-386 (#5) — Platform Runtime Metrics Backend: storage quota source.
-- Adds an OPTIONAL per-bucket storage quota (in bytes) so the consumption /
-- usage roll-up (#18, #4/#5) can surface storageQuotaBytes. Backward-compatible:
-- the column is nullable with no default (existing rows read NULL = "no quota
-- configured"); the index is additive. No DROP/DELETE/TRUNCATE.

-- AlterTable
ALTER TABLE "core"."TenantBucket" ADD COLUMN     "quotaBytes" BIGINT;
