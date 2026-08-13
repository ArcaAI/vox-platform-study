-- Governance schema: SummaryMeta OCC (F-11) + GateEditExemplar
-- curation gate (F-24).
--
-- Purely ADDITIVE. No DROP / DELETE / TRUNCATE. Every statement is
-- IF NOT EXISTS-guarded (or guarded by a DO block for the enum), so it is safe to
-- re-apply on the db-push-managed dev/test databases, which sit ahead of
-- migration history.
--
-- 1. SummaryMeta."_version" — the optimistic-concurrency counter for the
--    two-phase optimistic-delivery write (persistDraft EARLY → finalizeAssurance
--    backfill). NOT NULL DEFAULT 1 so existing rows are valid immediately and the
--    first compare-and-set on any legacy row sees version 1.
-- 2. ExemplarCurationStatus enum + GateEditExemplar."curationStatus" (DEFAULT
--    'PENDING' ⇒ every existing mined row becomes an unreviewed proposal) + the
--    (tenantId, curationStatus) index backing the curation queue and the
--    enforce-mode retrieval filter.
--
-- NOTE: no ResourceType ADD VALUE is needed — 'GateEditExemplar' is already a
-- member (added by the gate-edit-exemplar migration), and the curation
-- write reuses it for its ResourceUpdated sys-event.

-- 1. SummaryMeta optimistic-concurrency counter.
ALTER TABLE "core"."SummaryMeta"
  ADD COLUMN IF NOT EXISTS "_version" INTEGER NOT NULL DEFAULT 1;

-- 2a. Curation verdict enum.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ExemplarCurationStatus' AND n.nspname = 'core'
  ) THEN
    CREATE TYPE "core"."ExemplarCurationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
  END IF;
END
$$;

-- 2b. Column. Existing mined rows become PENDING (unreviewed proposals).
ALTER TABLE "core"."GateEditExemplar"
  ADD COLUMN IF NOT EXISTS "curationStatus" "core"."ExemplarCurationStatus" NOT NULL DEFAULT 'PENDING';

-- 2c. Curation queue + enforce-mode retrieval filter.
CREATE INDEX IF NOT EXISTS "GateEditExemplar_tenant_curationStatus_idx"
  ON "core"."GateEditExemplar" ("tenantId", "curationStatus");
