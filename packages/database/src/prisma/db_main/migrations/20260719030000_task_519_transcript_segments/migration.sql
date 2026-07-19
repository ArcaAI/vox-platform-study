-- TASK-519 — Segment-level transcript + evidence links (TranscriptSegment).
--
-- Purely ADDITIVE: one new table, no changes to existing columns/data. Each row
-- is an ordered segment (diarized turn / VAD segment) of a TRANSCRIPT context
-- item, carrying ONLY non-PHI structural metadata (ordinal, time span, speaker
-- label, and the [charStart, charEnd) character offsets into the parent
-- transcript's already-encrypted content). The segment text itself is NOT
-- duplicated — it is a slice of the transcript recoverable via the offsets — so
-- this table introduces no new plaintext-PHI surface (TASK-369 posture).
--
-- Like NamedEntity / AudioRecording it is TENANT-SCOPED but soft-delete EXEMPT
-- (no `resourceStatus` column; listed in MODELS_WITHOUT_SOFT_DELETE) — segments
-- live and die with their parent transcript.
--
-- Additive + idempotent so it is safe to apply via `pnpm db:push` / psql on the
-- db-push-managed dev database (every CREATE is guarded).

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."TranscriptSegment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextItemId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "t0Ms" INTEGER,
    "t1Ms" INTEGER,
    "speaker" TEXT,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranscriptSegment_item_idx_unique" ON "core"."TranscriptSegment"("contextItemId", "idx");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranscriptSegment_tenantId_idx" ON "core"."TranscriptSegment"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranscriptSegment_contextItemId_idx" ON "core"."TranscriptSegment"("contextItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranscriptSegment_tenant_item_idx" ON "core"."TranscriptSegment"("tenantId", "contextItemId");

-- AddForeignKey (guarded — Postgres has no IF NOT EXISTS for ADD CONSTRAINT)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TranscriptSegment_contextItemId_fkey'
  ) THEN
    ALTER TABLE "core"."TranscriptSegment"
      ADD CONSTRAINT "TranscriptSegment_contextItemId_fkey"
      FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
