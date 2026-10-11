-- TASK-1062 D-3: structure-only exemplar column. Nullable, no default — existing rows are
-- filled by packages/database/scripts/backfill-exemplar-structure-after.ts; until then the
-- few-shot retriever skips them (it reads only "structureAfter").

-- AlterTable
ALTER TABLE "core"."GateEditExemplar" ADD COLUMN     "structureAfter" TEXT;
