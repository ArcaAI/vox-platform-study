# TASK-519 — Segment-level transcript + evidence links

**Status:** Completed
**Type:** feature
**Parent program:** TASK-508 Phase 6 (Accuracy wave)
**Depends on:** TASK-515 (`assemble_generation_prompt`, StrictCitations mechanism)

> **Live-path note (2026-07-19):** assemble → GenerateInput wiring landed — see Change History.

## Requirement Analysis

Ground clinical claims to the *segment* (diarized turn) of the transcript they
came from, so downstream provenance is sentence-level rather than
whole-transcript.

- `createTranscript` receiving segment metadata must persist **N `TranscriptSegment`
  rows** — `id, idx, t0Ms/t1Ms, speaker?, charStart/charEnd` — one per diarized turn.
- NER grounding / citation provenance resolves a character offset into the
  transcript → the owning segment id.
- `SummaryMeta.citationsMap` gains segment-level evidence.
- **Out of scope (deferred):** SSE / console click-to-source (TASK-512 addendum);
  streaming path is unaffected (segments arrive on finals only).

### PHI posture

The segment **text is not stored**. A segment is only structural metadata plus
`[charStart, charEnd)` offsets into the parent transcript's already-encrypted
content, so this introduces **no new plaintext-PHI surface** (TASK-369 posture).
`TranscriptSegment` is tenant-scoped and soft-delete **exempt** (lives/dies with
its parent transcript, like `NamedEntity` / `AudioRecording`).

## Current State Evaluation

- `sttInternal.service.ts` **dropped** the request `metadata` (gap **D8**) — segment
  timings arriving from STT were lost.
- Citations were whole-transcript; no per-segment linkage existed.

## Implementation Plan (TDD)

1. **RED** — `transcript-segments.test.ts` for the pure helpers
   (`computeSegmentOffsets`, `resolveSegmentIdForOffset`, `attachSegmentEvidence`);
   `sttInternal.service.test.ts` segment-persistence cases.
2. **GREEN** — additive `TranscriptSegment` table + migration; hand-authored domain
   trio; ingest change; citations enrichment.
3. **REFACTOR** — keep enrichment best-effort and offset-resolution pure.

## Implementation Summary

### Database (additive)
- `packages/database/src/prisma/db_main/consultation.prisma` — new `model
  TranscriptSegment` (tenant-scoped, soft-delete exempt).
- `packages/database/src/prisma/db_main/migrations/20260719030000_task_519_transcript_segments/migration.sql`
  — **purely additive**: `CREATE TABLE IF NOT EXISTS "core"."TranscriptSegment"`,
  three indexes + a unique `(contextItemId, idx)`, and a guarded FK to
  `ContextItem`. No changes to existing columns/data.

Migration SQL (abridged):
```sql
CREATE TABLE IF NOT EXISTS "core"."TranscriptSegment" (
  "_metadata" JSONB, "_version" INTEGER NOT NULL DEFAULT 1,
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "contextItemId" TEXT NOT NULL,
  "idx" INTEGER NOT NULL, "t0Ms" INTEGER, "t1Ms" INTEGER, "speaker" TEXT,
  "charStart" INTEGER, "charEnd" INTEGER,
  "createdBy" TEXT DEFAULT '6000...0000', "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TranscriptSegment_item_idx_unique"
  ON "core"."TranscriptSegment"("contextItemId", "idx");
-- + tenantId / contextItemId / (tenantId,contextItemId) indexes, guarded FK
```

### Domain (hand-authored trio, mirrors generated peers)
- `TranscriptSegmentModel.ts`, `TranscriptSegmentEntity.ts`,
  `TranscriptSegmentEntityMapper.ts`, `TranscriptSegmentFactory.ts`,
  `TranscriptSegmentRepository.ts` under `packages/domains/src/**/generated/core/`.
- Registered in each barrel `index.ts` (models/entities/mappers/factories/repositories)
  and in `core.database.module.ts`.
- Added to `MODELS_WITHOUT_SOFT_DELETE` and the tenant-scope allow-list so the
  drift-guard tests stay green.

### Applications
- `consultation/lib/transcript-segments.ts` — pure helpers:
  - `computeSegmentOffsets` — resolve `[charStart, charEnd)` per segment from text.
  - `resolveSegmentIdForOffset` — map a char offset → owning segment id.
  - `attachSegmentEvidence` — enrich a `citationsMap` with `segmentId` provenance.
- `stt/internal/dto/internal.request.ts` — new `TranscriptSegmentInput` +
  `segments?: TranscriptSegmentInput[]` on `CreateTranscriptRequest`.
- `stt/internal/sttInternal.service.ts` — optional trailing
  `TranscriptSegmentRepository` injection (arity-preserving); `persistTranscriptSegments`
  called from both `createTranscript` and the streaming path; **falls back to
  `metadata.segments`** (fixes D8). Persistence is best-effort — it never fails the ingest.
- `consultation/harness/harness-internal.service.ts` — optional trailing
  `TranscriptSegmentRepository`; `enrichCitationsWithSegments` runs before persisting
  `SummaryMeta.citationsMap` in `persistDraft` (legacy) and `finalizeAssurance`
  (optimistic). Enrichment only applies when exactly one transcript exists for the
  consultation (avoids ambiguous offset resolution).

### Citations
Two complementary paths:

1. **Prompt-level StrictCitations (harness finalize generate)** — when
   `GenerateInput.segment_citations` is supplied, `generate` folds a PHI-safe
   `[[seg:<id>]]` instruction + allowed-id list (speaker/time/idx hints only —
   no segment plaintext) via `build_segment_citations_block` /
   `assemble_generation_prompt`. Invalid ids are droppable by
   `extract_cited_segment_ids` (mirrors RAG `[[kb:<id>]]`). Absent/empty refs ⇒
   byte-identical to the pre-TASK-519 prompt (replay-safe, command-neutral).
2. **Post-hoc enrichment (applications)** — `attachSegmentEvidence` still
   enriches `citationsMap` claim offsets with `segmentId` at persist/finalize
   when exactly one transcript exists.

Click-to-source UI remains deferred.

### Live-path wire (assemble → generate)

On finalize generate, the durable loop now populates `GenerateInput.segment_citations`
from persisted rows:

1. `HarnessInternalService.assemble` loads `TranscriptSegment` rows for the
   **single** consultation transcript (same gate as citationsMap enrichment) and
   returns PHI-safe `segmentCitations: { id, idx, speaker?, t0Ms?, t1Ms? }[]`
   (never plaintext / char offsets).
2. `ApiClient.assemble` maps camelCase → `AssembleResponse.segment_citations`
   (additive-optional; absent ⇒ `[]`).
3. `HarnessDocWorkflow` threads `assembled.segment_citations` into **both**
   `GenerateInput` sites (main regen loop + optimistic `_regen_compute`).
4. Existing `generate` activity folds `build_segment_citations_block` when non-empty.

Empty / multi-transcript / unwired repo ⇒ `[]` ⇒ byte-identical prompt (replay-safe).

## Verification (actual)

- `pnpm --filter @arcaai/database build` → PASS (`tsc`, 0 errors)
- `pnpm --filter @arcaai/domains build` → PASS; `test` → **1365 passed, 2 skipped, 9 todo**
- `pnpm --filter @arcaai/applications build` → PASS; `test` → **6375 passed, 4 skipped**
  (incl. new `transcript-segments` + `sttInternal` segment-persistence cases)
- Live-path wire (2026-07-19):
  - `pnpm --filter @arcaai/applications test -- harness` → PASS
  - `conda run -n arcaenv pnpm py:harness:test` → **860 passed**, 3 warnings
  - replay-compat green (included in harness suite)

## Deviations

- The `TranscriptSegment` model was added to the existing **`consultation.prisma`**
  rather than a brand-new `transcript-segment.prisma` file — it is a consultation-domain
  model and colocating it matches the existing schema layout. Migration name and
  additive contract are unchanged.
- Segment-citation enrichment **and** assemble segment refs are gated on
  **single-transcript** consultations to keep offset→segment resolution
  unambiguous; multi-transcript is a follow-up.
- API controller unchanged — response is a plain interface proxied as-is; only
  the assemble DTO/service gained the additive `segmentCitations` field.

## Change History

| Date | Change |
|---|---|
| 2026-07-19 | Initial implementation (RED→GREEN): additive `TranscriptSegment` table + trio, D8 ingest fix, citationsMap segment enrichment. Gates green. |
| 2026-07-19 | Audit: clarified Citations section — no prompt-level `[[seg:]]`; post-hoc enrichment only. |
| 2026-07-19 | Prompt-level `[[seg:<id>]]` StrictCitations on harness finalize generate: `SegmentCitationRef` + `build_segment_citations_block` / `extract_cited_segment_ids` in `prompt_cache`; additive-optional `GenerateInput.segment_citations`; activity folds block when present. Post-hoc enrichment unchanged. |
| 2026-07-19 | **Live-path wire:** assemble returns PHI-safe `segmentCitations` → `AssembleResponse.segment_citations` → both workflow `GenerateInput` sites. RED→GREEN: applications assemble tests + harness workflow/api_client tests. |
