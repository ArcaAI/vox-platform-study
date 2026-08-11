# TASK-656 — `mediaId` Correctness, Both Sides

**Status:** Review

## Header

| Field | Value |
|---|---|
| Ticket | TASK-656 |
| Type | Bugfix |
| Base branch | `dev-2.1` @ `09d8d0f7c` (merge(TASK-655): collapse the four-way live-snapshot resolver) |
| Commits | `4e66c1e1b`, `4d373183c`, `9931f6cd4` (see §Commits below) |

## ⚠ Required-reading discrepancy (read this first)

The assignment named two required-reading documents that **do not exist anywhere in this
repository**, in git history, or in `docs/archive/`:

- `docs/implementation/TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md`
- its companion `execution-plan.md`

Confirmed absent via `find docs/implementation -iname "TASK-654*"` (no match), `git log --all
--diff-filter=A --name-only | grep -i "consultation-context-schema"` (no match), and a scan of
every `TASK-65x` folder that DOES exist (650–653, 655 — 654 is simply missing from the sequence).
The assignment's own bug report anticipated this possibility ("verified 2026-08-11 — re-verify
before relying on it"), so rather than stop, every claim in the bug report was independently
re-verified against the actual code (see §Requirement Analysis) before any line was changed.
**All claims verified accurate.** This gap is flagged here for the record, not worked around
silently — if TASK-654 exists under a different name or was meant to be created first, that's a
process question for the ticket owner, not something this session could resolve from inside the
worktree.

## Requirement Analysis

`ContextItem.mediaId` is documented and consumed as a **`Media` table row UUID**. Two independent
bugs made it a raw S3 object key instead, and they canceled out for OCR while silently breaking
presigned URLs for every other consumer.

Verified against code (line numbers as of base commit `09d8d0f7c`):

- `StorageController.uploadFile` (`apps/api/src/modules/storage/storage.controller.ts:157-241`)
  was already CORRECT — it returns both `key` (the raw S3 key, `:220`) and `mediaId` (`media.id`,
  a real UUID, `:235`), and stores `Media.uri = s3://<bucket>/<key>` (`:229`).
- **Consumer bug**: `OcrEnrichmentProcessor` (`packages/applications/src/services/consultation/
  ocr/ocr-enrichment.processor.ts:119`, pre-fix) did
  `getObject({ bucket: this.ocrBucket, key: mediaId })` — treating `mediaId` as the literal S3
  key, never reading the `Media` row.
- **Producer bugs** (`apps/ui-playground`): `context-panel.tsx:101,110`, `consultation-recording-
  panel.tsx:145-146`, and `use-dual-capture.ts:107-115` (`rawMediaId`/`processedMediaId`) all
  destructured only `key` from the upload response and sent it as `mediaId`.
- **Already-correct implementations** (unchanged behavior, only their duplicated helper was
  collapsed): `ContextService.resolveMediaUrls` (`context.service.ts:986-1003`,
  `mediaRepository.findAll` → `parseStorageUri(media.uri)`) and `SmrProxyController
  .extractAttachmentText` (`smr-proxy.controller.ts:1103-1118`, `mediaRepository.findById` →
  `parseStorageUri(media.uri)`).
- **Net effect pre-fix**: OCR worked only by coincidence (both bugs canceled out); `resolveMediaUrls`
  matched nothing for anything uploaded through the three broken producer flows, so every such
  attachment/recording silently never resolved a presigned download or thumbnail URL.

## Current State Evaluation (post-fix)

- `parseStorageUri` exists in exactly one place: `packages/applications/src/common/storage-uri.ts`,
  exported via the package barrel. Both former call sites import it.
- `OcrEnrichmentProcessor` resolves `mediaId` → `Media` row → `{bucket, key}` before fetching
  bytes, exactly like the two implementations it used to disagree with.
- All three `apps/ui-playground` producers send `mediaId` (the UUID), not `key`.
- A backfill script exists to repair rows written before this fix shipped (see §Backfill).
- **Confirmed out of scope, left untouched, and why** (see individual commit messages for detail):
  - `case-note-form.tsx` also calls `storage.uploadFile()` and uses `.key`, but the value lands in
    an opaque `attachmentUrl` metadata field — never `ContextItem.mediaId`, never resolved via
    `MediaRepository`. Confirmed by grepping the entire backend for `attachmentUrl`: zero hits. A
    different, much lower-severity concern than a silently-broken presigned URL; not part of the
    verified bug report given to this session.
  - The separate `AudioRecording` table (`AudioRecording.mediaId`/`rawMediaId`/`processedMediaId`
    — a DIFFERENT table from `ContextItem`, populated by `addAudioRecording()`) also receives raw
    keys from the same three producer bugs (dual-capture and the local raw-capture path write
    here, not to `ContextItem.mediaId`). Confirmed via `ContextDtoMapper.toAudioRecordingResponse`
    that NOTHING currently resolves these fields through `MediaRepository` — they're returned
    raw, unresolved, to any caller. So today this is inert (no broken presigned URL, because
    nothing tries to presign it), not the bug this ticket was scoped to. Flagged as a background
    task (see below) rather than silently expanded into this ticket's diff — the assignment named
    three specific files with specific line numbers, not this table.

A follow-up task was spawned for the `AudioRecording` table finding (session-visible chip); it
was not required to complete TASK-656 as specified.

## Implementation Plan (as executed)

Three independently-revertable commits, exactly as specified in the assignment:

1. **Shared util** — promote the duplicated `parseStorageUri` to one exported function.
2. **Consumer fix + backfill** — fix `OcrEnrichmentProcessor`, add the repair script for rows
   already written with the raw-key bug.
3. **Producer fix** — the three `apps/ui-playground` call sites.

TDD: RED captured for both the consumer fix (5 real test failures against pre-fix code, full
output below) and the producer fix (test fixtures rewritten so `key` and `mediaId` are
deliberately different values — assertions on `mediaId` only pass with the fix). `resolveMediaUrls`
itself was never buggy (see §Requirement Analysis), so there is no meaningful RED/GREEN cycle to
capture for it in isolation; its behavior is locked in by the pre-existing test suite (all
8592 `@arcaai/applications` tests, including its own, stayed green throughout).

## Commits

### 1. `4e66c1e1b` — `refactor(TASK-656): collapse duplicated parseStorageUri into a shared util`

No behavior change. `packages/applications/src/common/storage-uri.ts` (new) exports
`parseStorageUri`; both `context.service.ts` and `smr-proxy.controller.ts` (`apps/api`) now import
it instead of carrying their own copy. New parity test:
`packages/applications/src/common/__tests__/storage-uri.test.ts`.

**Files:** `packages/applications/src/common/storage-uri.ts` (new),
`packages/applications/src/common/__tests__/storage-uri.test.ts` (new),
`packages/applications/src/common/index.ts`,
`packages/applications/src/services/consultation/context/context.service.ts`,
`apps/api/src/modules/streaming/smr-proxy.controller.ts`.

### 2. `4d373183c` — `fix(TASK-656): OcrEnrichmentProcessor resolves mediaId via the Media row + backfill`

Fixes the consumer bug (resolve `mediaId` via `MediaRepository.findById` → `parseStorageUri` →
`getObject({bucket, key})`, mirroring the two correct implementations); adds the backfill script
for existing corrupted rows (§Backfill). `MediaRepository` is wired as a new **optional trailing**
constructor dependency on `OcrEnrichmentProcessor`, mirroring how `ContextService` already wires
its own `MediaRepository` — already provided by `CoreDatabaseModule`, which
`LiveDocumentationServiceModule` (the module hosting `OcrEnrichmentProcessor`) already imports, so
**no module registration changes were needed**. The now-dead `OCR_STORAGE_BUCKET` config knob and
its `ocrBucket` field were removed (the bucket now always comes from the resolved `Media.uri`).

**Files:** `packages/applications/src/services/consultation/ocr/ocr-enrichment.processor.ts`,
`packages/applications/src/services/consultation/ocr/__tests__/ocr-enrichment.processor.test.ts`,
`packages/database/scripts/backfill-context-item-media-id.ts` (new),
`packages/database/scripts/__tests__/backfill-context-item-media-id.test.ts` (new).

### 3. `9931f6cd4` — `fix(TASK-656): send mediaId (not the raw storage key) from three ui-playground upload sites`

Fixes the three producer bugs. `StorageFile` (`packages/agentic-sdk-v2/src/hooks/useStorage.ts`)
gains an **optional additive** `mediaId?: string` field. `AddAudioRecordingInput.mediaId` in
`packages/agentic-sdk-v2/src/types/recording.ts` (untouched, per the hard constraint on
`src/types/*`) is a REQUIRED `string`, so the two audio-recording call sites add a runtime guard
(throw, caught by the existing try/catch) for the rare case the upload response's best-effort
`Media` row creation failed server-side.

**Files:** `packages/agentic-sdk-v2/src/hooks/useStorage.ts`,
`apps/ui-playground/src/features/clinical-workspace/components/context-panel.tsx` (+ test),
`apps/ui-playground/src/features/consultation/components/consultation-recording-panel.tsx` (+ test),
`apps/ui-playground/src/features/clinical-workspace/hooks/use-dual-capture.ts` (+ test).

### Why three separate commits

The assignment stated: *"the owner stated a second scope exclusion which was truncated in
transmission and may be `apps/ui-playground`."* Keeping the producer fix (commit 3) fully isolated
from the shared util (commit 1) and the consumer fix + backfill (commit 2) means commit 3 can be
`git revert`ed on its own — dropping only the `apps/ui-playground` changes — without unpicking
anything else, if that exclusion turns out to be real. Commits 1 and 2 have no dependency on
commit 3 (the backend fix is self-contained and correct on its own); commit 3 depends on nothing
backend-side changing (it only changes what the frontend *sends*).

## Backfill

**Script:** `packages/database/scripts/backfill-context-item-media-id.ts`

**What it does:** Finds every `ContextItem` row of type `ATTACHMENT` or `AUDIO_RECORDING` whose
`mediaId` is NOT a valid UUID (i.e. still carries the pre-fix raw storage key). For each:

1. Builds the canonical `uri = s3://<bucket>/<mediaId>` the raw key must have pointed at
   (`--bucket` defaults to `attachments` — the frontend's `STORAGE_BUCKET` constant and the
   processor's own pre-fix default).
2. **Resolves or creates** the matching `Media` row: looks for an existing row with that exact
   `uri` first (dedupes when multiple `ContextItem`s reference the same key within one run), or
   creates one with best-effort `name`/`extension`/`mimeType` derived from the key, `size: 0` and
   `hash: ''` (bytes are never read — this mirrors `StorageController.uploadFile`'s own
   best-effort `hash: ''`).
3. Rewrites `ContextItem.mediaId` to the resolved/created `Media.id` (plus the standard `_version`
   bump + `updatedBy` audit stamp).

**Safety:** Dry-run by default — nothing is written unless `--apply` is passed. All writes for one
run happen inside a single interactive transaction. **Idempotent by construction**: a rewritten
`mediaId` is a valid UUID, so a second run's target query (`type IN (...) AND mediaId is not a
UUID`) simply finds zero rows for it — no separate "already processed" marker is needed. Never
touches a `ContextItem` whose `mediaId` is already a valid UUID.

**How to run:**

```bash
# 1. dry run (default) — prints the plan, writes nothing
NODE_ENV=development pnpm --filter @arcaai/database exec \
  tsx scripts/backfill-context-item-media-id.ts

# 2. scope to one tenant while reviewing
... tsx scripts/backfill-context-item-media-id.ts --tenant 50000000-0000-0000-0000-000000000000

# 3. apply, after the dry-run output has been reviewed
... tsx scripts/backfill-context-item-media-id.ts --apply
```

**How many existing rows it would touch:** Queried the local dev DB directly (docker container
`hope-postgres`, database `hope`, per `.env.dev`'s `DATABASE_URL`):

```sql
SELECT
  COUNT(*) FILTER (WHERE "mediaId" IS NOT NULL) AS total_with_media_id,
  COUNT(*) FILTER (WHERE "mediaId" IS NOT NULL
    AND "mediaId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS raw_key_bug_rows
FROM core."ContextItem"
WHERE type IN ('ATTACHMENT','AUDIO_RECORDING');
-- total_with_media_id | raw_key_bug_rows
-- 0                   | 0
```

**Result: 0 rows.** There are 4 `ContextItem` rows of type `AUDIO_RECORDING` in the local dev DB,
but their `ContextItem.mediaId` column is NULL for all of them (by design — for AUDIO_RECORDING,
the actual media references live on the separate `AudioRecording` table, not on the container
`ContextItem` row itself; see §Current State Evaluation's out-of-scope note). Zero `ATTACHMENT`
rows exist in the local dev DB at all — nobody has exercised the lab-upload flow locally. The
backfill has nothing to do on this environment; it exists for whatever data staging/prod
accumulated before this fix ships there. It was NOT run against a live environment beyond this
dry-run/no-op query — only exercised via its own unit tests (in-memory fake client) and this
read-only count.

**Note (scope boundary):** the raw-key bug also affects the SEPARATE `AudioRecording` table's own
`mediaId`/`rawMediaId`/`processedMediaId` columns (confirmed: same 4 seed rows carry placeholder
values like `seed-media-placeholder-002`, not real UUIDs, though real-UUID rows also exist). This
backfill does NOT touch that table — it is explicitly scoped to `ContextItem` per the assignment.
No consumer currently resolves those columns via `MediaRepository` (confirmed empty), so unlike
the `ContextItem.mediaId` bug this doesn't yet manifest as a broken presigned URL; flagged
separately, not fixed here.

## Gates — actual output

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build /Users/.../packages/applications
> rimraf dist tsconfig.tsbuildinfo && tsc
(exit 0, no output — clean build)
```

### `pnpm --filter @arcaai/applications test`

```
 Test Files  453 passed | 1 skipped (454)
      Tests  8592 passed | 4 skipped (8596)
   Duration  153.49s
```

(1 skipped file / 4 skipped tests are pre-existing, unrelated to this ticket.)

### `pnpm --filter @arcaai/database test`

```
 Test Files  47 passed (47)
      Tests  1156 passed (1156)
   Duration  967ms
```

### `pnpm test:unit` (root)

See §Change History — captured after this section was drafted; full output pasted there once the
long-running root suite (workspace-wide vitest + `@arcaai/ui`/`@arcaai/vox`/
`@arcaai/compat-playground`/`@arcaai/admin-console` test) completed.

### `pnpm lint`

See §Change History, same reason.

### `apps/compat-playground` build (required — commit 3 touches `packages/agentic-sdk-v2`)

```
apps/compat-playground build: ✓ built in 41.51s
apps/compat-playground build: Done
```

### Targeted package builds also verified along the way

`pnpm --filter @arcaai/database build`, `pnpm --filter @arcaai/domains build`,
`pnpm --filter @arcaai/api... build` (11-package dependency chain incl. `apps/api`),
`pnpm --filter @arcaai/vox... build` (`packages/agentic-sdk-v2`) — all clean (exit 0).

### RED proof — OCR consumer bug (captured BEFORE the fix, `packages/applications`)

Ran the new/updated `ocr-enrichment.processor.test.ts` against the pre-fix
`ocr-enrichment.processor.ts` (temporarily reverted via `git stash` for this run only, then
restored):

```
 FAIL  ... > enriches an ATTACHMENT with no extractedText: resolve Media → fetch → OCR → persist → re-emit
AssertionError: expected "vi.fn()" to be called with arguments: [ 'media-uuid-1' ]
Number of calls: 0
  ❯ expect(mediaRepository.findById).toHaveBeenCalledWith(MEDIA_ID);

 FAIL  ... > resolves the bucket ENCODED IN the Media row uri, not a fixed default
AssertionError: expected "vi.fn()" to be called with arguments: [ { bucket: 'tenant-uploads', …(1) } ]
Received: [ { bucket: 'attachments', key: 'media-uuid-1' } ]   <- mediaId used AS the key (the bug)

 FAIL  ... > no-ops (never fetches bytes) when the Media row is not found
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: [ { bucket: 'attachments', key: 'media-uuid-1' } ]

 FAIL  ... > no-ops when the Media row uri is unparseable (not an s3:// uri)
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: [ { bucket: 'attachments', key: 'media-uuid-1' } ]

 FAIL  ... > degrades to a no-op when MediaRepository is not wired (optional dependency absent)
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: [ { bucket: 'attachments', key: 'media-uuid-1' } ]

 Test Files  1 failed (1)
      Tests  5 failed | 12 passed (17)
```

All 5 failures show `getObject` called with the `mediaId` UUID itself as the storage `key` —
exactly the reported bug. After the fix: `Test Files 2 passed (2) / Tests 23 passed (23)`
(17 OCR + 6 shared-util parity tests).

### TDD process note — a real bug caught mid-flight

Writing the backfill's idempotency/dedupe tests against an in-memory fake client caught a genuine
bug in the first draft of `resolveOrCreateMedia`: a cache-hit on a shared raw key returned the
ORIGINAL `'created'` action tag instead of `'reused'` (the code did `{ ...cached, uri }`, which
copies whatever action the FIRST caller got, instead of overriding it to `'reused'` for every
subsequent duplicate). Caught by `resolves the SAME Media row for two ContextItems sharing the
same raw key` before it ever reached a commit. Fixed in the same commit (`4d373183c`) that
introduced it — see that commit's message for detail.

## Change History

- 2026-08-11 — Initial implementation, three commits, README authored. Status: Review (root
  `pnpm test:unit` / `pnpm lint` results pending at time of commit; see below once captured —
  do NOT merge/push per the assignment's explicit instruction).
